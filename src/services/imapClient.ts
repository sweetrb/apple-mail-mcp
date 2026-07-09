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
  messageId?: string;
  inReplyTo?: string;
}
export interface ImapBodyStructure {
  part?: string; // IMAP section id, e.g. "2" or "1.2"
  type?: string; // MIME type, e.g. "image/png" or "multipart/mixed"
  disposition?: string; // "attachment" | "inline"
  dispositionParameters?: Record<string, string>;
  parameters?: Record<string, string>;
  size?: number;
  encoding?: string;
  childNodes?: ImapBodyStructure[];
}
interface ImapMessage {
  uid: number;
  envelope?: ImapEnvelope;
  flags?: Set<string>;
  source?: Buffer | string;
  bodyStructure?: ImapBodyStructure;
  headers?: Buffer | string;
}
interface ImapDownload {
  meta?: { filename?: string; contentType?: string };
  content: AsyncIterable<Uint8Array>;
}
interface MailboxLock {
  release: () => void;
}
interface ImapMailboxListing {
  path: string;
  name: string;
  /** RFC 6154 special-use flag ("\\Trash", "\\Sent", …) when the server advertises it. */
  specialUse?: string;
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
  download(range: string, part: string, opts: { uid: true }): Promise<ImapDownload>;
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

/**
 * Read-side routing gate (v2.6.0 — prefer-IMAP reads). Returns true when a read
 * tool should go to IMAP rather than AppleScript:
 *   - IMAP is configured at all, AND
 *   - either the caller named no account (→ merge across all accounts), or the
 *     named account is itself a configured IMAP account.
 * An explicitly-named NON-IMAP account returns false → AppleScript. When IMAP is
 * not configured at all this is always false, so behavior is unchanged.
 *
 * NOTE: the 3 mailbox-WRITE ops (create/delete/rename-mailbox) deliberately keep
 * using `isImapAccount` — they only route to IMAP for an explicitly-named IMAP
 * account, never on an omitted account.
 */
export function shouldUseImap(
  account: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (
    listImapAccountSpecs(env).length > 0 && (account === undefined || isImapAccount(account, env))
  );
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
  // ImapFlow is an EventEmitter: once connect() resolves, a later socket error
  // on this pooled, long-lived client (idle Gmail/iCloud timeout, server BYE,
  // network drop) emits 'error'. With no listener that is an *uncaught*
  // exception that crashes the whole MCP server. Attach one before connect so
  // the error is swallowed; the pool's liveness probe reconnects on next use.
  // Same defect class as defaultIdleConnect in imapIdle.ts.
  client.on("error", () => {});
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

/**
 * JSON-friendly summary of an IMAP message for `structuredContent`, mirroring the
 * AppleScript path's `messageSummary` shape so the search/list/thread tools emit
 * the same structured payload regardless of backend (A1).
 */
function structuredRow(m: ImapMessage, account: string, path: string): Record<string, unknown> {
  const env = m.envelope ?? {};
  return {
    id: encodeImapId(account, path, m.uid),
    subject: env.subject || "(no subject)",
    sender: senderName(env.from),
    dateReceived: env.date ? new Date(env.date).toISOString() : "",
    isRead: m.flags?.has("\\Seen") ?? false,
    isFlagged: m.flags?.has("\\Flagged") ?? false,
    mailbox: path,
    account,
    hasAttachments: false,
    // Message-ID (when the envelope carries it) is the strongest cross-/intra-
    // backend dedup key for the multi-account merge (imapMultiAccount.ts). The
    // AppleScript path does not expose it, so cross-backend dedup falls back to
    // the subject|sender|date composite key.
    ...(env.messageId ? { messageId: env.messageId } : {}),
  };
}

/**
 * Result of an IMAP search/list: the human text identical to before, plus the
 * structured payload (messages + count) so callers can pass it straight to
 * `successResponse(text, structured)` and emit `structuredContent` on the IMAP
 * path the same way the AppleScript path does.
 */
export interface ImapListResult {
  text: string;
  messages: Record<string, unknown>[];
  count: number;
  partial: boolean;
}

async function run(
  args: ImapSearchArgs,
  listMode: boolean,
  deps: ImapDeps
): Promise<ImapListResult> {
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
          return {
            text: `No messages found via IMAP in "${path}" (account ${cfg.accountLabel}).`,
            messages: [],
            count: 0,
            partial: false,
          };
        }
        const limit = args.limit ?? 50;
        const offset = args.offset ?? 0;
        // UIDs are ascending → newest are the highest. Apply offset+limit from the newest end.
        const newest = uids
          .slice()
          .reverse()
          .slice(offset, offset + limit);
        const byUid = new Map<number, ImapMessage>();
        for await (const msg of client.fetch(
          newest.join(","),
          { envelope: true, flags: true },
          { uid: true }
        )) {
          byUid.set(msg.uid, msg);
        }
        const ordered = newest
          .map((u) => byUid.get(u))
          .filter((m): m is ImapMessage => m !== undefined);
        const rows = ordered.map((m) => formatRow(m, cfg.accountLabel, path));
        const messages = ordered.map((m) => structuredRow(m, cfg.accountLabel, path));
        const verb = listMode ? "listed" : "matched";
        const text =
          `Found ${rows.length} message(s) via IMAP (server-side, account ${cfg.accountLabel}, mailbox "${path}"; ${uids.length} total ${verb}):\n` +
          rows.join("\n") +
          `\n\nNote: these IMAP IDs (imap:…) work with get-message and the message mutations (mark/flag/move/delete-message), which route back to IMAP.`;
        return { text, messages, count: messages.length, partial: false };
      } finally {
        lock.release();
      }
    },
    true
  );
}

