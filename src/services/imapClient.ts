/**
 * IMAP backend (issue #43).
 *
 * AppleScript-over-Mail.app is the default. When an account is explicitly
 * configured for IMAP (env below), operations route here instead:
 *   - read:    search-messages / list-messages (server-side SEARCH, orders of
 *              magnitude faster and correct on large Gmail mailboxes where
 *              AppleScript times out with a false-empty) and get-message;
 *   - folders: create / rename / delete-mailbox (work on the server hierarchy
 *              that AppleScript can't touch — #42);
 *   - message: mark/flag/move/delete, keyed by the composite `imap:` id the
 *              read path emits (see encodeImapId/decodeImapId below).
 * Everything is opt-in and additive; un-configured accounts use AppleScript.
 *
 * Opt-in via env (mirrors the SMTP transport pattern):
 *   APPLE_MAIL_MCP_IMAP_USER      (required — enables IMAP; the login address)
 *   APPLE_MAIL_MCP_IMAP_ACCOUNT   (Mail account name to match for routing; default = USER)
 *   APPLE_MAIL_MCP_IMAP_HOST      (default imap.gmail.com)
 *   APPLE_MAIL_MCP_IMAP_PORT      (default 993, implicit TLS)
 *   APPLE_MAIL_MCP_IMAP_PASSWORD  (else Keychain via the two vars below)
 *   APPLE_MAIL_MCP_IMAP_KEYCHAIN_SERVICE / _KEYCHAIN_ACCOUNT
 *
 * @module services/imapClient
 */
import { ImapFlow } from "imapflow";
import { readKeychainPassword } from "@/services/smtpMailer.js";
import { extractHtmlBody, extractTextBody } from "@/utils/mimeParse.js";

export const IMAP_ENV = {
  user: "APPLE_MAIL_MCP_IMAP_USER",
  account: "APPLE_MAIL_MCP_IMAP_ACCOUNT",
  host: "APPLE_MAIL_MCP_IMAP_HOST",
  port: "APPLE_MAIL_MCP_IMAP_PORT",
  password: "APPLE_MAIL_MCP_IMAP_PASSWORD",
  keychainService: "APPLE_MAIL_MCP_IMAP_KEYCHAIN_SERVICE",
  keychainAccount: "APPLE_MAIL_MCP_IMAP_KEYCHAIN_ACCOUNT",
  // C2 multi-account: JSON array of additional accounts, e.g.
  // [{"account":"Work","user":"me@co.com","host":"imap.co.com","keychainService":"imap.co.com"}]
  accounts: "APPLE_MAIL_MCP_IMAP_ACCOUNTS",
} as const;

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  accountLabel: string;
}

export interface ImapSearchArgs {
  query?: string;
  account?: string;
  from?: string;
  subject?: string;
  mailbox?: string;
  limit?: number;
  dateFrom?: string;
  dateTo?: string;
  isRead?: boolean;
  isFlagged?: boolean;
  unreadOnly?: boolean;
  offset?: number;
}

