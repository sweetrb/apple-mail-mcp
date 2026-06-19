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
import type { ImapConfig } from "@/services/imapClient.js";

/** Minimal event-capable client surface the watcher needs (testable). */
export interface IdleClient {
  connect(): Promise<void>;
  mailboxOpen(path: string): Promise<{ exists: number }>;
  on(event: "exists", handler: (data: { count: number; prevCount: number }) => void): void;
  on(event: "close" | "error", handler: (err?: unknown) => void): void;
  logout(): Promise<void>;
}

export type IdleConnect = (cfg: ImapConfig) => Promise<IdleClient>;

export interface NewMailEvent {
  account: string;
  count: number;
  prevCount: number;
}

const defaultIdleConnect: IdleConnect = async (cfg) => {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });
  await client.connect();
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
  private stopped = false;

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
    this.stopped = false;
    await Promise.all(this.opts.configs.map((cfg) => this.watch(cfg)));
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

  private async watch(cfg: ImapConfig): Promise<void> {
    if (this.stopped) return;
    const label = cfg.accountLabel;
    try {
      const client = await this.connect(cfg);
      this.clients.set(label, client);
      // Real-time path: ImapFlow emits `exists` while idling (where the server
      // pushes it). `count` is the new total.
      client.on("exists", (d) => {
        if (d) this.observe(label, d.count);
      });
      client.on("error", () => this.scheduleReconnect(cfg));
      client.on("close", () => this.scheduleReconnect(cfg));
      const mb = await client.mailboxOpen(this.mailbox); // keeps mailbox open / idling
      this.lastCount.set(label, mb.exists); // baseline at start of watch
      this.startPoll(cfg);
    } catch {
      this.scheduleReconnect(cfg);
    }
  }

  /** Polling fallback: re-check the count for servers that don't push EXISTS. */
  private startPoll(cfg: ImapConfig): void {
    if (this.pollMs <= 0) return;
    const label = cfg.accountLabel;
    const existing = this.polls.get(label);
    if (existing) clearInterval(existing);
    const p = setInterval(() => {
      const client = this.clients.get(label);
      if (!client) return;
      void client
        .mailboxOpen(this.mailbox)
        .then((mb) => this.observe(label, mb.exists))
        .catch(() => this.scheduleReconnect(cfg));
    }, this.pollMs);
    p.unref?.();
    this.polls.set(label, p);
  }

  private scheduleReconnect(cfg: ImapConfig): void {
    if (this.stopped) return;
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
      void this.watch(cfg);
    }, this.reconnectMs);
    t.unref?.();
    this.timers.set(label, t);
  }

  /** Stop all watches and close connections. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    for (const p of this.polls.values()) clearInterval(p);
    this.timers.clear();
    this.polls.clear();
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((c) => c.logout().catch(() => undefined)));
  }

  /** Accounts currently being watched (test/diagnostics). */
  watchedAccounts(): string[] {
    return [...this.clients.keys()];
  }
}
