/**
 * IMAP IDLE push notifications (B5).
 *
 * Opt-in (`APPLE_MAIL_MCP_IMAP_IDLE=1`). For each configured IMAP account this
 * opens a *dedicated* long-lived connection (separate from the request pool,
 * since IDLE holds the connection) on INBOX and watches for new arrivals.
 * ImapFlow keeps the mailbox in IDLE automatically and emits an `exists` event
 * when the message count grows; we forward that to a callback, which the server
 * turns into an MCP notification. Dropped connections reconnect with backoff.
 *
 * @module services/imapIdle
 */
import { ImapFlow } from "imapflow";
import { buildImapConnectionOptions, IMAP_ENV, type ImapConfig } from "@/services/imapClient.js";

/** Minimal event-capable client surface the watcher needs (testable). */
export interface IdleClient {
  connect(): Promise<void>;
  mailboxOpen(path: string): Promise<{ exists: number }>;
  on(event: "exists", handler: (data: { count: number; prevCount: number }) => void): void;
  on(event: "close" | "error", handler: (err?: unknown) => void): void;
  logout(): Promise<void>;
}

export type IdleConnect = (cfg: ImapConfig, signal: AbortSignal) => Promise<IdleClient>;

export interface NewMailEvent {
  account: string;
  count: number;
  prevCount: number;
}

const defaultIdleConnect: IdleConnect = async (cfg, signal) => {
  signal.throwIfAborted();
  const client = new ImapFlow(buildImapConnectionOptions(cfg));
  // ImapFlow is an EventEmitter: an 'error' with no listener (e.g. a socket
  // ETIMEOUT during connect, before watch() attaches its handler) is an
  // *uncaught* exception that crashes the whole MCP server. Attach a listener
  // before connect() so a connection error rejects the promise instead — the
  // caller (watch) catches that and schedules a reconnect.
  client.on("error", () => {});
  // A connection waiting for a greeting/authentication has not reached the
  // watcher's client map yet. Stop it explicitly when its lifecycle ends.
  let abortConnect!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abortConnect = () => {
      client.close();
      // close() can run before ImapFlow installs its connect rejection
      // handler. Settle our wait even when its connect promise stays pending.
      reject(signal.reason);
    };
    signal.addEventListener("abort", abortConnect, { once: true });
  });
  try {
    await Promise.race([client.connect(), aborted]);
    signal.throwIfAborted();
  } catch (error) {
    client.close();
    if (signal.aborted) throw error;
    if (!cfg.secure && !cfg.allowPlaintext) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `IMAP IDLE connection failed: ${detail}. STARTTLS is required for non-implicit TLS; ` +
          `to explicitly allow plaintext (not recommended), set ${IMAP_ENV.allowPlaintext}=1.`
      );
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abortConnect);
  }
  return client as unknown as IdleClient;
};

export class ImapIdleWatcher {
  private readonly connect: IdleConnect;
  private readonly mailbox: string;
  private readonly reconnectMs: number;
  private readonly pollMs: number;
  private readonly clients = new Map<string, IdleClient>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly polls = new Map<string, NodeJS.Timeout>();
  // Per-account baseline message count; growth past it = new mail.
  private readonly lastCount = new Map<string, number>();
  private lifecycle: AbortController | undefined;

  constructor(
    private readonly opts: {
      configs: ImapConfig[];
      onNewMail: (e: NewMailEvent) => void;
      connect?: IdleConnect;
      mailbox?: string;
      reconnectMs?: number;
      /** Poll interval (ms) as a fallback for servers that don't push IDLE EXISTS. 0 disables. */
      pollMs?: number;
    }
  ) {
    this.connect = opts.connect ?? defaultIdleConnect;
    this.mailbox = opts.mailbox ?? "INBOX";
    this.reconnectMs = opts.reconnectMs ?? 15_000;
    this.pollMs = opts.pollMs ?? 60_000;
  }