interface ImapAddress {
  name?: string;
  address?: string;
}
interface ImapEnvelope {
  subject?: string;
  date?: Date | string;
  from?: ImapAddress[];
}
interface ImapMessage {
  uid: number;
  envelope?: ImapEnvelope;
  flags?: Set<string>;
  source?: Buffer | string;
}
interface MailboxLock {
  release: () => void;
}
interface ImapMailboxListing {
  path: string;
  name: string;
}
type FlagOpts = { uid: boolean };
export interface ImapClientLike {
  connect(): Promise<void>;
  getMailboxLock(path: string): Promise<MailboxLock>;
  search(query: Record<string, unknown>, opts: { uid: true }): Promise<number[] | false>;
  fetch(
    range: string,
    query: Record<string, unknown>,
    opts: { uid: true }
  ): AsyncIterable<ImapMessage>;
  fetchOne(
    range: string,
    query: Record<string, unknown>,
    opts: { uid: true }
  ): Promise<ImapMessage | false>;
  list(): Promise<ImapMailboxListing[]>;
  status(
    path: string,
    query: { messages?: boolean; unseen?: boolean; recent?: boolean }
  ): Promise<{ path: string; messages?: number; unseen?: number; recent?: number }>;
  mailboxCreate(path: string): Promise<{ path: string; created: boolean }>;
  mailboxRename(path: string, newPath: string): Promise<{ path: string; newPath: string }>;
  mailboxDelete(path: string): Promise<{ path: string }>;
  messageFlagsAdd(range: number[], flags: string[], opts: FlagOpts): Promise<boolean>;
  messageFlagsRemove(range: number[], flags: string[], opts: FlagOpts): Promise<boolean>;
  messageMove(range: number[], destination: string, opts: FlagOpts): Promise<unknown>;
  messageDelete(range: number[], opts: FlagOpts): Promise<boolean>;
  noop(): Promise<void>;
  logout(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Composite IMAP message id (Phase 3): a self-describing token the IMAP read
// path emits so the same id round-trips back to get-message and the message
// mutations. AppleScript message ids are bare numbers; an IMAP id is
// `imap:<base64url({a:account,p:mailboxPath,u:uid})>`. UIDs are per-mailbox, so
// the mailbox path must travel with the uid. base64url keeps it schema-safe.
// ---------------------------------------------------------------------------
export function encodeImapId(account: string, path: string, uid: number): string {
  const payload = Buffer.from(JSON.stringify({ a: account, p: path, u: uid }), "utf8").toString(
    "base64url"
  );
  return `imap:${payload}`;
}

export function decodeImapId(id: string): { account: string; path: string; uid: number } | null {
  if (!id || !id.startsWith("imap:")) return null;
  try {
    const obj = JSON.parse(Buffer.from(id.slice("imap:".length), "base64url").toString("utf8"));
    if (typeof obj.u !== "number" || typeof obj.p !== "string") return null;
    return { account: String(obj.a ?? ""), path: obj.p, uid: obj.u };
  } catch {
    return null;
  }
}

export type ImapConnect = (cfg: ImapConfig) => Promise<ImapClientLike>;

/**
 * Dependencies threaded through every IMAP op. `account` selects which
 * configured IMAP account to use (C2 multi-account); `config`/`connect` are
 * test seams. When `account` is omitted the default/first account is used.
 */
export interface ImapDeps {
  connect?: ImapConnect;
  config?: ImapConfig;
  account?: string;
}

/**
 * A configured IMAP account *without* its password resolved — cheap to
 * enumerate (no Keychain access), used for routing/listing (C2).
 */
interface ImapAccountSpec {
  accountLabel: string;
  user: string;
  host: string;
  port: number;
  password?: string;
  keychainService?: string;
  keychainAccount?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Enumerate all configured IMAP accounts (C2): the legacy single-account env
 * vars plus any in the `APPLE_MAIL_MCP_IMAP_ACCOUNTS` JSON array. Does not
 * resolve passwords. The legacy account takes precedence on label collisions.
 */
function listImapAccountSpecs(env: NodeJS.ProcessEnv = process.env): ImapAccountSpec[] {
  const specs: ImapAccountSpec[] = [];
  const user = env[IMAP_ENV.user]?.trim();
  if (user) {
    specs.push({
      accountLabel: env[IMAP_ENV.account]?.trim() || user,
      user,
      host: env[IMAP_ENV.host]?.trim() || "imap.gmail.com",
      port: env[IMAP_ENV.port] ? Number.parseInt(env[IMAP_ENV.port] as string, 10) : 993,
      password: env[IMAP_ENV.password],
      keychainService: env[IMAP_ENV.keychainService]?.trim(),
      keychainAccount: env[IMAP_ENV.keychainAccount]?.trim(),
    });
  }
  const json = env[IMAP_ENV.accounts]?.trim();
  if (json) {
    try {
      const arr: unknown = JSON.parse(json);
      if (Array.isArray(arr)) {
        for (const raw of arr) {
          const a = raw as Record<string, unknown>;
          const u = str(a.user);
          if (!u) continue;
          const label = str(a.account) || str(a.accountLabel) || u;
          if (specs.some((s) => s.accountLabel === label)) continue; // legacy wins
          const port = a.port ? Number(a.port) : 993;
          specs.push({
            accountLabel: label,
            user: u,
            host: str(a.host) || "imap.gmail.com",
            port,
            password: str(a.password),
            keychainService: str(a.keychainService),
            keychainAccount: str(a.keychainAccount),
          });
        }
      }
    } catch (e) {
      console.error(`Invalid ${IMAP_ENV.accounts} JSON, ignoring: ${String(e)}`);
    }
  }
  return specs;
}

function specToConfig(spec: ImapAccountSpec): ImapConfig {
  if (!Number.isInteger(spec.port) || spec.port <= 0) {
    throw new Error(`Invalid IMAP port for account "${spec.accountLabel}": "${spec.port}".`);
  }
  let pass = spec.password;
  if (!pass && spec.keychainService) {
    pass =
      readKeychainPassword(spec.keychainService, spec.keychainAccount || spec.user) ?? undefined;
  }
  if (!pass) {
    throw new Error(
      `No IMAP password for account "${spec.accountLabel}". Set a password or a Keychain service/account.`
    );
  }
  return {
    host: spec.host,
    port: spec.port,
    secure: spec.port === 993,
    user: spec.user,
    pass,
    accountLabel: spec.accountLabel,
  };
}

/** True when `account` matches any configured IMAP account (label or user). */
export function isImapAccount(
  account: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!account) return false;
  return listImapAccountSpecs(env).some((s) => s.accountLabel === account || s.user === account);
}

/** Account labels of every configured IMAP account (C2), for diagnostics. */
export function listImapAccountLabels(env: NodeJS.ProcessEnv = process.env): string[] {
  return listImapAccountSpecs(env).map((s) => s.accountLabel);
}

/**
 * Resolve full configs (passwords included) for every configured IMAP account
 * (C2/B5). Accounts whose password can't be resolved are skipped (logged), so a
 * single misconfigured account doesn't take down the rest (e.g. IDLE watchers).
 */
export function resolveImapConfigs(env: NodeJS.ProcessEnv = process.env): ImapConfig[] {
  const out: ImapConfig[] = [];
  for (const spec of listImapAccountSpecs(env)) {
    try {
      out.push(specToConfig(spec));
    } catch (e) {
      console.error(`Skipping IMAP account "${spec.accountLabel}": ${String(e)}`);
    }
  }
  return out;
}

/**
 * Resolve the full IMAP config (password included) for `account`. With no
 * `account`, returns the default/first configured account. Throws if IMAP is
 * unconfigured or no account matches.
 */
export function resolveImapConfig(
  env: NodeJS.ProcessEnv = process.env,
  account?: string
): ImapConfig {
  const specs = listImapAccountSpecs(env);
  if (specs.length === 0) {
    throw new Error(`IMAP not configured. Set ${IMAP_ENV.user} (login address) to enable it.`);
  }
  let spec: ImapAccountSpec | undefined;
  if (account) {
    spec = specs.find((s) => s.accountLabel === account || s.user === account);
    if (!spec) {
      throw new Error(
        `No IMAP account matching "${account}". Configured: ${specs.map((s) => s.accountLabel).join(", ")}.`
      );
    }
  } else {
    spec = specs[0];
  }
  return specToConfig(spec);
}

const defaultConnect: ImapConnect = async (cfg) => {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });
  await client.connect();
  return client as unknown as ImapClientLike;
};

