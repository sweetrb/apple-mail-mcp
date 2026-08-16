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
 * Opt-in via env (mirrors the SMTP transport pattern). EITHER form enables
 * IMAP — the legacy singular keys below, or APPLE_MAIL_MCP_IMAP_ACCOUNTS alone:
 *   APPLE_MAIL_MCP_IMAP_USER      (the legacy single account's login address)
 *   APPLE_MAIL_MCP_IMAP_ACCOUNT   (Mail account name to match for routing; default = USER)
 *   APPLE_MAIL_MCP_IMAP_HOST      (default imap.gmail.com)
 *   APPLE_MAIL_MCP_IMAP_PORT      (default 993, implicit TLS)
 *   APPLE_MAIL_MCP_IMAP_PASSWORD  (else Keychain via the two vars below)
 *   APPLE_MAIL_MCP_IMAP_ALLOW_PLAINTEXT (explicitly allow a non-TLS connection; default off)
 *   APPLE_MAIL_MCP_IMAP_KEYCHAIN_SERVICE / _KEYCHAIN_ACCOUNT
 *   APPLE_MAIL_MCP_IMAP_ACCOUNTS  (JSON array; the multi-account form — see
 *                                  listImapAccountSpecs. Sufficient on its own)
 *
 * @module services/imapClient
 */
import { ImapFlow } from "imapflow";
import { readKeychainPassword } from "@/services/smtpMailer.js";
import { SETUP_HINT } from "@/utils/docsUrls.js";
import { extractHtmlBody, extractTextBody } from "@/utils/mimeParse.js";
import { MAX_IMAP_ATTACHMENT_BYTES } from "@/utils/attachmentLimits.js";

export const IMAP_ENV = {
  user: "APPLE_MAIL_MCP_IMAP_USER",
  account: "APPLE_MAIL_MCP_IMAP_ACCOUNT",
  host: "APPLE_MAIL_MCP_IMAP_HOST",
  port: "APPLE_MAIL_MCP_IMAP_PORT",
  password: "APPLE_MAIL_MCP_IMAP_PASSWORD",
  keychainService: "APPLE_MAIL_MCP_IMAP_KEYCHAIN_SERVICE",
  keychainAccount: "APPLE_MAIL_MCP_IMAP_KEYCHAIN_ACCOUNT",
  allowPlaintext: "APPLE_MAIL_MCP_IMAP_ALLOW_PLAINTEXT",
  // C2 multi-account: JSON array of additional accounts, e.g.
  // [{"account":"Work","user":"me@co.com","host":"imap.co.com","keychainService":"imap.co.com"}]
  accounts: "APPLE_MAIL_MCP_IMAP_ACCOUNTS",
} as const;

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  /** Deliberate insecure escape hatch; false/undefined requires STARTTLS. */
  allowPlaintext?: boolean;
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
  /**
   * Content-ID header, when the part has one. This is what distinguishes an
   * image the HTML body embeds (`<img src="cid:...">`) from a file the sender
   * attached — see `collectAttachments`. imapflow has always populated it; it
   * simply was not declared here.
   */
  id?: string;
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
/**
 * What imapflow's `messageMove`/`messageCopy` resolve to on success. `uidMap` and
 * `uidValidity` are present only when the server advertises UIDPLUS (COPYUID);
 * their ABSENCE is not a failure signal, so nothing here may branch on it.
 */
export interface ImapMoveResult {
  path: string;
  destination: string;
  uidValidity?: bigint;
  uidMap?: Map<number, number>;
}
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
  /** `false` on failure — see `assertMutated`. Typed as a union deliberately:
   *  it used to be `Promise<unknown>`, which made the failure channel
   *  unreachable through the interface and hid #181 from the type checker. */
  messageMove(
    range: number[],
    destination: string,
    opts: FlagOpts
  ): Promise<ImapMoveResult | false>;
  messageDelete(range: number[], opts: FlagOpts): Promise<boolean>;
  noop(): Promise<void>;
  logout(): Promise<void>;
  /** Hard socket teardown (ImapFlow.close): destroys the connection even when a
   *  graceful logout() can't complete on a half-closed socket. Optional so test
   *  mocks needn't implement it. */
  close?(): void;
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

type ImapMessageRef = NonNullable<ReturnType<typeof decodeImapId>>;

function sameImapAccount(left: string, right: string, deps: ImapDeps): boolean {
  if (left === right) return true;

  // Injected configs are the normal test seam and also give us both aliases
  // without consulting process.env or the Keychain.
  if (deps.config) {
    const aliases = new Set([deps.config.accountLabel, deps.config.user]);
    if (aliases.has(left) && aliases.has(right)) return true;
  }

  // Composite ids encode the stable account label, while callers may select
  // that same account by its login address. Resolve both selectors against the
  // same config list before deciding that the id belongs to another account.
  const specs = listImapAccountSpecs();
  const leftSpec = specs.find((spec) => specMatchesSelector(spec, left));
  const rightSpec = specs.find((spec) => specMatchesSelector(spec, right));
  return leftSpec !== undefined && leftSpec === rightSpec;
}

function depsForAccount(account: string, deps: ImapDeps): ImapDeps {
  if (deps.account && !sameImapAccount(account, deps.account, deps)) {
    throw new Error(`IMAP message id belongs to account "${account}", not "${deps.account}".`);
  }
  return { ...deps, account };
}

function depsForMessageRef(ref: ImapMessageRef, deps: ImapDeps): ImapDeps {
  return depsForAccount(ref.account, deps);
}

/**
 * A configured IMAP account *without* its password resolved — cheap to
 * enumerate (no Keychain access), used for routing/listing (C2).
 */
interface ImapAccountSpec {
  accountLabel: string;
  /**
   * Other labels that address this same mailbox — the nicknames of duplicate
   * declarations that were collapsed into this spec. Kept so that deduping
   * cannot break a caller who already addresses the mailbox by the dropped
   * name: it stops being counted twice, but both names still resolve.
   */
  aliases?: string[];
  user: string;
  host: string;
  port: number;
  password?: string;
  keychainService?: string;
  keychainAccount?: string;
}

function isTruthySetting(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

/**
 * True when `selector` names this account. Callers may select by the account
 * label, by any alias folded in during dedupe, or by the login address.
 * Single definition so the routing gate, the config resolver and the
 * composite-id ownership check can't disagree about what a selector means.
 */
function specMatchesSelector(spec: ImapAccountSpec, selector: string): boolean {
  return (
    spec.accountLabel === selector ||
    spec.user === selector ||
    (spec.aliases?.includes(selector) ?? false)
  );
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * The WIRE IDENTITY of an IMAP mailbox: its resolved `(host, port, user)`
 * triple. That triple — not the account label — is what actually distinguishes
 * one mailbox from another. `accountLabel` is a human nickname, and the same
 * mailbox can carry two different nicknames in one config (see
 * `listImapAccountSpecs`).
 *
 * Host is folded case-insensitively (DNS is). `user` is compared byte-exactly
 * after trimming: RFC 5321 leaves the local part case-sensitive and only the
 * receiving server may fold it, so folding it here could silently DROP a real
 * account — a worse failure than the double-count this guards against.
 *
 * Shared by the connection pool (`poolKey`) and by the account-enumeration
 * dedupe so the two notions of "the same account" cannot drift apart.
 */
function imapIdentityKey(spec: { host: string; port: number; user: string }): string {
  return `${spec.host.trim().toLowerCase()}:${spec.port}:${spec.user.trim()}`;
}

/**
 * Enumerate all configured IMAP accounts (C2): the legacy single-account env
 * vars plus any in the `APPLE_MAIL_MCP_IMAP_ACCOUNTS` JSON array. Does not
 * resolve passwords. The legacy account takes precedence on collisions.
 *
 * Dedupe is on the RESOLVED `(host, port, user)` identity, not the label. A
 * config that declares one mailbox twice — once via the legacy singular keys
 * and once as an `APPLE_MAIL_MCP_IMAP_ACCOUNTS` entry under a different
 * nickname — used to yield two specs, because the old guard only compared
 * labels and a different nickname walked straight past it. Every caller that
 * fans out over the spec list then visited that mailbox twice, so the
 * merge-across-accounts counters double-counted it: measured on a real
 * four-identity config where two identities are one Gmail mailbox,
 * `get-unread-count` reported 23 against a true 15, and `get-mail-stats`
 * inflated its message and unread totals the same way. The label check is kept
 * as a secondary guard so two distinct mailboxes can't share one nickname.
 */
function listImapAccountSpecs(env: NodeJS.ProcessEnv = process.env): ImapAccountSpec[] {
  const specs: ImapAccountSpec[] = [];
  const seen = new Set<string>();
  const user = env[IMAP_ENV.user]?.trim();
  if (user) {
    const legacy: ImapAccountSpec = {
      accountLabel: env[IMAP_ENV.account]?.trim() || user,
      user,
      host: env[IMAP_ENV.host]?.trim() || "imap.gmail.com",
      port: env[IMAP_ENV.port] ? Number.parseInt(env[IMAP_ENV.port] as string, 10) : 993,
      password: env[IMAP_ENV.password],
      keychainService: env[IMAP_ENV.keychainService]?.trim(),
      keychainAccount: env[IMAP_ENV.keychainAccount]?.trim(),
    };
    specs.push(legacy);
    seen.add(imapIdentityKey(legacy));
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
          const host = str(a.host) || "imap.gmail.com";
          const port = a.port ? Number(a.port) : 993;
          const key = imapIdentityKey({ host, port, user: u });
          if (seen.has(key)) {
            // Same mailbox already listed — legacy/first wins. Keep this
            // entry's nickname as an alias so collapsing the duplicate can't
            // break a caller that already addresses the mailbox by that name.
            const owner = specs.find((s) => imapIdentityKey(s) === key);
            if (owner && owner.accountLabel !== label && !owner.aliases?.includes(label)) {
              (owner.aliases ??= []).push(label);
            }
            continue;
          }
          if (specs.some((s) => s.accountLabel === label)) continue; // label collision
          seen.add(key);
          specs.push({
            accountLabel: label,
            user: u,
            host,
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

function specToConfig(spec: ImapAccountSpec, allowPlaintext = false): ImapConfig {
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
      `No IMAP password for account "${spec.accountLabel}". Set a password or a Keychain service/account. ${SETUP_HINT}`
    );
  }
  return {
    host: spec.host,
    port: spec.port,
    secure: spec.port === 993,
    allowPlaintext,
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
  return listImapAccountSpecs(env).some((s) => specMatchesSelector(s, account));
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
  const allowPlaintext = isTruthySetting(env[IMAP_ENV.allowPlaintext]);
  for (const spec of listImapAccountSpecs(env)) {
    try {
      out.push(specToConfig(spec, allowPlaintext));
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
    throw new Error(
      `IMAP not configured. Set ${IMAP_ENV.user} (login address), or ${IMAP_ENV.accounts} for multiple accounts, to enable it. ${SETUP_HINT}`
    );
  }
  let spec: ImapAccountSpec | undefined;
  if (account) {
    spec = specs.find((s) => specMatchesSelector(s, account));
    if (!spec) {
      throw new Error(
        `No IMAP account matching "${account}". Configured: ${specs.map((s) => s.accountLabel).join(", ")}.`
      );
    }
  } else {
    spec = specs[0];
  }
  return specToConfig(spec, isTruthySetting(env[IMAP_ENV.allowPlaintext]));
}

/** Build transport options with STARTTLS required unless explicitly opted out. */
export function buildImapConnectionOptions(cfg: ImapConfig) {
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    // ImapFlow reads this as a tri-state, and the distinction matters:
    //   true      -> require STARTTLS; fail if the server does not offer it
    //   false     -> NEVER STARTTLS, even if the server advertises it
    //   undefined -> opportunistic upgrade (ImapFlow's documented default)
    //
    // secure=true already has implicit TLS, so there is no upgrade to negotiate.
    // Without the escape hatch the upgrade is required. WITH it we must fall back
    // to `undefined`, not `false`: the escape hatch means "let me reach a server
    // that cannot do TLS", not "never encrypt". Sending `false` suppressed the
    // upgrade even against servers still offering it, so enabling the opt-out for
    // one broken account silently downgraded every other plaintext-port account
    // below what it already negotiated before this option existed.
    doSTARTTLS: cfg.secure || cfg.allowPlaintext ? undefined : true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false as const,
  };
}

const defaultConnect: ImapConnect = async (cfg) => {
  const client = new ImapFlow(buildImapConnectionOptions(cfg));
  // ImapFlow is an EventEmitter: once connect() resolves, a later socket error
  // on this pooled, long-lived client (idle Gmail/iCloud timeout, server BYE,
  // network drop) emits 'error'. With no listener that is an *uncaught*
  // exception that crashes the whole MCP server. Attach one before connect so
  // the error is swallowed; the pool's liveness probe reconnects on next use.
  // Same defect class as defaultIdleConnect in imapIdle.ts.
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (error) {
    if (!cfg.secure && !cfg.allowPlaintext) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `IMAP connection failed: ${detail}. STARTTLS is required for non-implicit TLS; ` +
          `to explicitly allow plaintext (not recommended), set ${IMAP_ENV.allowPlaintext}=1.`
      );
    }
    throw error;
  }
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
    flagColorIndex: mailFlagColorIndex(m.flags),
    mailbox: path,
    account,
    // Derived from BODYSTRUCTURE, which the list/search fetch now requests.
    // This was hardcoded `false` from 2.2.0 until 2.11.1 — indistinguishable to
    // a caller from "no attachments", so every IMAP-sourced message claimed to
    // have none. Falls back to false only when the fetch carried no
    // BODYSTRUCTURE at all.
    hasAttachments: bodyStructureHasAttachments(m.bodyStructure),
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
          // BODYSTRUCTURE rides along so `hasAttachments` is computed rather
          // than assumed. Measured on 50 real messages: ~390ms -> ~465ms for
          // the fetch (~17%), same single round trip, no extra request.
          { envelope: true, flags: true, bodyStructure: true },
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

/**
 * Unread count via IMAP STATUS (UNSEEN). No mailbox → INBOX.
 *
 * This used to sum UNSEEN across every mailbox, which was both slow — a STATUS
 * per label on a cold pooled connection, dozens of serial round-trips that
 * overran the MCP client's tool-call timeout — and WRONG on Gmail, where one
 * unread message simultaneously lives in INBOX, [Gmail]/All Mail, and each of
 * its labels and so got counted several times over. INBOX is the meaningful
 * "unread messages" figure; pass `mailbox` for any other scope.
 */
export function imapUnreadCount(mailbox: string | undefined, deps: ImapDeps = {}): Promise<number> {
  return useClient(
    deps,
    async (client) => {
      const s = await client.status(resolveMailboxPath(mailbox, "list"), { unseen: true });
      return s.unseen ?? 0;
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

/**
 * Gate EVERY imapflow mutation result through here. (#181)
 *
 * imapflow 1.6.6 does not throw when the server rejects a command: each
 * mutation catches the error, logs a warning, and RESOLVES to `false`
 * (`move.js:55`, `copy.js:42`, `store.js:96`, `expunge.js:55`). So
 * `await client.messageMove(...)` inside a try/catch cannot fail for the entire
 * class of server rejections — the catch is unreachable and the caller reports
 * `{success: true}` for a move that never happened. Discarding the result is
 * therefore a silent-success bug, not a style issue.
 *
 * A falsy result is unambiguous at our call sites. Besides the swallowed
 * server error, imapflow only returns `false` early when `resolveRange` gets an
 * EMPTY range (`[].join(",") === ""`), and every caller here builds its uid list
 * from decoded message ids — never empty. Callers that could pass an empty list
 * must short-circuit before reaching the client, not rely on this.
 *
 * NOTE: this checks only the falsy/truthy channel. It deliberately does NOT
 * inspect `uidMap`/`uidValidity`: those are UIDPLUS-only, and treating their
 * absence as failure hard-fails working moves on servers without the extension.
 */
function assertMutated<T>(result: T, what: string): NonNullable<T> {
  if (!result) throw new Error(`${what}: server rejected the command (IMAP NO/BAD)`);
  return result as NonNullable<T>;
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
  // Delegates to imapIdentityKey so the pool's notion of "the same account" and
  // listImapAccountSpecs' dedupe are literally the same function and cannot
  // drift apart.
  return imapIdentityKey(cfg);
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
  // Graceful logout, THEN a hard close. When Gmail has already half-closed the
  // socket (its idle timeout / a server BYE → the FD sits in CLOSE_WAIT),
  // logout() cannot complete and throws; without the force-close that socket
  // leaked and accumulated against Gmail's ~15-per-account cap (observed: 10
  // ESTABLISHED + 12 CLOSE_WAIT to Gmail per instance). close() destroys it
  // unconditionally so the FD/slot is always released.
  await e.client.logout().catch(() => undefined);
  e.client.close?.();
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
  // "Is IMAP configured?" must ask the same enumerator every other caller asks.
  // This used to test only the LEGACY singular APPLE_MAIL_MCP_IMAP_USER, so a
  // setup that declares its accounts solely through APPLE_MAIL_MCP_IMAP_ACCOUNTS
  // — the documented multi-account form — returned `{configured:false, ok:false}`
  // with NO error field for every account. doctor then rendered that as the
  // literal "connection failed: undefined" for each one, never actually
  // attempting a connection (issue #138).
  if (!deps.config && listImapAccountSpecs().length === 0) {
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
      client.close?.();
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
 * Outcome of resolving a user-supplied mailbox name against the server's list.
 *
 * `ambiguous` exists because the leaf-name fallback below can match more than
 * one mailbox, and picking one of them is a silent wrong answer (#137).
 */
type MailboxResolution =
  { kind: "found"; path: string } | { kind: "none" } | { kind: "ambiguous"; candidates: string[] };

/**
 * Resolve a user-supplied mailbox name to an actual server path by listing the
 * mailboxes and matching on full path, then leaf name (case-insensitive).
 *
 * The leaf-name fallback is what keeps names stored before `list-mailboxes`
 * started reporting full paths (`Thornlands/Home Reno` rather than `Home Reno`)
 * working, so it stays. What does not stay is resolving it with `.find()`:
 * with two mailboxes sharing a leaf name under different parents, that returned
 * whichever the server happened to list first, and `move-message` then reported
 * success for putting mail somewhere the caller never named (#137). All leaf
 * matches are collected instead, and more than one is reported as ambiguous.
 *
 * An exact path match still wins outright, so a caller passing a full path is
 * unaffected, and a single leaf match still resolves.
 */
async function resolveMailbox(client: ImapClientLike, name: string): Promise<MailboxResolution> {
  const wanted = name.trim().toLowerCase();
  const boxes = await client.list();
  const byPath = boxes.find((b) => b.path.toLowerCase() === wanted);
  if (byPath) return { kind: "found", path: byPath.path };
  const byName = boxes.filter((b) => b.name.toLowerCase() === wanted);
  if (byName.length === 1) return { kind: "found", path: byName[0].path };
  if (byName.length > 1) {
    return { kind: "ambiguous", candidates: byName.map((b) => b.path).sort() };
  }
  return { kind: "none" };
}

/** The error text for an ambiguous destination — names every candidate. */
function ambiguousMailboxError(name: string, candidates: string[], accountLabel?: string): string {
  const where = accountLabel ? ` on IMAP account ${accountLabel}` : "";
  return `Mailbox "${name}" is ambiguous${where} — it matches ${candidates
    .map((c) => `"${c}"`)
    .join(" and ")}. Pass the full path.`;
}

/**
 * `resolveMailbox` for callers that only need the path, throwing on ambiguity.
 * Used where the call site has no error channel of its own but its caller does
 * (the batch runner collects thrown errors per group).
 */
async function findMailboxPathOrThrow(
  client: ImapClientLike,
  name: string
): Promise<string | null> {
  const res = await resolveMailbox(client, name);
  if (res.kind === "ambiguous") throw new Error(ambiguousMailboxError(name, res.candidates));
  return res.kind === "found" ? res.path : null;
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
    const res = await resolveMailbox(client, name);
    if (res.kind === "ambiguous") {
      return {
        success: false,
        error: ambiguousMailboxError(name, res.candidates, cfg.accountLabel),
      };
    }
    if (res.kind === "none") {
      return {
        success: false,
        error: `Mailbox "${name}" not found on IMAP account ${cfg.accountLabel}.`,
      };
    }
    const path = res.path;
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
    const found = await resolveMailbox(client, oldName);
    if (found.kind === "ambiguous") {
      return {
        success: false,
        error: ambiguousMailboxError(oldName, found.candidates, cfg.accountLabel),
      };
    }
    if (found.kind === "none") {
      return {
        success: false,
        error: `Mailbox "${oldName}" not found on IMAP account ${cfg.accountLabel}.`,
      };
    }
    const path = found.path;
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
  return withMailbox(ref.path, depsForMessageRef(ref, deps), async (client) => {
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
  });
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
 * Mail.app id — needed by the numeric-id-only tools, `reply-to-message` and
 * `forward-message`. (Flag **colors** no longer need it: since 2.10.0 they are
 * written over IMAP as the `$MailFlagBit0/1/2` keywords.) Returns the normalized
 * Message-ID (no angle brackets), or null if `id` isn't an imap: token, the
 * message/envelope can't be fetched, or it carries no Message-ID.
 */
export async function imapFetchMessageId(id: string, deps: ImapDeps = {}): Promise<string | null> {
  const ref = decodeImapId(id);
  if (!ref) return null;
  try {
    return await withMailbox(ref.path, depsForMessageRef(ref, deps), async (client) => {
      const msg = await client.fetchOne(String(ref.uid), { envelope: true }, { uid: true });
      const mid = msg && msg.envelope?.messageId;
      return mid ? normalizeMessageId(mid) : null;
    });
  } catch {
    return null;
  }
}

/**
 * Apple Mail encodes a flag COLOR as custom IMAP keywords `$MailFlagBit0/1/2`,
 * a plain 3-bit field holding the 0-6 palette index. It is NOT carried by
 * `\Flagged`, which is colorless — but the bits ride alongside it in an
 * ordinary UID STORE, so color is fully readable AND writable over IMAP.
 *
 * Verified against live Mail.app state 2026-08-03:
 *   $MailFlagBit0 + $MailFlagBit1            -> 3 = green
 *   $MailFlagBit2                            -> 4 = blue
 *   $MailFlagBit0 + $MailFlagBit2            -> 5 = purple
 *
 * This is what lets a smart mailbox keyed on flag color match a message flagged
 * over IMAP. Before this, color required resolving to a numeric id and going
 * through AppleScript, which needed Mail.app running plus a TCC grant.
 */
const MAIL_FLAG_BITS = ["$MailFlagBit0", "$MailFlagBit1", "$MailFlagBit2"] as const;

/** Keywords to SET for a palette index (0-6), and the ones to CLEAR. */
export function mailFlagBitsFor(colorIndex: number): { set: string[]; clear: string[] } {
  const set: string[] = [];
  const clear: string[] = [];
  for (let b = 0; b < MAIL_FLAG_BITS.length; b++) {
    ((colorIndex >> b) & 1 ? set : clear).push(MAIL_FLAG_BITS[b]);
  }
  return { set, clear };
}

/** Palette index carried by a message's IMAP keywords, or undefined when none. */
export function mailFlagColorIndex(flags: Iterable<string> | undefined): number | undefined {
  if (!flags) return undefined;
  const have = new Set(flags);
  let idx = 0;
  let any = false;
  for (let b = 0; b < MAIL_FLAG_BITS.length; b++) {
    if (have.has(MAIL_FLAG_BITS[b])) {
      idx |= 1 << b;
      any = true;
    }
  }
  return any ? idx : undefined;
}

function flagOp(id: string, flag: string, add: boolean, deps: ImapDeps): Promise<ImapOpResult> {
  const ref = decodeImapId(id);
  if (!ref) return Promise.resolve({ success: false, error: `Not an IMAP message id: "${id}".` });
  return withMailbox(ref.path, depsForMessageRef(ref, deps), async (client) => {
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
  });
}

export const imapMarkRead = (id: string, deps = {}): Promise<ImapOpResult> =>
  flagOp(id, "\\Seen", true, deps);
export const imapMarkUnread = (id: string, deps = {}): Promise<ImapOpResult> =>
  flagOp(id, "\\Seen", false, deps);
/**
 * Flag over IMAP, optionally with a color. Bits for the requested color are
 * ADDED and the other bits REMOVED, so re-flagging with a different color
 * replaces it rather than OR-ing into a wrong index.
 */
export function imapFlagMessage(
  id: string,
  colorIndex?: number,
  deps: ImapDeps = {}
): Promise<ImapOpResult> {
  if (colorIndex === undefined) return flagOp(id, "\\Flagged", true, deps);
  const ref = decodeImapId(id);
  if (!ref) return Promise.resolve({ success: false, error: `Not an IMAP message id: "${id}".` });
  const { set, clear } = mailFlagBitsFor(colorIndex);
  return withMailbox(ref.path, depsForMessageRef(ref, deps), async (client) => {
    try {
      const ok = await client.messageFlagsAdd([ref.uid], ["\\Flagged", ...set], { uid: true });
      if (!ok)
        return { success: false, error: `IMAP flag update returned false for UID ${ref.uid}.` };
      // Non-fatal: the flag and its color are already set; a failure here can only
      // leave a stale higher bit, which is cosmetic.
      if (clear.length) await client.messageFlagsRemove([ref.uid], clear, { uid: true });
      return { success: true };
    } catch (e) {
      return { success: false, error: `IMAP flag update failed for UID ${ref.uid}: ${errText(e)}` };
    }
  });
}

/** Unflag clears the color bits too — otherwise Mail.app keeps rendering the color. */
export function imapUnflagMessage(id: string, deps: ImapDeps = {}): Promise<ImapOpResult> {
  const ref = decodeImapId(id);
  if (!ref) return Promise.resolve({ success: false, error: `Not an IMAP message id: "${id}".` });
  return withMailbox(ref.path, depsForMessageRef(ref, deps), async (client) => {
    try {
      const ok = await client.messageFlagsRemove([ref.uid], ["\\Flagged", ...MAIL_FLAG_BITS], {
        uid: true,
      });
      if (!ok) return { success: false, error: `IMAP unflag returned false for UID ${ref.uid}.` };
      return { success: true };
    } catch (e) {
      return { success: false, error: `IMAP unflag failed for UID ${ref.uid}: ${errText(e)}` };
    }
  });
}

export async function imapMoveMessageById(
  id: string,
  destMailbox: string,
  deps: ImapDeps = {}
): Promise<ImapOpResult> {
  const ref = decodeImapId(id);
  if (!ref) return { success: false, error: `Not an IMAP message id: "${id}".` };
  return withClient(depsForMessageRef(ref, deps), async (client, cfg) => {
    // #137: refuse an ambiguous destination rather than moving the message to
    // whichever same-leaf mailbox the server listed first and reporting success.
    const dest = await resolveMailbox(client, destMailbox);
    if (dest.kind === "ambiguous") {
      return {
        success: false,
        error: ambiguousMailboxError(destMailbox, dest.candidates, cfg.accountLabel),
      };
    }
    const destPath = dest.kind === "found" ? dest.path : resolveMailboxPath(destMailbox, "list");
    const lock = await client.getMailboxLock(ref.path);
    try {
      assertMutated(
        await client.messageMove([ref.uid], destPath, { uid: true }),
        `IMAP move of UID ${ref.uid} to "${destPath}"`
      );
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
/** Created only when the account demonstrably has no Trash mailbox at all. */
const FALLBACK_TRASH_PATH = "Trash";

async function resolveTrashPath(client: ImapClientLike): Promise<string> {
  let listed = false;
  try {
    const boxes = await client.list();
    listed = true;
    const special = boxes.find((b) => b.specialUse === "\\Trash");
    if (special) return special.path;
    const named = boxes.find(
      (b) =>
        /^(trash|deleted messages|deleted items|bin)$/i.test(b.name) || /(^|\/)trash$/i.test(b.path)
    );
    if (named) return named.path;
  } catch {
    // LIST failed, so we cannot tell what exists — the Gmail default is the
    // best remaining guess. A wrong guess now fails loudly (#181) instead of
    // silently discarding the delete.
  }
  if (!listed) return resolveMailboxPath("trash", "list");

  // LIST succeeded and this account has no Trash mailbox of any kind. Returning
  // the Gmail default here is what made `delete-message` a SILENT NO-OP on every
  // non-Gmail server without a Trash folder: the MOVE drew `NO [TRYCREATE]`,
  // imapflow resolved it to `false`, and the discarded result was reported as a
  // successful delete. Create the mailbox instead — "recoverable" is the
  // contract these tools document, and a hard delete is never an option.
  try {
    const created = await client.mailboxCreate(FALLBACK_TRASH_PATH);
    return created?.path || FALLBACK_TRASH_PATH;
  } catch {
    // Racing another client that just created it is fine; if it genuinely could
    // not be created, the MOVE below now fails loudly rather than silently.
    return FALLBACK_TRASH_PATH;
  }
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
    assertMutated(
      await client.messageDelete(uids, { uid: true }),
      `IMAP expunge of ${uids.length} message(s) from "${srcPath}"`
    );
    return { dest, expunged: true };
  }
  assertMutated(
    await client.messageMove(uids, dest, { uid: true }),
    `IMAP move of ${uids.length} message(s) from "${srcPath}" to "${dest}"`
  );
  return { dest, expunged: false };
}

export async function imapDeleteMessageById(
  id: string,
  deps: ImapDeps = {}
): Promise<ImapOpResult> {
  const ref = decodeImapId(id);
  if (!ref) return { success: false, error: `Not an IMAP message id: "${id}".` };
  return withMailbox(ref.path, depsForMessageRef(ref, deps), async (client) => {
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
  });
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

/**
 * Walk a BODYSTRUCTURE tree collecting attachment parts.
 *
 * ## `inline` does not mean "not an attachment"
 *
 * RFC 2183 `inline` means "display this in place if you can" — it says nothing
 * about whether the part is a file the user attached. **Apple Mail sends
 * genuine attachments as `inline`**, because it inlines them into the message
 * flow rather than appending them. Excluding every inline part therefore hid
 * every attachment sent from Mail.app, and because `fetch-attachment` and
 * `save-attachment` resolve by name against this same walk, those files were
 * not merely unlisted — they were unfetchable.
 *
 * Measured over 300 real messages: of 27 parts carrying a filename, 4 were
 * excluded by the old rule. Three were invoice PDFs (inline, no Content-ID) and
 * one was a signature logo (inline, `image/png`, **with** a Content-ID).
 *
 * So the discriminator is the **Content-ID**, not the disposition: a part the
 * HTML body references as `cid:` is embedded content, and anything else with a
 * filename is a file. An explicit `attachment` disposition always wins — real
 * mail carries `attachment` parts that also have a Content-ID, and letting the
 * Content-ID veto those would trade one silent omission for another.
 */
function collectAttachments(node: ImapBodyStructure, out: AttachmentPart[] = []): AttachmentPart[] {
  if (!node) return out;
  const filename = node.dispositionParameters?.filename || node.parameters?.name;
  const disposition = node.disposition?.toLowerCase();
  const isEmbeddedByReference = disposition === "inline" && !!node.id;
  const isAttachment =
    !!node.part && (disposition === "attachment" || (!!filename && !isEmbeddedByReference));
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

/**
 * Does this message carry at least one attachment part?
 *
 * Shares `collectAttachments`' walk deliberately: if the two ever disagreed,
 * `hasAttachments` would promise a file that `list-attachments` then refuses to
 * show (or vice versa), which is the shape of bug this pair already had once.
 */
export function bodyStructureHasAttachments(node?: ImapBodyStructure): boolean {
  return !!node && collectAttachments(node).length > 0;
}

async function streamToBuffer(
  content: AsyncIterable<Uint8Array>,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of content) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new Error(`IMAP attachment exceeds the ${maxBytes / 1024 / 1024} MiB size limit.`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** List a message's attachments via IMAP BODYSTRUCTURE (no full download). */
export async function imapListAttachments(
  id: string,
  deps: ImapDeps = {}
): Promise<{ success: boolean; attachments?: ImapAttachmentInfo[]; error?: string }> {
  const ref = decodeImapId(id);
  if (!ref) return { success: false, error: `Not an IMAP message id: "${id}".` };
  return withMailbox(ref.path, depsForMessageRef(ref, deps), async (client) => {
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
  });
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
  return withMailbox(ref.path, depsForMessageRef(ref, deps), async (client) => {
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
    if (match.size > MAX_IMAP_ATTACHMENT_BYTES) {
      return {
        success: false,
        error: `IMAP attachment "${attachmentName}" is ${match.size} bytes; the maximum is ${MAX_IMAP_ATTACHMENT_BYTES} bytes (25 MiB).`,
      };
    }
    try {
      const dl = await client.download(String(ref.uid), match.part, { uid: true });
      const buf = await streamToBuffer(dl.content, MAX_IMAP_ATTACHMENT_BYTES);
      return {
        success: true,
        base64: buf.toString("base64"),
        bytes: buf.length,
        mimeType: match.mimeType,
      };
    } catch (e) {
      return { success: false, error: `IMAP attachment fetch failed: ${errText(e)}` };
    }
  });
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
      await useClient(depsForAccount(g.account, deps), async (client) => {
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

// Every op below routes its imapflow result through `assertMutated`: a throw is
// what `imapBatch` converts into a per-group `failed` count plus an error string,
// so a server rejection is reported instead of counted as a success. (#181)
export const imapBatchMarkRead = (ids: string[], deps: ImapDeps = {}): Promise<ImapBatchResult> =>
  imapBatch(ids, deps, async (c, uids) => {
    assertMutated(
      await c.messageFlagsAdd(uids, ["\\Seen"], { uid: true }),
      `IMAP mark-read of ${uids.length} message(s)`
    );
  });
export const imapBatchMarkUnread = (ids: string[], deps: ImapDeps = {}): Promise<ImapBatchResult> =>
  imapBatch(ids, deps, async (c, uids) => {
    assertMutated(
      await c.messageFlagsRemove(uids, ["\\Seen"], { uid: true }),
      `IMAP mark-unread of ${uids.length} message(s)`
    );
  });
export const imapBatchFlag = (
  ids: string[],
  colorIndex?: number,
  deps: ImapDeps = {}
): Promise<ImapBatchResult> =>
  imapBatch(ids, deps, async (c, uids) => {
    if (colorIndex === undefined) {
      assertMutated(
        await c.messageFlagsAdd(uids, ["\\Flagged"], { uid: true }),
        `IMAP flag of ${uids.length} message(s)`
      );
      return;
    }
    const { set, clear } = mailFlagBitsFor(colorIndex);
    assertMutated(
      await c.messageFlagsAdd(uids, ["\\Flagged", ...set], { uid: true }),
      `IMAP flag of ${uids.length} message(s)`
    );
    // Clear the unwanted bits so re-flagging with a new color replaces it.
    // Deliberately NOT asserted, matching the single-message path: the flag and
    // its color are already set, so a failure here can only leave a stale higher
    // bit — cosmetic, and not worth failing an otherwise-applied batch.
    if (clear.length) await c.messageFlagsRemove(uids, clear, { uid: true });
  });
export const imapBatchUnflag = (ids: string[], deps: ImapDeps = {}): Promise<ImapBatchResult> =>
  imapBatch(ids, deps, async (c, uids) => {
    // Clear the color bits too, or Mail.app keeps rendering the color.
    assertMutated(
      await c.messageFlagsRemove(uids, ["\\Flagged", ...MAIL_FLAG_BITS], { uid: true }),
      `IMAP unflag of ${uids.length} message(s)`
    );
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
    // #137: throws on an ambiguous destination; imapBatch records it per group
    // as a failure rather than moving the batch somewhere the caller didn't name.
    const dest =
      (await findMailboxPathOrThrow(c, destMailbox)) ?? resolveMailboxPath(destMailbox, "list");
    assertMutated(
      await c.messageMove(uids, dest, { uid: true }),
      `IMAP move of ${uids.length} message(s) to "${dest}"`
    );
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
    depsForMessageRef(ref, deps),
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
          // Same reason as the list/search fetch: get-thread emits structured
          // rows too, so it needs BODYSTRUCTURE or its hasAttachments would
          // silently disagree with the same message seen via search.
          { envelope: true, flags: true, bodyStructure: true },
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