export function imapSearchMessages(
  args: ImapSearchArgs,
  deps: ImapDeps = {}
): Promise<ImapListResult> {
  return run(args, false, deps);
}

export function imapListMessages(
  args: ImapSearchArgs,
  deps: ImapDeps = {}
): Promise<ImapListResult> {
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
  // Default 30s (v2.6.1): close the pooled connection sooner so this instance
  // gives its IMAP slot back quickly — important when several instances coexist
  // against Gmail's ~15-per-account cap and Apple Mail also needs slots. Tune
  // with APPLE_MAIL_MCP_IMAP_IDLE_MS (0 = never close).
  return 30_000;
}

async function dropPool(key: string): Promise<void> {
  const e = pools.get(key);
  if (!e) return;
  if (e.idle) clearTimeout(e.idle);
  pools.delete(key);
  await e.client.logout().catch(() => undefined);
}

/**
 * Close and log out every pooled IMAP connection. Exported so the server can
 * call it on shutdown (SIGINT/SIGTERM/stdin-EOF) — otherwise a killed or
 * orphaned instance leaves its pooled sockets occupying slots against the
 * server's per-account connection limit until they're reaped by a TCP timeout.
 */
export async function dropAllPools(): Promise<void> {
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

// Single-flight connect guard: concurrent acquisitions of the same account
// await ONE in-flight connect instead of each opening (and orphaning) its own
// socket — the race that can leak connections past the per-account limit.
const connecting = new Map<string, Promise<ImapClientLike>>();

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
  const inFlight = connecting.get(key);
  if (inFlight) return inFlight;
  const p = (async () => {
    const client = await poolConnect(cfg);
    pools.set(key, { client });
    return client;
  })();
  connecting.set(key, p);
  try {
    return await p;
  } finally {
    connecting.delete(key);
  }
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

/** Normalize an RFC822 Message-ID for backend-independent matching: trim and
 *  drop any surrounding angle brackets (IMAP envelopes carry `<id>`, Mail.app's
 *  AppleScript `message id` property returns it bracketless). */
export function normalizeMessageId(mid: string): string {
  return mid.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
}

/**
 * Fetch the RFC822 Message-ID for an `imap:` id. This is the join key that lets
 * the AppleScript backend locate the *same* message and return its numeric
 * Mail.app id — needed because flag **colors** only apply on the AppleScript
 * numeric-id path (IMAP `\Flagged` is colorless). Returns the normalized
 * Message-ID (no angle brackets), or null if `id` isn't an imap: token, the
 * message/envelope can't be fetched, or it carries no Message-ID.
 */
export async function imapFetchMessageId(id: string, deps: ImapDeps = {}): Promise<string | null> {
  const ref = decodeImapId(id);
  if (!ref) return null;
  try {
    return await withMailbox(
      ref.path,
      { ...deps, account: deps.account ?? ref.account },
      async (client) => {
        const msg = await client.fetchOne(String(ref.uid), { envelope: true }, { uid: true });
        const mid = msg && msg.envelope?.messageId;
        return mid ? normalizeMessageId(mid) : null;
      }
    );
  } catch {
    return null;
  }
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

/**
 * Resolve the account's Trash mailbox path: prefer the server's `\Trash`
 * special-use folder, then a common name/path, then the Gmail default.
 *
 * Deleting moves messages here (recoverable) rather than flagging `\Deleted` +
 * EXPUNGE, because on Gmail expunging a message from `[Gmail]/All Mail` is a
 * silent no-op — so the old flag+expunge path *reported success but never
 * actually trashed Gmail mail*. A move to `[Gmail]/Trash` is what Gmail treats
 * as "trash" (and matches the tools' documented "moves to Trash" contract).
 */
async function resolveTrashPath(client: ImapClientLike): Promise<string> {
  try {
    const boxes = await client.list();
    const special = boxes.find((b) => b.specialUse === "\\Trash");
    if (special) return special.path;
    const named = boxes.find(
      (b) =>
        /^(trash|deleted messages|deleted items|bin)$/i.test(b.name) || /(^|\/)trash$/i.test(b.path)
    );
    if (named) return named.path;
  } catch {
    // Fall through to the Gmail default if LIST fails.
  }
  return resolveMailboxPath("trash", "list");
}

/**
 * Trash a set of UIDs from the currently-selected `srcPath`: move them to the
 * account's Trash mailbox (recoverable). If the messages are *already* in Trash,
 * expunge them instead (the "empty from Trash" case). Returns the resolved
 * destination and whether it expunged.
 */
async function trashUids(
  client: ImapClientLike,
  uids: number[],
  srcPath: string
): Promise<{ dest: string; expunged: boolean }> {
  const dest = await resolveTrashPath(client);
  if (srcPath.trim().toLowerCase() === dest.trim().toLowerCase()) {
    await client.messageDelete(uids, { uid: true });
    return { dest, expunged: true };
  }
  await client.messageMove(uids, dest, { uid: true });
  return { dest, expunged: false };
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
        const { dest, expunged } = await trashUids(client, [ref.uid], ref.path);
        return {
          success: true,
          info: expunged
            ? `Permanently deleted UID ${ref.uid} from Trash ("${ref.path}") via IMAP.`
            : `Moved UID ${ref.uid} to Trash ("${dest}") via IMAP.`,
        };
      } catch (e) {
        return { success: false, error: `IMAP delete failed for UID ${ref.uid}: ${errText(e)}` };
      }
    }
  );
}