/** Map common (Gmail) mailbox names to their IMAP paths. */
export function resolveMailboxPath(mailbox: string | undefined, mode: "search" | "list"): string {
  if (!mailbox) return mode === "search" ? "[Gmail]/All Mail" : "INBOX";
  const map: Record<string, string> = {
    "all mail": "[Gmail]/All Mail",
    "sent mail": "[Gmail]/Sent Mail",
    sent: "[Gmail]/Sent Mail",
    trash: "[Gmail]/Trash",
    drafts: "[Gmail]/Drafts",
    spam: "[Gmail]/Spam",
    junk: "[Gmail]/Spam",
    starred: "[Gmail]/Starred",
    important: "[Gmail]/Important",
  };
  return map[mailbox.trim().toLowerCase()] ?? mailbox;
}

function buildCriteria(a: ImapSearchArgs, listMode: boolean): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  if (a.query) c.or = [{ subject: a.query }, { from: a.query }];
  if (a.from) c.from = a.from;
  if (a.subject) c.subject = a.subject;
  if (a.isRead === true) c.seen = true;
  if (a.isRead === false) c.unseen = true;
  if (a.unreadOnly && listMode) c.unseen = true;
  if (a.isFlagged === true) c.flagged = true;
  if (a.isFlagged === false) c.unflagged = true;
  if (a.dateFrom) c.since = new Date(a.dateFrom);
  if (a.dateTo) c.before = new Date(a.dateTo);
  if (Object.keys(c).length === 0) c.all = true;
  return c;
}