  /** Begin watching every configured account. Resolves once watches are kicked off. */
  async start(): Promise<void> {
    if (this.lifecycle) return;
    const lifecycle = new AbortController();
    this.lifecycle = lifecycle;
    await Promise.all(this.opts.configs.map((cfg) => this.watch(cfg, lifecycle.signal)));
  }

  private isCurrent(label: string, client: IdleClient, signal: AbortSignal): boolean {
    return !signal.aborted && this.clients.get(label) === client;
  }

  /**
   * Compare an observed message count to the account's baseline and fire
   * onNewMail on growth. Updates the baseline either way (so an expunge that
   * lowers the count re-bases without a spurious later fire).
   */
  private observe(label: string, count: number): void {
    if (typeof count !== "number") return;
    const prev = this.lastCount.get(label);
    if (prev !== undefined && count > prev) {
      this.opts.onNewMail({ account: label, count, prevCount: prev });
    }
    this.lastCount.set(label, count);
  }

  private async watch(cfg: ImapConfig, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const label = cfg.accountLabel;
    let client: IdleClient | undefined;
    try {
      client = await this.connect(cfg, signal);
      if (signal.aborted) {
        await client.logout().catch(() => undefined);
        return;
      }
      this.clients.set(label, client);
      const current = client;
      // Real-time path: ImapFlow emits `exists` while idling (where the server
      // pushes it). Ignore late events from a stopped or replaced connection.
      client.on("exists", (d) => {
        if (d && this.isCurrent(label, current, signal)) this.observe(label, d.count);
      });
      const reconnect = () => {
        if (this.isCurrent(label, current, signal)) this.scheduleReconnect(cfg, signal);
      };
      client.on("error", reconnect);
      client.on("close", reconnect);
      const mb = await client.mailboxOpen(this.mailbox); // keeps mailbox open / idling
      if (!this.isCurrent(label, client, signal)) return;
      this.lastCount.set(label, mb.exists); // baseline at start of watch
      this.startPoll(cfg, client, signal);
    } catch {
      if (!client || this.isCurrent(label, client, signal)) this.scheduleReconnect(cfg, signal);
    }
  }

  /** Polling fallback: re-check the count for servers that don't push EXISTS. */
  private startPoll(cfg: ImapConfig, client: IdleClient, signal: AbortSignal): void {
    if (this.pollMs <= 0) return;
    const label = cfg.accountLabel;
    const existing = this.polls.get(label);
    if (existing) clearInterval(existing);
    const p = setInterval(() => {
      if (!this.isCurrent(label, client, signal)) return;
      void client
        .mailboxOpen(this.mailbox)
        .then((mb) => {
          if (this.isCurrent(label, client, signal)) this.observe(label, mb.exists);
        })
        .catch(() => {
          if (this.isCurrent(label, client, signal)) this.scheduleReconnect(cfg, signal);
        });
    }, this.pollMs);
    p.unref?.();
    this.polls.set(label, p);
  }

  private scheduleReconnect(cfg: ImapConfig, signal: AbortSignal): void {
    if (signal.aborted) return;
    const label = cfg.accountLabel;
    if (this.timers.has(label)) return; // a reconnect is already pending
    const poll = this.polls.get(label);
    if (poll) {
      clearInterval(poll);
      this.polls.delete(label);
    }
    const old = this.clients.get(label);
    this.clients.delete(label);
    if (old) void old.logout().catch(() => undefined);
    const t = setTimeout(() => {
      this.timers.delete(label);
      void this.watch(cfg, signal);
    }, this.reconnectMs);
    t.unref?.();
    this.timers.set(label, t);
  }

  /** Stop all watches and close connections. */
  async stop(): Promise<void> {
    const lifecycle = this.lifecycle;
    this.lifecycle = undefined;
    lifecycle?.abort();
    for (const t of this.timers.values()) clearTimeout(t);
    for (const p of this.polls.values()) clearInterval(p);
    this.timers.clear();
    this.polls.clear();
    this.lastCount.clear();
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((c) => c.logout().catch(() => undefined)));
  }

  /** Accounts currently being watched (test/diagnostics). */
  watchedAccounts(): string[] {
    return [...this.clients.keys()];
  }
}