// ===========================================================================
// Attachments via BODYSTRUCTURE (2.1 optimization I1)
//
// AppleScript's `mail attachments` can't see MIME-embedded attachments, forcing
// a full raw-source scan. IMAP BODYSTRUCTURE enumerates parts without
// downloading the message, and FETCH BODY[part] pulls a single part — faster
// and it sees the attachments AppleScript misses. Routed for `imap:` ids.
// ===========================================================================

interface AttachmentPart {
  part: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface ImapAttachmentInfo {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

/** Walk a BODYSTRUCTURE tree collecting attachment parts (disposition or filename). */
function collectAttachments(node: ImapBodyStructure, out: AttachmentPart[] = []): AttachmentPart[] {
  if (!node) return out;
  const filename = node.dispositionParameters?.filename || node.parameters?.name;
  const disposition = node.disposition?.toLowerCase();
  const isAttachment =
    !!node.part && (disposition === "attachment" || (!!filename && disposition !== "inline"));
  if (isAttachment) {
    out.push({
      part: node.part as string,
      filename: filename || `part-${node.part}`,
      mimeType: node.type || "application/octet-stream",
      size: node.size ?? 0,
    });
  }
  for (const child of node.childNodes ?? []) collectAttachments(child, out);
  return out;
}

async function streamToBuffer(content: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of content) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** List a message's attachments via IMAP BODYSTRUCTURE (no full download). */
export async function imapListAttachments(
  id: string,
  deps: ImapDeps = {}
): Promise<{ success: boolean; attachments?: ImapAttachmentInfo[]; error?: string }> {
  const ref = decodeImapId(id);
  if (!ref) return { success: false, error: `Not an IMAP message id: "${id}".` };
  return withMailbox(
    ref.path,
    { ...deps, account: deps.account ?? ref.account },
    async (client) => {
      const msg = await client.fetchOne(String(ref.uid), { bodyStructure: true }, { uid: true });
      if (!msg || !msg.bodyStructure) {
        return { success: false, error: `IMAP message UID ${ref.uid} not found in "${ref.path}".` };
      }
      const attachments = collectAttachments(msg.bodyStructure).map((a) => ({
        id: `${id}#${a.part}`,
        name: a.filename,
        mimeType: a.mimeType,
        size: a.size,
      }));
      return { success: true, attachments };
    }
  );
}

/** Fetch one attachment's bytes (base64) via IMAP, matched by filename. */
export async function imapFetchAttachment(
  id: string,
  attachmentName: string,
  deps: ImapDeps = {}
): Promise<{
  success: boolean;
  base64?: string;
  bytes?: number;
  mimeType?: string;
  error?: string;
}> {
  const ref = decodeImapId(id);
  if (!ref) return { success: false, error: `Not an IMAP message id: "${id}".` };
  return withMailbox(
    ref.path,
    { ...deps, account: deps.account ?? ref.account },
    async (client) => {
      const msg = await client.fetchOne(String(ref.uid), { bodyStructure: true }, { uid: true });
      if (!msg || !msg.bodyStructure) {
        return { success: false, error: `IMAP message UID ${ref.uid} not found in "${ref.path}".` };
      }
      const atts = collectAttachments(msg.bodyStructure);
      const match = atts.find((a) => a.filename === attachmentName);
      if (!match) {
        const names = atts.map((a) => a.filename).join(", ") || "none";
        return {
          success: false,
          error: `Attachment "${attachmentName}" not found on UID ${ref.uid}. Available: ${names}.`,
        };
      }
      const dl = await client.download(String(ref.uid), match.part, { uid: true });
      const buf = await streamToBuffer(dl.content);
      return {
        success: true,
        base64: buf.toString("base64"),
        bytes: buf.length,
        mimeType: match.mimeType,
      };
    }
  );
}

// ===========================================================================
// Batch message operations via UID STORE / MOVE (2.1 optimization I2)
//
// AppleScript applies batch mark/flag/move/delete one message at a time. For
// imap: ids we group by mailbox and apply the whole UID set in a single IMAP
// command — dramatically fewer round-trips on large batches.
// ===========================================================================

export interface ImapBatchResult {
  success: number;
  failed: number;
  errors: string[];
}

async function imapBatch(
  ids: string[],
  deps: ImapDeps,
  op: (client: ImapClientLike, uids: number[], path: string) => Promise<void>
): Promise<ImapBatchResult> {
  const groups = new Map<string, { account: string; path: string; uids: number[] }>();
  const errors: string[] = [];
  let failed = 0;
  for (const id of ids) {
    const ref = decodeImapId(id);
    if (!ref) {
      failed++;
      errors.push(`Not an IMAP id: "${id}"`);
      continue;
    }
    const key = `${ref.account}\0${ref.path}`;
    const g = groups.get(key) ?? { account: ref.account, path: ref.path, uids: [] };
    g.uids.push(ref.uid);
    groups.set(key, g);
  }
  let success = 0;
  for (const g of groups.values()) {
    try {
      await useClient({ ...deps, account: deps.account ?? g.account }, async (client) => {
        const lock = await client.getMailboxLock(g.path);
        try {
          await op(client, g.uids, g.path);
        } finally {
          lock.release();
        }
      });
      success += g.uids.length;
    } catch (e) {
      failed += g.uids.length;
      errors.push(`${g.path}: ${errText(e)}`);
    }
  }
  return { success, failed, errors };
}

export const imapBatchMarkRead = (ids: string[], deps: ImapDeps = {}): Promise<ImapBatchResult> =>
  imapBatch(ids, deps, async (c, uids) => {
    await c.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
  });
export const imapBatchMarkUnread = (ids: string[], deps: ImapDeps = {}): Promise<ImapBatchResult> =>
  imapBatch(ids, deps, async (c, uids) => {
    await c.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
  });
export const imapBatchFlag = (ids: string[], deps: ImapDeps = {}): Promise<ImapBatchResult> =>
  imapBatch(ids, deps, async (c, uids) => {
    await c.messageFlagsAdd(uids, ["\\Flagged"], { uid: true });
  });
export const imapBatchUnflag = (ids: string[], deps: ImapDeps = {}): Promise<ImapBatchResult> =>
  imapBatch(ids, deps, async (c, uids) => {
    await c.messageFlagsRemove(uids, ["\\Flagged"], { uid: true });
  });
export const imapBatchDelete = (ids: string[], deps: ImapDeps = {}): Promise<ImapBatchResult> =>
  imapBatch(ids, deps, async (c, uids, path) => {
    await trashUids(c, uids, path);
  });
export function imapBatchMove(
  ids: string[],
  destMailbox: string,
  deps: ImapDeps = {}
): Promise<ImapBatchResult> {
  return imapBatch(ids, deps, async (c, uids) => {
    const dest = (await findMailboxPath(c, destMailbox)) ?? resolveMailboxPath(destMailbox, "list");
    await c.messageMove(uids, dest, { uid: true });
  });
}

// ===========================================================================
// True threading via References / Message-ID (2.1 optimization I5)
//
// For an imap: seed id, assemble the conversation from RFC 5322 References /
// In-Reply-To headers (descendants reference the seed; ancestors are the seed's
// References) using IMAP HEADER SEARCH — more accurate than subject grouping.
// Returns null when nothing beyond the seed is found, so get-thread falls back
// to subject grouping (and for servers without HEADER search support).
// ===========================================================================

export interface ImapThreadMessage {
  id: string;
  subject: string;
  sender: string;
  date: string;
  isRead: boolean;
}
export interface ImapThreadResult {
  count: number;
  text: string;
  structured: { subject: string; messages: ImapThreadMessage[]; count: number };
}

function senderName(from?: ImapAddress[]): string {
  const a = from?.[0];
  if (!a) return "(unknown)";
  return a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? "(unknown)");
}
function dateMs(m: ImapMessage): number {
  return m.envelope?.date ? new Date(m.envelope.date).getTime() : 0;
}

export async function imapThread(
  id: string,
  deps: ImapDeps = {},
  limit = 50
): Promise<ImapThreadResult | null> {
  const ref = decodeImapId(id);
  if (!ref) return null;
  return useClient(
    { ...deps, account: deps.account ?? ref.account },
    async (client) => {
      const lock = await client.getMailboxLock(ref.path);
      try {
        const seed = await client.fetchOne(
          String(ref.uid),
          { envelope: true, headers: ["references", "in-reply-to", "message-id"] },
          { uid: true }
        );
        if (!seed) return null;
        const seedMsgId = seed.envelope?.messageId;
        const refIds = new Set<string>();
        const hdr = seed.headers ? seed.headers.toString() : "";
        for (const m of hdr.matchAll(/<[^>]+>/g)) refIds.add(m[0]);
        if (seed.envelope?.inReplyTo) refIds.add(seed.envelope.inReplyTo);

        const uidSet = new Set<number>([ref.uid]);
        const addFound = (found: number[] | false): void => {
          if (Array.isArray(found)) found.forEach((u) => uidSet.add(u));
        };
        // Descendants: anything referencing the seed.
        if (seedMsgId) {
          addFound(await client.search({ header: { references: seedMsgId } }, { uid: true }));
          addFound(await client.search({ header: { "in-reply-to": seedMsgId } }, { uid: true }));
        }
        // Ancestors: messages whose Message-ID is in the seed's References (bounded).
        for (const mid of [...refIds].slice(0, 20)) {
          addFound(await client.search({ header: { "message-id": mid } }, { uid: true }));
        }
        if (uidSet.size <= 1) return null; // only the seed → caller falls back to subject

        const uids = [...uidSet].slice(0, limit);
        const msgs: ImapMessage[] = [];
        for await (const msg of client.fetch(
          uids.join(","),
          { envelope: true, flags: true },
          { uid: true }
        )) {
          msgs.push(msg);
        }
        msgs.sort((a, b) => dateMs(a) - dateMs(b)); // oldest first
        const subject = seed.envelope?.subject || "(no subject)";
        const structured = {
          subject,
          count: msgs.length,
          messages: msgs.map((m) => ({
            id: encodeImapId(ref.account, ref.path, m.uid),
            subject: m.envelope?.subject || "(no subject)",
            sender: senderName(m.envelope?.from),
            date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : "",
            isRead: m.flags?.has("\\Seen") ?? false,
          })),
        };
        const text =
          `Thread "${subject}" — ${msgs.length} message(s) via IMAP (References-linked, oldest first):\n` +
          msgs.map((m) => formatRow(m, ref.account, ref.path)).join("\n");
        return { count: msgs.length, text, structured };
      } finally {
        lock.release();
      }
    },
    true
  );
}