function formatRow(m: ImapMessage, account: string, path: string): string {
  const env = m.envelope ?? {};
  const subject = env.subject || "(no subject)";
  const a = env.from?.[0];
  const from = a
    ? a.name
      ? `${a.name} <${a.address ?? ""}>`
      : (a.address ?? "(unknown)")
    : "(unknown)";
  const date = env.date ? new Date(env.date).toLocaleDateString() : "";
  const read = m.flags?.has("\\Seen") ? "read" : "unread";
  // Emit the self-describing IMAP id so get-message and the message mutations
  // can route this row back to IMAP (Phase 3).
  return `  - ID: ${encodeImapId(account, path, m.uid)} | ${date} | ${subject} (from: ${from}) [${read}]`;
}

async function run(args: ImapSearchArgs, listMode: boolean, deps: ImapDeps): Promise<string> {
  // Reads are idempotent → safe to retry once if a pooled connection is dead.
  // Route to the account named in the search args (C2 multi-account).
  return useClient(
    { ...deps, account: deps.account ?? args.account },
    async (client, cfg) => {
      const path = resolveMailboxPath(args.mailbox, listMode ? "list" : "search");
      const lock = await client.getMailboxLock(path);
      try {
        const found = await client.search(buildCriteria(args, listMode), { uid: true });
        const uids = Array.isArray(found) ? found : [];
        if (uids.length === 0) {
          return `No messages found via IMAP in "${path}" (account ${cfg.accountLabel}).`;
        }
        const limit = args.limit ?? 50;
        const offset = args.offset ?? 0;
        // UIDs are ascending → newest are the highest. Apply offset+limit from the newest end.
        const newest = uids
          .slice()
          .reverse()
          .slice(offset, offset + limit);
        const byUid = new Map<number, string>();
        for await (const msg of client.fetch(
          newest.join(","),
          { envelope: true, flags: true },
          { uid: true }
        )) {
          byUid.set(msg.uid, formatRow(msg, cfg.accountLabel, path));
        }
        const rows = newest.map((u) => byUid.get(u)).filter((r): r is string => Boolean(r));
        const verb = listMode ? "listed" : "matched";
        return (
          `Found ${rows.length} message(s) via IMAP (server-side, account ${cfg.accountLabel}, mailbox "${path}"; ${uids.length} total ${verb}):\n` +
          rows.join("\n") +
          `\n\nNote: these IMAP IDs (imap:…) work with get-message and the message mutations (mark/flag/move/delete-message), which route back to IMAP.`
        );
      } finally {
        lock.release();
      }
    },
    true
  );
}

export function imapSearchMessages(args: ImapSearchArgs, deps: ImapDeps = {}): Promise<string> {
  return run(args, false, deps);
}

export function imapListMessages(args: ImapSearchArgs, deps: ImapDeps = {}): Promise<string> {
  return run(args, true, deps);
}

// ===========================================================================
// Counts & stats via IMAP STATUS (2.1 optimizations I3/I4/I6)
//
// STATUS is a single server round-trip that returns authoritative message/unseen
// counts without enumerating messages — far faster and more reliable than
// AppleScript on large mailboxes (where the per-message walk times out, #8/#24).
// ===========================================================================

/** Unread count via IMAP STATUS (UNSEEN). No mailbox → sum across all mailboxes. */
export function imapUnreadCount(mailbox: string | undefined, deps: ImapDeps = {}): Promise<number> {
  return useClient(
    deps,
    async (client) => {
      if (mailbox) {
        const s = await client.status(resolveMailboxPath(mailbox, "list"), { unseen: true });
        return s.unseen ?? 0;
      }
      let total = 0;
      for (const b of await client.list()) {
        try {
          const s = await client.status(b.path, { unseen: true });
          total += s.unseen ?? 0;
        } catch {
          // skip mailboxes that can't be STATUS'd (e.g. \Noselect parents)
        }
      }
      return total;
    },
    true
  );
}

export interface ImapMailboxInfo {
  path: string;
  name: string;
  messages: number;
  unseen: number;
}

/** List mailboxes with per-mailbox message/unseen counts via LIST + STATUS (I6). */
export function imapListMailboxes(deps: ImapDeps = {}): Promise<ImapMailboxInfo[]> {
  return useClient(
    deps,
    async (client) => {
      const out: ImapMailboxInfo[] = [];
      for (const b of await client.list()) {
        let messages = 0;
        let unseen = 0;
        try {
          const s = await client.status(b.path, { messages: true, unseen: true });
          messages = s.messages ?? 0;
          unseen = s.unseen ?? 0;
        } catch {
          // \Noselect or otherwise un-status-able mailbox → report zeros
        }
        out.push({ path: b.path, name: b.name, messages, unseen });
      }
      return out;
    },
    true
  );
}

export interface ImapStats {
  totalMessages: number;
  totalUnread: number;
  perMailbox: { mailbox: string; messages: number; unseen: number }[];
  recent: { last24h: number; last7d: number; last30d: number };
}

/** Aggregate stats via STATUS (counts) + INBOX SEARCH SINCE (recent) (I3). */
export function imapMailStats(deps: ImapDeps = {}): Promise<ImapStats> {
  return useClient(
    deps,
    async (client) => {
      const perMailbox: ImapStats["perMailbox"] = [];
      let totalMessages = 0;
      let totalUnread = 0;
      for (const b of await client.list()) {
        try {
          const s = await client.status(b.path, { messages: true, unseen: true });
          const messages = s.messages ?? 0;
          const unseen = s.unseen ?? 0;
          totalMessages += messages;
          totalUnread += unseen;
          perMailbox.push({ mailbox: b.path, messages, unseen });
        } catch {
          // skip un-status-able mailbox
        }
      }
      // Recent counts against INBOX (the meaningful "received" surface).
      const since = (days: number): Date => new Date(Date.now() - days * 86_400_000);
      const countSince = async (days: number): Promise<number> => {
        try {
          const lock = await client.getMailboxLock("INBOX");
          try {
            const found = await client.search({ since: since(days) }, { uid: true });
            return Array.isArray(found) ? found.length : 0;
          } finally {
            lock.release();
          }
        } catch {
          return 0;
        }
      };
      const [last24h, last7d, last30d] = await Promise.all([
        countSince(1),
        countSince(7),
        countSince(30),
      ]);
      return { totalMessages, totalUnread, perMailbox, recent: { last24h, last7d, last30d } };
    },
    true
  );
}

// ===========================================================================
// Phase 2 — mailbox/folder operations (issue #43)
//
// IMAP's CREATE / RENAME / DELETE work on the real server-side folder
// hierarchy, so they succeed on exactly the server-side mailboxes (iCloud /
// Gmail / Workspace / Exchange) where Mail.app's AppleScript bridge throws
// "AppleEvent handler failed" (#42). Routed only when the account is IMAP-
// configured; AppleScript remains the path for everything else.
// ===========================================================================

export interface ImapOpResult {
  success: boolean;
  error?: string;
  info?: string;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Connection pool (issue #50 / A3)
//
// The MCP server is long-lived and every tool call is serialized through the
// AppleScript gate, so instead of connecting + logging out (~seconds) on every
// IMAP call, one connection is kept alive and reused. A NOOP verifies liveness
// before reuse; an idle timer closes it after inactivity. An injected
// `deps.connect` (tests) bypasses the pool and connects per call.
// ---------------------------------------------------------------------------
let poolConnect: ImapConnect = defaultConnect;
interface PoolEntry {
  client: ImapClientLike;
  idle?: NodeJS.Timeout;
}
// One kept-alive connection per account (C2): keyed by host:port:user so each
// configured IMAP account keeps its own pooled connection instead of thrashing
// a single slot when calls alternate between accounts.
const pools = new Map<string, PoolEntry>();

function poolKey(cfg: ImapConfig): string {
  return `${cfg.host}:${cfg.port}:${cfg.user}`;
}

function imapIdleMs(): number {
  const raw = process.env.APPLE_MAIL_MCP_IMAP_IDLE_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 60_000;
}

async function dropPool(key: string): Promise<void> {
  const e = pools.get(key);
  if (!e) return;
  if (e.idle) clearTimeout(e.idle);
  pools.delete(key);
  await e.client.logout().catch(() => undefined);
}

async function dropAllPools(): Promise<void> {
  await Promise.all([...pools.keys()].map((k) => dropPool(k)));
}

function scheduleIdleClose(key: string): void {
  const e = pools.get(key);
  if (!e) return;
  if (e.idle) clearTimeout(e.idle);
  const ms = imapIdleMs();
  if (ms <= 0) return;
  e.idle = setTimeout(() => void dropPool(key), ms);
  e.idle.unref?.();
}

async function acquirePooled(cfg: ImapConfig): Promise<ImapClientLike> {
  const key = poolKey(cfg);
  const existing = pools.get(key);
  if (existing) {
    if (existing.idle) clearTimeout(existing.idle);
    try {
      await existing.client.noop(); // verify the kept-alive connection is still usable
      return existing.client;
    } catch {
      await dropPool(key);
    }
  }
  const client = await poolConnect(cfg);
  pools.set(key, { client });
  return client;
}

/**
 * Health probe for the setup doctor (C3): reports whether IMAP is configured and,
 * if so, whether a connection + NOOP succeeds (auth/network/Keychain all good).
 */
export async function imapHealthCheck(
  deps: ImapDeps = {}
): Promise<{ configured: boolean; ok: boolean; account?: string; host?: string; error?: string }> {
  if (!deps.config && !process.env[IMAP_ENV.user]?.trim()) {
    return { configured: false, ok: false };
  }
  let cfg: ImapConfig;
  try {
    cfg = deps.config ?? resolveImapConfig(process.env, deps.account);
  } catch (e) {
    return { configured: true, ok: false, error: errText(e) };
  }
  try {
    await useClient(deps, async (client) => {
      await client.noop();
    });
    return { configured: true, ok: true, account: cfg.accountLabel, host: cfg.host };
  } catch (e) {
    return {
      configured: true,
      ok: false,
      account: cfg.accountLabel,
      host: cfg.host,
      error: errText(e),
    };
  }
}

/** Test seam: override the pool's connect factory; pass null to restore. */
export function __setPoolConnect(fn: ImapConnect | null): void {
  poolConnect = fn ?? defaultConnect;
}
/** Test seam: close and clear all pooled connections. */
export async function __resetPool(): Promise<void> {
  await dropAllPools();
}

/**
 * Run `fn` with an IMAP client. Default (production) path reuses the pooled,
 * kept-alive connection; an injected `deps.connect` connects fresh and logs out
 * per call. `retryOnDrop` reconnects once if a pooled connection dies mid-op —
 * only safe for idempotent reads, so mutations leave it false.
 */
async function useClient<T>(
  deps: ImapDeps,
  fn: (client: ImapClientLike, cfg: ImapConfig) => Promise<T>,
  retryOnDrop = false
): Promise<T> {
  const cfg = deps.config ?? resolveImapConfig(process.env, deps.account);
  if (deps.connect) {
    const client = await deps.connect(cfg);
    try {
      return await fn(client, cfg);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }
  const key = poolKey(cfg);
  try {
    const client = await acquirePooled(cfg);
    const r = await fn(client, cfg);
    scheduleIdleClose(key);
    return r;
  } catch (e) {
    await dropPool(key);
    if (retryOnDrop) {
      const client = await acquirePooled(cfg);
      try {
        const r = await fn(client, cfg);
        scheduleIdleClose(key);
        return r;
      } catch (e2) {
        await dropPool(key);
        throw e2;
      }
    }
    throw e;
  }
}

/** Connect, run `fn`, manage the connection (pooled in production). */
function withClient<T>(
  deps: ImapDeps,
  fn: (client: ImapClientLike, cfg: ImapConfig) => Promise<T>
): Promise<T> {
  return useClient(deps, fn);
}

/**
 * Resolve a user-supplied mailbox name to an actual server path by listing the
 * mailboxes and matching on full path, then leaf name (case-insensitive).
 * Returns null when no such mailbox exists.
 */
async function findMailboxPath(client: ImapClientLike, name: string): Promise<string | null> {
  const wanted = name.trim().toLowerCase();
  const boxes = await client.list();
  const byPath = boxes.find((b) => b.path.toLowerCase() === wanted);
  if (byPath) return byPath.path;
  const byName = boxes.find((b) => b.name.toLowerCase() === wanted);
  return byName ? byName.path : null;
}

export function imapCreateMailbox(name: string, deps: ImapDeps = {}): Promise<ImapOpResult> {
  return withClient(deps, async (client) => {
    try {
      const res = await client.mailboxCreate(name);
      return res.created
        ? { success: true, info: `Created mailbox "${res.path}".` }
        : { success: true, info: `Mailbox "${res.path}" already existed.` };
    } catch (e) {
      return { success: false, error: `IMAP create failed for "${name}": ${errText(e)}` };
    }
  });
}

export function imapDeleteMailbox(name: string, deps: ImapDeps = {}): Promise<ImapOpResult> {
  return withClient(deps, async (client, cfg) => {
    const path = await findMailboxPath(client, name);
    if (!path) {
      return {
        success: false,
        error: `Mailbox "${name}" not found on IMAP account ${cfg.accountLabel}.`,
      };
    }
    try {
      await client.mailboxDelete(path);
      return {
        success: true,
        info: `Deleted mailbox "${path}" via IMAP (account ${cfg.accountLabel}).`,
      };
    } catch (e) {
      return { success: false, error: `IMAP delete failed for "${path}": ${errText(e)}` };
    }
  });
}

export function imapRenameMailbox(
  oldName: string,
  newName: string,
  deps: ImapDeps = {}
): Promise<ImapOpResult> {
  return withClient(deps, async (client, cfg) => {
    const path = await findMailboxPath(client, oldName);
    if (!path) {
      return {
        success: false,
        error: `Mailbox "${oldName}" not found on IMAP account ${cfg.accountLabel}.`,
      };
    }
    try {
      const res = await client.mailboxRename(path, newName);
      return { success: true, info: `Renamed "${res.path}" to "${res.newPath}" via IMAP.` };
    } catch (e) {
      return {
        success: false,
        error: `IMAP rename failed for "${path}" -> "${newName}": ${errText(e)}`,
      };
    }
  });
}

// ===========================================================================
// Phase 3 — message-level operations by composite IMAP id (issue #43)
//
// get-message / mark / flag / move / delete-message route here when the message
// id is an `imap:` token (emitted by the IMAP read path). The token carries the
// mailbox path + UID, so the op opens that mailbox and acts on the UID.
// ===========================================================================

/** Connect, open the message's mailbox, run `fn`, release + log out. */
async function withMailbox<T>(
  path: string,
  deps: ImapDeps,
  fn: (client: ImapClientLike) => Promise<T>
): Promise<T> {
  return withClient(deps, async (client) => {
    const lock = await client.getMailboxLock(path);
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  });
}

/** Read a message by composite IMAP id; returns "Subject: …\n\n<body>". */
export async function imapGetMessage(
  id: string,
  preferHtml: boolean,
  deps: ImapDeps = {}
): Promise<ImapOpResult> {
  const ref = decodeImapId(id);
  if (!ref) return { success: false, error: `Not an IMAP message id: "${id}".` };
  return withMailbox(
    ref.path,
    { ...deps, account: deps.account ?? ref.account },
    async (client) => {
      const msg = await client.fetchOne(
        String(ref.uid),
        { envelope: true, source: true },
        { uid: true }
      );
      if (!msg)
        return { success: false, error: `IMAP message UID ${ref.uid} not found in "${ref.path}".` };
      const subject = msg.envelope?.subject || "(no subject)";
      const src = msg.source ? msg.source.toString() : "";
      const body =
        (preferHtml ? extractHtmlBody(src) : extractTextBody(src)) ??
        extractTextBody(src) ??
        extractHtmlBody(src) ??
        "(no readable body)";
      return { success: true, info: `Subject: ${subject}\n\n${body}` };
    }
  );
}

function flagOp(id: string, flag: string, add: boolean, deps: ImapDeps): Promise<ImapOpResult> {
  const ref = decodeImapId(id);
  if (!ref) return Promise.resolve({ success: false, error: `Not an IMAP message id: "${id}".` });
  return withMailbox(
    ref.path,
    { ...deps, account: deps.account ?? ref.account },
    async (client) => {
      try {
        const ok = add
          ? await client.messageFlagsAdd([ref.uid], [flag], { uid: true })
          : await client.messageFlagsRemove([ref.uid], [flag], { uid: true });
        if (!ok)
          return { success: false, error: `IMAP flag update returned false for UID ${ref.uid}.` };
        return { success: true };
      } catch (e) {
        return {
          success: false,
          error: `IMAP flag update failed for UID ${ref.uid}: ${errText(e)}`,
        };
      }
    }
  );
}

export const imapMarkRead = (id: string, deps = {}): Promise<ImapOpResult> =>
  flagOp(id, "\\Seen", true, deps);
export const imapMarkUnread = (id: string, deps = {}): Promise<ImapOpResult> =>
  flagOp(id, "\\Seen", false, deps);
export const imapFlagMessage = (id: string, deps = {}): Promise<ImapOpResult> =>
  flagOp(id, "\\Flagged", true, deps);
export const imapUnflagMessage = (id: string, deps = {}): Promise<ImapOpResult> =>
  flagOp(id, "\\Flagged", false, deps);

export async function imapMoveMessageById(
  id: string,
  destMailbox: string,
  deps: ImapDeps = {}
): Promise<ImapOpResult> {
  const ref = decodeImapId(id);
  if (!ref) return { success: false, error: `Not an IMAP message id: "${id}".` };
  return withClient({ ...deps, account: deps.account ?? ref.account }, async (client) => {
    const destPath =
      (await findMailboxPath(client, destMailbox)) ?? resolveMailboxPath(destMailbox, "list");
    const lock = await client.getMailboxLock(ref.path);
    try {
      await client.messageMove([ref.uid], destPath, { uid: true });
      return { success: true, info: `Moved UID ${ref.uid} to "${destPath}" via IMAP.` };
    } catch (e) {
      return {
        success: false,
        error: `IMAP move failed for UID ${ref.uid} -> "${destPath}": ${errText(e)}`,
      };
    } finally {
      lock.release();
    }
  });
}

export async function imapDeleteMessageById(
  id: string,
  deps: ImapDeps = {}
): Promise<ImapOpResult> {
  const ref = decodeImapId(id);
  if (!ref) return { success: false, error: `Not an IMAP message id: "${id}".` };
  return withMailbox(
    ref.path,
    { ...deps, account: deps.account ?? ref.account },
    async (client) => {
      try {
        const ok = await client.messageDelete([ref.uid], { uid: true });
        if (!ok) return { success: false, error: `IMAP delete returned false for UID ${ref.uid}.` };
        return { success: true, info: `Deleted UID ${ref.uid} from "${ref.path}" via IMAP.` };
      } catch (e) {
        return { success: false, error: `IMAP delete failed for UID ${ref.uid}: ${errText(e)}` };
      }
    }
  );
}
