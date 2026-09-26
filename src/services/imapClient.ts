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
import { createHash } from "node:crypto";
import { ImapFlow } from "imapflow";
import { readKeychainPassword } from "@/services/smtpMailer.js";
import { SETUP_HINT } from "@/utils/docsUrls.js";
import { mailboxNameKey, nfc } from "@/utils/mailboxName.js";
import { extractHtmlBody, extractTextBody } from "@/utils/mimeParse.js";
import {
  decodeHeaderBytes,
  headerBlockBytes,
  isoOrUndefined,
  parseDateHeader,
  parseHeaderBlock,
  plausibleDateSent,
} from "@/utils/headers.js";
import { classifyCountStatus, type CountDelta } from "@/services/auditLog.js";
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
  /** Text to match in the message body (IMAP `BODY` criterion). */
  body?: string;
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
  /** Server arrival time (IMAP INTERNALDATE) — NOT the author's `Date:` header. */
  internalDate?: Date | string;
  /** `RFC822.SIZE` — the server's own byte count for the stored message,
   *  present when the fetch asked for `size: true`. */
  size?: number;
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
  /** Includes "\\Noselect" for hierarchy containers that cannot be opened. */
  flags?: Set<string>;
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
  /** `readOnly: true` opens the mailbox with EXAMINE instead of SELECT. Test
   *  mocks may ignore the options argument. */
  getMailboxLock(path: string, options?: { readOnly?: boolean }): Promise<MailboxLock>;
  /** The currently open mailbox, as imapflow exposes it after a lock is taken.
   *  Only `uidValidity` is read here; optional so mocks needn't provide it. */
  mailbox?: { path?: string; uidValidity?: bigint; readOnly?: boolean } | false;
  /** imapflow resolves `false` (never throws) when the server rejects the
   *  SEARCH or the connection drops mid-command, and `undefined` when no
   *  mailbox is selected — both are failures, never "no matches" (#256). */
  search(
    query: Record<string, unknown>,
    opts: { uid: true }
  ): Promise<number[] | false | undefined>;
  /** `{ uid: true }` addresses `range` by UID; omitted/false addresses it by
   *  message SEQUENCE number (the #256 large-mailbox listing pages by
   *  sequence number from the top of the mailbox). */
  fetch(
    range: string,
    query: Record<string, unknown>,
    opts?: { uid?: boolean }
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
  /** APPEND a raw RFC822 message to `path`, flagged as given. `false` on server
   *  rejection, same falsy-on-failure contract as the other mutations here. */
  append(
    path: string,
    content: string | Buffer,
    flags?: string[]
  ): Promise<{ destination: string } | false>;
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
  /** The error imapflow last swallowed (it logs a failed command and resolves
   *  `false` instead of throwing), cleared on read. Captured through the
   *  connection's logger by `defaultConnect`; optional so mocks needn't
   *  provide it (#256). */
  takeLastCommandError?(): unknown;
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
  // imapflow swallows a failed SEARCH (and every mutation — see #181): it logs
  // the error through its logger and resolves `false`. With `logger: false` the
  // reason was simply gone, so a SEARCH that timed out or hit a server limit on
  // a huge mailbox was indistinguishable from "no matches" (#256). This logger
  // prints nothing; it only keeps the most recent error for the caller.
  let lastCommandError: unknown;
  const keepErr = (entry: unknown) => {
    if (entry && typeof entry === "object" && "err" in entry) {
      lastCommandError = (entry as { err: unknown }).err;
    }
  };
  const noop = () => undefined;
  const client = new ImapFlow({
    ...buildImapConnectionOptions(cfg),
    logger: { trace: noop, debug: noop, info: noop, warn: keepErr, error: keepErr, fatal: keepErr },
  } as ConstructorParameters<typeof ImapFlow>[0]);
  Object.assign(client, {
    takeLastCommandError: () => {
      const err = lastCommandError;
      lastCommandError = undefined;
      return err;
    },
  });
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

/**
 * Well-known alias -> IMAP SPECIAL-USE flag (RFC 6154), lowercased. Used to find
 * the real mailbox behind a generic name ("trash", "drafts", …) regardless of
 * what the provider actually calls it — Exchange's "Deleted Items", iCloud's
 * "Deleted Messages", Gmail's "[Gmail]/Trash" all advertise `\Trash`.
 */
const SPECIAL_USE_ALIASES: Record<string, string> = {
  "all mail": "\\all",
  archive: "\\archive",
  drafts: "\\drafts",
  sent: "\\sent",
  "sent mail": "\\sent",
  trash: "\\trash",
  spam: "\\junk",
  junk: "\\junk",
  starred: "\\flagged",
};

/**
 * Legacy Gmail-only path guesses — the ONLY resort when a mailbox can be
 * resolved neither as a real mailbox nor via SPECIAL-USE (LIST failed, or the
 * account has no such special-use mailbox and isn't Gmail's proprietary
 * combined-mailbox layout). `[Gmail]/Important` and `[Gmail]/Starred` have no
 * SPECIAL-USE equivalent, so they can only ever be reached this way.
 */
function staticMailboxAlias(mailbox: string): string {
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

/**
 * Resolve a mailbox name to its real IMAP path, in three tiers:
 *   1. An exact real mailbox — full path or a single leaf-name match, from
 *      `client.list()` (#207: `Junk`/`Drafts` genuinely exist on iCloud;
 *      resolving them as real mailboxes must win over any alias table, so a
 *      non-Gmail account's own folders are never shadowed by Gmail's).
 *   2. A well-known alias resolved via the connection's own SPECIAL-USE flags
 *      — provider-neutral, so "trash" finds Exchange's "Deleted Items" or
 *      iCloud's "Deleted Messages" as readily as Gmail's.
 *   3. The legacy Gmail-only static map (`staticMailboxAlias`), as a last
 *      resort when LIST failed or nothing above matched.
 *
 * Tier 1 matching is case- and Unicode-normalization-insensitive (#253) and
 * always yields the server's own stored path. A tier-1 match that is itself
 * ambiguous (two mailboxes sharing a leaf name, or two paths that differ only
 * in NFC/NFD form or case) is refused with an error naming the candidates
 * unless a SPECIAL-USE alias settles it — the static fallback would only
 * SELECT the caller's literal spelling, which is not one of them.
 */
export async function resolveMailboxPath(
  client: ImapClientLike,
  mailbox: string | undefined,
  _mode: "search" | "list"
): Promise<string> {
  if (!mailbox) return "INBOX";
  let boxes: ImapMailboxListing[];
  try {
    boxes = await client.list();
  } catch {
    // LIST failed — fall back to the static guess, same as resolveTrashPath's
    // own `!listed` fallback.
    return staticMailboxAlias(mailbox);
  }
  const resolved = matchMailbox(boxes, mailbox);
  if (resolved.kind === "found") return resolved.path;

  const flag = SPECIAL_USE_ALIASES[mailbox.trim().toLowerCase()];
  if (flag) {
    const special = boxes.find((b) => b.specialUse?.toLowerCase() === flag);
    if (special) return special.path;
  }
  // #253: an ambiguous name is refused, not guessed. Falling through to the
  // static map would SELECT the caller's literal spelling, which (for an
  // ambiguous leaf or two normalization-twins) is at best NONEXISTENT and at
  // worst a third mailbox the caller never meant.
  if (resolved.kind === "ambiguous") {
    throw new Error(ambiguousMailboxError(mailbox, resolved.candidates));
  }
  return staticMailboxAlias(mailbox);
}

/**
 * Every enumerating SEARCH carries UNDELETED (#246). iCloud keeps messages
 * flagged `\\Deleted` but never expunged out of EXISTS, STATUS and FETCH, yet
 * returns them from `UID SEARCH` for flag-only criteria (`ALL`, `SEEN`,
 * `UNSEEN`, `DELETED`) — @j5pu measured 100,011 UIDs for a 48-message INBOX,
 * 99,963 of them `\\Deleted`. Those "matches" can never be fetched, so a
 * filter-less list tripped the STATUS guard below on every call. UNDELETED is
 * also simply the right semantics: a message awaiting expunge is gone as far as
 * a reader is concerned.
 */
const NOT_DELETED = { deleted: false } as const;

function buildCriteria(a: ImapSearchArgs, listMode: boolean): Record<string, unknown> {
  const c: Record<string, unknown> = { ...NOT_DELETED };
  if (a.query) c.or = [{ subject: a.query }, { from: a.query }];
  if (a.body) c.body = a.body;
  if (a.from) c.from = a.from;
  if (a.subject) c.subject = a.subject;
  if (a.isRead === true) c.seen = true;
  if (a.isRead === false) c.unseen = true;
  if (a.unreadOnly && listMode) c.unseen = true;
  if (a.isFlagged === true) c.flagged = true;
  if (a.isFlagged === false) c.unflagged = true;
  if (a.dateFrom) c.since = new Date(a.dateFrom);
  if (a.dateTo) c.before = new Date(a.dateTo);
  // No `all: true` fallback: UNDELETED alone already means "every live message".
  return c;
}

/** A valid Date from a Date or date string, else undefined. */
function validDate(d: Date | string | undefined | null): Date | undefined {
  if (!d) return undefined;
  const parsed = d instanceof Date ? d : new Date(d);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Raw fetched bytes as a Buffer, whichever form imapflow (or a test) handed over. */
function asBuffer(v: Buffer | string): Buffer {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

/**
 * The author's `Date:` header as a Date, recovered wherever it can be (#234 §3).
 *
 * imapflow's `envelope.date` is the SERVER's parse of the header. For a header
 * the server cannot parse — legacy locale dates like `jue ago 30 13:55:12 2007`
 * — imapflow hands back the raw string (iCloud passes it through verbatim,
 * verified against the live server) or nothing at all (a server that sends NIL).
 * Rows used to stop there, so search/list/get-message/get-thread reported no
 * `dateSent` for a message whose date get-message-headers recovered in the same
 * session. In order: the server's parse; our tolerant `parseDateHeader` over
 * the raw envelope string; then the `Date:` field of a fetched header block
 * (the list/search/thread FETCH now requests it, get-message already has the
 * source).
 */
function headerDate(m: ImapMessage, headerText?: string): Date | undefined {
  const env = m.envelope?.date as Date | string | undefined;
  if (env instanceof Date) {
    if (!Number.isNaN(env.getTime())) return env;
  } else if (typeof env === "string" && env.trim()) {
    // RFC 5322 allows a trailing `(comment)` zone name, which Date.parse rejects.
    const parsed = parseDateHeader(env.replace(/\s*\([^)]*\)\s*$/, "").trim());
    if (parsed) return parsed;
  }
  const block = headerText ?? (m.headers ? decodeHeaderBytes(asBuffer(m.headers)) : "");
  const iso = block ? parseHeaderBlock(block).date : undefined;
  return iso ? new Date(iso) : undefined;
}

/**
 * {@link headerDate} minus a value that cannot be a real send time: one later
 * than INTERNALDATE by more than the clock-skew tolerance (#234 §2b, the same
 * helper the AppleScript path uses).
 */
function sentDate(m: ImapMessage, headerText?: string): Date | undefined {
  return plausibleDateSent(headerDate(m, headerText), validDate(m.internalDate));
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
  const shown = sentDate(m) ?? validDate(m.internalDate);
  const date = shown ? shown.toLocaleDateString() : "";
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
/**
 * A date field is omitted-as-empty, never invented: an unparseable or absent
 * value yields "" rather than `Invalid Date`, which is what the row shape has
 * always promised callers.
 */
function isoOrEmpty(d: Date | string | undefined | null): string {
  if (!d) return "";
  const parsed = d instanceof Date ? d : new Date(d);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function structuredRow(m: ImapMessage, account: string, path: string): Record<string, unknown> {
  const env = m.envelope ?? {};
  return {
    id: encodeImapId(account, path, m.uid),
    subject: env.subject || "(no subject)",
    sender: senderName(env.from),
    // ⚠️ `env.date` is the `Date:` HEADER — imapflow builds ENVELOPE from the
    // header block — so emitting it as `dateReceived` made the same field name
    // mean "sent" here and "arrived" on the AppleScript path. Both are now
    // emitted under the name that is true of them, matching `messageSummary`.
    // `dateReceived` falls back to the header date when the server withheld
    // INTERNALDATE, which is the old behaviour and never invents a value.
    // #234: both now see the RECOVERED header date (see headerDate), and
    // `dateSent` omits a value implausibly later than arrival (see sentDate).
    dateSent: isoOrEmpty(sentDate(m)),
    dateReceived: isoOrEmpty(validDate(m.internalDate) ?? headerDate(m)),
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
  /** Mailboxes omitted from an unscoped IMAP search because SELECT/SEARCH failed. */
  failedMailboxes: string[];
  /** The underlying error text for each entry in `failedMailboxes`, keyed by the
   *  same mailbox path (#246 follow-up, @j5pu): the bare path list gave a caller
   *  no way to tell a real "IMAP list failed in every requested mailbox" from
   *  anything else — WHY it failed matters as much as THAT it failed. */
  failedMailboxReasons: Record<string, string>;
}

interface FetchedMailboxMessage {
  message: ImapMessage;
  path: string;
}

/**
 * Turn a per-mailbox IMAP failure (SELECT/SEARCH/STATUS/FETCH inside
 * `fetchMailboxMatches` — always AFTER authentication, since that happens once
 * in `connect()` before `run()`'s per-mailbox loop even starts) into safe text
 * for a tool response. imapflow itself redacts credentials from the LOGIN/
 * AUTHENTICATE command strings it logs (see RAW_SENSITIVE_COMMANDS in
 * imap-flow.js), but that redaction can't cover a server's own NO/BAD response
 * text, which this server doesn't control — so, defense in depth, anything
 * that looks like it might carry a credential is redacted rather than passed
 * through raw.
 */
function describeMailboxFailure(error: unknown): string {
  const raw = errText(error);
  const oneLine = raw.split("\n")[0].trim();
  const looksSensitive = /pass(word)?\s*[:=]|authorization:\s*\S|bearer\s+\S{10,}/i.test(oneLine);
  const safe = looksSensitive
    ? "IMAP error (detail redacted — response text looked like it might contain a credential)"
    : oneLine || "unknown error";
  return safe.length > 300 ? `${safe.slice(0, 300)}…` : safe;
}

function hasMailboxFlag(mailbox: ImapMailboxListing, wanted: string): boolean {
  const normalized = wanted.toLowerCase();
  return [...(mailbox.flags ?? [])].some((flag) => flag.toLowerCase() === normalized);
}

/**
 * Sort key: the author's send time — recovered when the server's ENVELOPE could
 * not parse it, so a mailbox of legacy locale-dated mail sorts by real date
 * (#234) — falling back to arrival rather than sinking an undated message to
 * the bottom as epoch 0.
 */
function messageDateEpoch(message: ImapMessage): number {
  return (sentDate(message) ?? validDate(message.internalDate))?.getTime() ?? 0;
}

function messageIdentity(entry: FetchedMailboxMessage): string {
  const raw = entry.message.envelope?.messageId?.trim() ?? "";
  const messageId = raw
    .replace(/^<+|>+$/g, "")
    .trim()
    .toLowerCase();
  return messageId ? `mid:${messageId}` : `${entry.path}\u0000${entry.message.uid}`;
}

/**
 * Above this many messages (per STATUS) a mailbox is read top-down in bounded
 * windows instead of by one whole-mailbox `UID SEARCH` (#256). Below it the
 * single SEARCH is cheap, exact, and one round trip.
 */
export const LARGE_MAILBOX_MESSAGES = 10_000;
/** First window of a filtered search on a large mailbox, in sequence numbers. */
const FIRST_SEARCH_WINDOW = 5_000;
/** Largest single window (flags-only FETCH or windowed SEARCH), in sequence numbers. */
const MAX_WINDOW = 50_000;

/** Which live messages a mailbox read should return, newest first. */
interface MailboxPage {
  /** Newest live matches to skip. */
  skip: number;
  /** Matches to return after the skip. */
  take: number;
}

interface MailboxMatches {
  messages: ImapMessage[];
  /** Live matches counted. A lower bound when `totalExact` is false. */
  total: number;
  /** False when a large mailbox was only read far enough to fill the page. */
  totalExact: boolean;
}

/** Only the always-present UNDELETED: a plain "list everything" read. */
function isUnfiltered(criteria: Record<string, unknown>): boolean {
  const keys = Object.keys(criteria);
  return keys.length === 1 && criteria.deleted === false;
}

/** Messages in `path` per a fresh STATUS round trip, or undefined when the server won't say. */
async function statusMessageCount(
  client: ImapClientLike,
  path: string
): Promise<number | undefined> {
  try {
    const st = await client.status(path, { messages: true });
    return typeof st.messages === "number" && st.messages >= 0 ? st.messages : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `client.search`, but a failure is an error rather than "no matches".
 * imapflow resolves `false` when the server answers NO/BAD or the connection
 * drops mid-command (a server-side timeout on a huge mailbox looks exactly like
 * this), and `undefined` when nothing is selected. Both used to be read as an
 * empty result (#256).
 */
async function searchUids(
  client: ImapClientLike,
  path: string,
  criteria: Record<string, unknown>,
  size: number | undefined
): Promise<number[]> {
  client.takeLastCommandError?.();
  const found = await client.search(criteria, { uid: true });
  if (Array.isArray(found)) return found;
  const cause = client.takeLastCommandError?.();
  const sized = size === undefined ? "" : ` (${size.toLocaleString("en-US")} messages)`;
  throw new Error(
    `IMAP SEARCH on "${path}"${sized} failed: ` +
      (cause
        ? errText(cause)
        : "the server rejected it or the connection dropped before it answered (on a mailbox this size, usually a server-side timeout)")
  );
}

/** Full row attributes for `uids`, returned in the order given. */
async function fetchRows(client: ImapClientLike, uids: number[]): Promise<ImapMessage[]> {
  if (uids.length === 0) return [];
  const byUid = new Map<number, ImapMessage>();
  for await (const msg of client.fetch(
    uids.join(","),
    // BODYSTRUCTURE rides along so `hasAttachments` is computed rather
    // than assumed. Measured on 50 real messages: ~390ms -> ~465ms for
    // the fetch (~17%), same single round trip, no extra request.
    //
    // INTERNALDATE rides along for the same reason, and is why `dateReceived`
    // can finally mean what it says: imapflow's `envelope.date` is built from
    // the header block, so it IS the `Date:` header, not arrival time.
    //
    // The `Date:` header itself (BODY.PEEK[HEADER.FIELDS (DATE)]) rides in the
    // SAME FETCH command, so a date the server's ENVELOPE parser rejected can
    // still be recovered (#234). Measured on 50 real messages, 6 alternating
    // runs: median ~334ms without vs ~315ms with — inside the noise — for ~44
    // bytes per message. Too cheap to hide behind an opt-in.
    { envelope: true, flags: true, bodyStructure: true, internalDate: true, headers: ["date"] },
    { uid: true }
  )) {
    byUid.set(msg.uid, msg);
  }
  return uids
    .map((uid) => byUid.get(uid))
    .filter((message): message is ImapMessage => message !== undefined);
}

/**
 * Walk a large mailbox top-down in sequence-number windows, newest first (#256).
 * `readWindow(lo, hi)` returns the live UIDs in that window; the first window is
 * addressed `lo:*` so a count that moved since STATUS can't name a sequence
 * number past the end. Stops once the page is full, so `limit: 1` on a
 * 793,614-message mailbox reads one small window instead of every UID.
 */
async function walkWindows(
  exists: number,
  page: MailboxPage,
  firstWindow: number,
  readWindow: (lo: number, hi: number | "*", width: number) => Promise<number[]>
): Promise<{ uids: number[]; matched: number; exhausted: boolean }> {
  const wanted = page.skip + page.take;
  const uids: number[] = [];
  let seen = 0;
  let matched = 0;
  let hi = exists;
  let width = Math.max(1, Math.min(firstWindow, MAX_WINDOW));
  while (hi >= 1 && seen < wanted) {
    const lo = Math.max(1, hi - width + 1);
    const live = (await readWindow(lo, hi === exists ? "*" : hi, hi - lo + 1))
      .slice()
      .sort((a, b) => b - a);
    matched += live.length;
    for (const uid of live) {
      if (seen >= wanted) break;
      if (seen >= page.skip) uids.push(uid);
      seen++;
    }
    hi = lo - 1;
    width = Math.min(width * 4, MAX_WINDOW);
  }
  return { uids, matched, exhausted: hi < 1 };
}

/**
 * Unfiltered read of a large mailbox: FETCH only UID + FLAGS by sequence range
 * from the top, drop anything flagged `\Deleted` (pending expunge — the same
 * UNDELETED semantics #246 gave the SEARCH path), then fetch full rows for the
 * page alone. No SEARCH at all, so nothing proportional to the mailbox size
 * ever crosses the wire.
 */
async function listLargeMailbox(
  client: ImapClientLike,
  exists: number,
  page: MailboxPage
): Promise<MailboxMatches> {
  let deletedSeen = 0;
  const walk = await walkWindows(
    exists,
    page,
    // Room for a few ghosts on the first read without a second round trip.
    page.skip + page.take + 64,
    async (lo, hi) => {
      const live: number[] = [];
      for await (const msg of client.fetch(`${lo}:${hi}`, { uid: true, flags: true })) {
        if (msg.flags?.has("\\Deleted")) deletedSeen++;
        else live.push(msg.uid);
      }
      return live;
    }
  );
  // The total is STATUS less the ghosts actually seen. iCloud keeps messages
  // awaiting expunge out of STATUS and the sequence space altogether, so there
  // it is exact; a server that counts them can overstate by however many sit
  // below the part walked — the same count list-mailboxes reports.
  return {
    messages: await fetchRows(client, walk.uids),
    total: Math.max(0, exists - deletedSeen),
    totalExact: true,
  };
}

/**
 * Filtered read of a large mailbox: the same criteria, confined to one
 * sequence window at a time (`SEARCH <lo:hi> …`), newest window first, growing
 * ×4 up to {@link MAX_WINDOW}. A filter matching most of a 793k-message mailbox
 * fills a page from the first window; a narrow one (a recent `dateFrom`) walks
 * further but never asks for more than one window's UIDs at once.
 */
async function searchLargeMailbox(
  client: ImapClientLike,
  path: string,
  criteria: Record<string, unknown>,
  exists: number,
  page: MailboxPage
): Promise<MailboxMatches> {
  const walk = await walkWindows(exists, page, FIRST_SEARCH_WINDOW, async (lo, hi, width) => {
    const found = await searchUids(client, path, { ...criteria, seq: `${lo}:${hi}` }, exists);
    // The #246 guard, per window: no criteria can match more messages than
    // the window holds.
    if (found.length > width) {
      throw new Error(
        `IMAP SEARCH on "${path}" reported ${found.length} matches in a ${width}-message window — ` +
          `discarding as corrupted rather than trusting it (see #246).`
      );
    }
    return found;
  });
  return {
    messages: await fetchRows(client, walk.uids),
    total: walk.matched,
    totalExact: walk.exhausted,
  };
}

async function fetchMailboxMatches(
  client: ImapClientLike,
  path: string,
  criteria: Record<string, unknown>,
  page: MailboxPage
): Promise<MailboxMatches> {
  const lock = await client.getMailboxLock(path);
  try {
    // #256: a whole-mailbox `UID SEARCH` before applying limit/offset failed
    // outright on @j5pu's 793,614- and 255,104-message iCloud mailboxes. Read
    // the size first, and past LARGE_MAILBOX_MESSAGES page by sequence number
    // from the top instead of materializing every UID.
    const exists = await statusMessageCount(client, path);
    if (exists === 0) return { messages: [], total: 0, totalExact: true };
    if (exists !== undefined && exists > LARGE_MAILBOX_MESSAGES) {
      try {
        return isUnfiltered(criteria)
          ? await listLargeMailbox(client, exists, page)
          : await searchLargeMailbox(client, path, criteria, exists, page);
      } catch (error) {
        const detail = errText(error);
        throw new Error(
          detail.includes(`"${path}" (`)
            ? detail
            : `reading the newest messages of "${path}" (${exists.toLocaleString("en-US")} messages) failed: ${detail}`
        );
      }
    }

    const uids = await searchUids(client, path, criteria, exists);
    if (uids.length === 0 || page.take === 0) {
      return { messages: [], total: uids.length, totalExact: true };
    }

    // A SEARCH match count can never exceed the mailbox's own total message
    // count — no criteria can match more messages than exist. Cross-check
    // against STATUS (a fresh server round trip, the same call list-mailboxes
    // relies on) before trusting `uids.length` as the reported total.
    //
    // This guards a real defect reproduced against the vendored imapflow
    // (1.7.8, node_modules/imapflow/lib/commands/search.js): even though we
    // never pass `returnOptions` (so `useEsearch` is false and the "legacy"
    // SEARCH path runs), that path still registers an untagged ESEARCH
    // handler alongside SEARCH — "IMAP4rev2 servers answer even a plain
    // SEARCH with an untagged ESEARCH response" per imapflow's own comment.
    // When the server's ESEARCH `ALL` attribute is a compact sequence-set
    // range (e.g. "4:739330"), imapflow expands it in a loop bounded by
    // `connection.mailbox.exists` — NOT by the range's own content. If that
    // cached count is wrong at the moment the response is parsed (stale
    // reuse of an already-selected mailbox, or an out-of-band untagged
    // EXISTS landing mid-command; see imap-flow.js `untaggedExists`, which
    // overwrites it with zero bounds-checking), the loop fabricates
    // sequential "matches" up to that wrong count — never real search hits.
    // Confirmed by direct reproduction: a stale `exists` of 100085 against a
    // true 14-message mailbox turns a `SEARCH ALL` into exactly 100085
    // bogus results (#246). Reported upstream candidate for a fix, but we
    // guard here regardless since we cannot control the installed version
    // or the server's exact wire behavior.
    //
    // The trigger @j5pu actually captured on iCloud was different and more
    // mundane: a plain untagged `* SEARCH` listing ~100k `\Deleted`,
    // never-expunged UIDs that EXISTS/STATUS/FETCH all exclude. `NOT_DELETED`
    // in every enumerating criteria set fixes that at the source; this guard
    // stays as the safety net for whatever else can inflate a match count.
    // The count read above is reused; a server that would not answer it then
    // is asked again here, and a failure now fails the mailbox as it always has.
    const messages =
      exists ?? (await client.status(path, { messages: true })).messages ?? undefined;
    if (typeof messages === "number" && uids.length > messages) {
      throw new Error(
        `IMAP SEARCH on "${path}" reported ${uids.length} matches, more than the mailbox's own ` +
          `${messages} messages — discarding as corrupted rather than trusting it (see #246).`
      );
    }

    const newest = uids
      .slice()
      .reverse()
      .slice(page.skip, page.skip + page.take);
    return { messages: await fetchRows(client, newest), total: uids.length, totalExact: true };
  } finally {
    lock.release();
  }
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
      const unscopedSearch = !listMode && !args.mailbox;
      let paths: string[];
      let allMailboxCount = 0;
      if (unscopedSearch) {
        const listed = await client.list();
        const selectable = listed.filter((mailbox) => !hasMailboxFlag(mailbox, "\\Noselect"));
        const allMailbox = selectable.find(
          (mailbox) => mailbox.specialUse?.toLowerCase() === "\\all"
        );
        paths = allMailbox ? [allMailbox.path] : selectable.map((mailbox) => mailbox.path);
        allMailboxCount = paths.length;
        if (paths.length === 0) {
          throw new Error(`No selectable IMAP mailboxes found for account ${cfg.accountLabel}.`);
        }
      } else {
        paths = [await resolveMailboxPath(client, args.mailbox, listMode ? "list" : "search")];
      }

      const limit = args.limit ?? 50;
      const offset = args.offset ?? 0;
      const criteria = buildCriteria(args, listMode);
      // A single mailbox applies the offset itself, so only the requested page
      // is ever fetched in full (#256); a multi-mailbox search needs each
      // mailbox's newest offset+limit to merge and page across them.
      const page: MailboxPage = unscopedSearch
        ? { skip: 0, take: offset + limit }
        : { skip: offset, take: limit };
      const fetched: FetchedMailboxMessage[] = [];
      const failedMailboxes: string[] = [];
      const failedMailboxReasons: Record<string, string> = {};
      let totalMatched = 0;
      let totalExact = true;

      for (const path of paths) {
        try {
          const result = await fetchMailboxMatches(client, path, criteria, page);
          totalMatched += result.total;
          totalExact &&= result.totalExact;
          fetched.push(...result.messages.map((message) => ({ message, path })));
        } catch (error) {
          failedMailboxes.push(path);
          failedMailboxReasons[path] = describeMailboxFailure(error);
          console.error(
            `IMAP ${listMode ? "list" : "search"} failed for account "${cfg.accountLabel}", mailbox "${path}": ${String(error)}`
          );
        }
      }

      if (failedMailboxes.length === paths.length) {
        const detail = failedMailboxes
          .map((path) => `${path} (${failedMailboxReasons[path]})`)
          .join(", ");
        throw new Error(
          `IMAP ${listMode ? "list" : "search"} failed in every requested mailbox for account ${cfg.accountLabel}: ${detail}.`
        );
      }

      let ordered = fetched;
      if (unscopedSearch) {
        ordered = fetched
          .slice()
          .sort((a, b) => messageDateEpoch(b.message) - messageDateEpoch(a.message));
        const unique = new Map<string, FetchedMailboxMessage>();
        for (const entry of ordered) {
          const key = messageIdentity(entry);
          if (!unique.has(key)) unique.set(key, entry);
        }
        ordered = [...unique.values()].slice(offset, offset + limit);
      }

      const rows = ordered.map(({ message, path }) => formatRow(message, cfg.accountLabel, path));
      const messages = ordered.map(({ message, path }) =>
        structuredRow(message, cfg.accountLabel, path)
      );
      const partial = failedMailboxes.length > 0;
      const failureNote = partial
        ? `\n\nPartial result. Could not search mailbox(es): ${failedMailboxes
            .map((path) => `"${path}" (${failedMailboxReasons[path]})`)
            .join(", ")}.`
        : "";
      const verb = listMode ? "listed" : "matched";
      const totalText = totalExact ? `${totalMatched} total` : `at least ${totalMatched} total`;
      const scope = unscopedSearch
        ? allMailboxCount === 1
          ? `mailbox "${paths[0]}"`
          : `${allMailboxCount} selectable mailboxes`
        : `mailbox "${paths[0]}"`;

      if (messages.length === 0) {
        return {
          text: `No messages found via IMAP in ${scope} (account ${cfg.accountLabel}).${failureNote}`,
          messages,
          count: 0,
          partial,
          failedMailboxes,
          failedMailboxReasons,
        };
      }

      const text =
        `Found ${rows.length} message(s) via IMAP (server-side, account ${cfg.accountLabel}, ${scope}; ${totalText} ${verb}):\n` +
        rows.join("\n") +
        `\n\nNote: these IMAP IDs (imap:…) work with get-message and the message mutations (mark/flag/move/delete-message), which route back to IMAP.` +
        failureNote;
      return {
        text,
        messages,
        count: messages.length,
        partial,
        failedMailboxes,
        failedMailboxReasons,
      };
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
      const s = await client.status(await resolveMailboxPath(client, mailbox, "list"), {
        unseen: true,
      });
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
            const found = await client.search(
              { since: since(days), ...NOT_DELETED },
              { uid: true }
            );
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

/**
 * Whether the server's acceptance of a mutation was corroborated by observing
 * the effect. (#181)
 *
 * Three-valued on purpose. `success: false` already covers a command the server
 * REJECTED (#181 part 1). What this adds is the distinction the IMAP path was
 * missing entirely: a command the server ACCEPTED whose effect was confirmed,
 * versus one whose effect nobody looked at. Before 2.13.0 both returned a bare
 * `{success: true}`, so an unverified mutation was indistinguishable from a
 * verified one — the asymmetry #181 was filed for.
 *
 * `unverified` is NOT a failure and must never be rendered as one. It means
 * exactly "the server accepted this and we have no observation either way".
 */
export type ImapVerification =
  { verdict: "verified"; how: string } | { verdict: "unverified"; why: string };

export interface ImapOpResult {
  success: boolean;
  error?: string;
  info?: string;
  /** Absent on operations that perform no post-condition check at all. */
  verification?: ImapVerification;
  /**
   * Backend facts that do not fit `info`'s prose — e.g. the message dates a read
   * returns alongside its body (#224). Merged into `structuredContent` by the
   * caller; never parsed back out of `info`.
   */
  meta?: Record<string, unknown>;
}

function errText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  // imapflow reports every tagged NO/BAD as the generic "Command failed" and
  // puts what the server actually said on side fields (#253: the caller saw
  // "Command failed" for `NO [NONEXISTENT] Mailbox does not exist`).
  const x = e as Error & {
    responseStatus?: unknown;
    responseText?: unknown;
    serverResponseCode?: unknown;
  };
  if (typeof x.responseStatus !== "string" || !x.responseStatus) return e.message;
  const code = typeof x.serverResponseCode === "string" && x.serverResponseCode;
  const text = typeof x.responseText === "string" ? x.responseText.trim() : "";
  const server = [x.responseStatus, code ? `[${code}]` : "", text].filter(Boolean).join(" ");
  return e.message && e.message !== "Command failed" ? `${e.message}: ${server}` : server;
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
function assertMutated<T>(result: T, what: string): Exclude<T, false | null | undefined> {
  if (!result) throw new Error(`${what}: server rejected the command (IMAP NO/BAD)`);
  return result as Exclude<T, false | null | undefined>;
}

/**
 * Corroborate a MOVE the server already accepted. (#181)
 *
 * The AppleScript path has a whole effect-reconciliation layer precisely because
 * "the command did not throw" is not evidence that anything happened; the IMAP
 * path had none of it, and since reads route to IMAP whenever an account is
 * IMAP-configured, that meant the layer was off for essentially all real
 * traffic.
 *
 * Deliberately never returns a failure. A contradicted post-condition is
 * reported as `unverified` with the contradiction named, because a Gmail label
 * store can legitimately keep a message visible in an all-mail view after a
 * move — and hard-failing a working move is the strictly worse error. Callers
 * that need certainty should read `verdict`, not infer it from `success`.
 */
async function verifyMoved(
  client: ImapClientLike,
  moved: ImapMoveResult,
  uid: number,
  srcPath: string,
  destPath: string
): Promise<ImapVerification> {
  // Strongest evidence and it costs nothing: with UIDPLUS the server's own
  // COPYUID response names the UID the message received in the destination.
  const newUid = moved.uidMap?.get(uid);
  if (newUid !== undefined) {
    return {
      verdict: "verified",
      how: `COPYUID: UID ${uid} arrived in "${destPath}" as UID ${newUid}`,
    };
  }
  // No UIDPLUS. The source mailbox is still selected here, so asking whether the
  // UID is still in it is one FETCH and needs no extra capability.
  try {
    const stillThere = await client.fetchOne(String(uid), { uid: true }, { uid: true });
    if (!stillThere) {
      return { verdict: "verified", how: `UID ${uid} is no longer present in "${srcPath}"` };
    }
    return {
      verdict: "unverified",
      why:
        `the server accepted the MOVE, but UID ${uid} is still present in "${srcPath}" and ` +
        `this server does not advertise UIDPLUS, so arrival in "${destPath}" could not be ` +
        `confirmed. A Gmail label store can legitimately keep a message in an all-mail view ` +
        `after a move, so this is not reported as a failure`,
    };
  } catch (e) {
    return { verdict: "unverified", why: `the post-move check could not run: ${errText(e)}` };
  }
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
  const boxes = await client.list();
  return matchMailbox(boxes, name);
}

/**
 * The pure matching half of `resolveMailbox`, in three tiers:
 *   1. the caller's spelling is byte-for-byte a listed path — wins outright;
 *   2. full-path match modulo case and Unicode normalization (#253: iCloud
 *      stores a Mac-created `México` decomposed, NFD, while a typed name is
 *      precomposed, NFC — they look identical and never compared equal);
 *   3. leaf-name match, same folding.
 * Tiers 2 and 3 collect every match: two distinct server paths that fold to
 * the same key (e.g. an NFC and an NFD `México` side by side, or `Foo`/`foo`)
 * are reported as ambiguous rather than guessed. Whatever is returned is the
 * server's own stored path, so SELECT/EXAMINE/MOVE encode it back to exactly
 * the modified-UTF-7 name the server LISTed.
 */
export function matchMailbox(
  boxes: readonly Pick<ImapMailboxListing, "path" | "name">[],
  name: string
): MailboxResolution {
  const exact = boxes.find((b) => b.path === name || b.path === name.trim());
  if (exact) return { kind: "found", path: exact.path };
  const wanted = mailboxNameKey(name);
  const tiers = [
    boxes.filter((b) => mailboxNameKey(b.path) === wanted),
    boxes.filter((b) => mailboxNameKey(b.name) === wanted),
  ];
  for (const hits of tiers) {
    const paths = [...new Set(hits.map((b) => b.path))];
    if (paths.length === 1) return { kind: "found", path: paths[0] };
    if (paths.length > 1) return { kind: "ambiguous", candidates: paths.sort() };
  }
  return { kind: "none" };
}

/** The error text for an ambiguous destination — names every candidate. */
function ambiguousMailboxError(name: string, candidates: string[], accountLabel?: string): string {
  const where = accountLabel ? ` on IMAP account ${accountLabel}` : "";
  const listed = candidates.map((c) => `"${c}"`).join(" and ");
  // #253: two paths that fold to one key look identical in any listing, so
  // "pass the full path" is no help — say what actually differs.
  const indistinguishable = new Set(candidates.map(mailboxNameKey)).size === 1;
  const hint = indistinguishable
    ? " They differ only in letter case or Unicode normalization (precomposed vs decomposed accents), so no typed name can tell them apart. Rename one of them."
    : " Pass the full path.";
  return `Mailbox "${name}" is ambiguous${where} — it matches ${listed}.${hint}`;
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
    // #253: creating "México" (NFC) next to an existing NFD "México" makes a
    // visually identical twin that no typed name can ever address uniquely
    // again. Treat a normalization-equivalent path as already existing. (Case
    // is left alone: a server that allows Foo beside foo keeps allowing it.)
    let twin: string | undefined;
    try {
      const wanted = nfc(name);
      twin = (await client.list()).find((b) => nfc(b.path) === wanted)?.path;
    } catch {
      // LIST failed — let CREATE itself be the judge.
    }
    if (twin !== undefined) {
      return { success: true, info: `Mailbox "${twin}" already existed.` };
    }
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
    // #253: refuse a rename onto a name another mailbox already holds in the
    // other Unicode normalization form — it would create an unaddressable
    // visual twin. (Re-normalizing a mailbox's own name is still allowed.)
    const wantedNew = nfc(newName);
    const clash = (await client.list()).find((b) => b.path !== path && nfc(b.path) === wantedNew);
    if (clash) {
      return {
        success: false,
        error: `Cannot rename "${path}" to "${newName}": mailbox "${clash.path}" already exists on IMAP account ${cfg.accountLabel} (the same name, differing only in how its accents are encoded).`,
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
// Sent-folder copy for SMTP submission (issue #220)
//
// SMTP send (smtpMailer.ts) never touches IMAP, so a message sent that way is
// invisible in the account's own Sent mailbox until/unless the recipient
// replies. This best-effort APPENDs the same raw MIME `sendViaSmtp` submitted
// to the Sent mailbox of whichever configured IMAP account's login matches
// the SMTP identity — the documented convention (APPLE_MAIL_MCP_IMAP_* mirrors
// APPLE_MAIL_MCP_SMTP_*) already relied on elsewhere (readOriginal in
// tools/compose.ts). Silently SKIPPED (attempted:false), not reported as a
// failure, when no configured IMAP account matches: this feature is opt-in by
// that same convention, and a caller who never configured IMAP should not see
// a scary error for a copy they never asked for.
// ===========================================================================

/** Outcome of the best-effort Sent-folder APPEND after an SMTP send. */
export interface SentCopyResult {
  /** False when no configured IMAP account matches the SMTP identity — the
   *  feature was never engaged, not a failure. */
  attempted: boolean;
  /** Only meaningful when `attempted` is true. */
  success?: boolean;
  error?: string;
  mailbox?: string;
}

/**
 * Best-effort APPEND of `raw` (RFC822 source) to the Sent mailbox of the IMAP
 * account whose login matches `smtpUser`, flagged `\Seen`. Never throws —
 * every failure mode (no matching account, connection failure, server
 * rejection) resolves to a `SentCopyResult`, so callers can report it without
 * risking the send that already succeeded.
 */
export async function imapAppendSentCopy(
  smtpUser: string,
  raw: string | Buffer,
  deps: ImapDeps = {}
): Promise<SentCopyResult> {
  if (!deps.config && !isImapAccount(smtpUser)) return { attempted: false };
  try {
    return await withClient({ ...deps, account: deps.account ?? smtpUser }, async (client) => {
      const path = await resolveMailboxPath(client, "sent", "list");
      const res = await client.append(path, raw, ["\\Seen"]);
      if (!res) throw new Error("server rejected the APPEND (IMAP NO/BAD)");
      return { attempted: true, success: true, mailbox: path };
    });
  } catch (e) {
    return { attempted: true, success: false, error: errText(e) };
  }
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

/** Source needed to compose a reply without relying on Mail.app synchronization. */
export interface ImapMessageSource {
  raw: string;
  subject?: string;
  accountUser: string;
}

/** Maximum raw source fetched for a reply/forward, including MIME attachments. */
export const MAX_COMPOSE_SOURCE_BYTES = 25 * 1024 * 1024;

/** Fetch headers and body together from the exact account/mailbox/UID in an IMAP id. */
export async function imapGetMessageSource(
  id: string,
  deps: ImapDeps = {}
): Promise<ImapMessageSource> {
  const ref = decodeImapId(id);
  if (!ref) throw new Error(`Not an IMAP message id: "${id}".`);
  return withClient(depsForMessageRef(ref, deps), async (client, cfg) => {
    const lock = await client.getMailboxLock(ref.path);
    try {
      const msg = await client.fetchOne(
        String(ref.uid),
        {
          envelope: true,
          // One extra byte distinguishes an exact-limit source from truncation.
          source: { start: 0, maxLength: MAX_COMPOSE_SOURCE_BYTES + 1 },
        },
        { uid: true }
      );
      if (!msg) throw new Error(`IMAP message UID ${ref.uid} not found in "${ref.path}".`);
      if (!msg.source || !msg.source.length)
        throw new Error("IMAP returned no original message source.");
      if (Buffer.byteLength(msg.source) > MAX_COMPOSE_SOURCE_BYTES) {
        throw new Error("Original message source exceeds the 25 MiB reply/forward limit.");
      }
      return { raw: msg.source.toString(), subject: msg.envelope?.subject, accountUser: cfg.user };
    } finally {
      lock.release();
    }
  });
}

/** Read a message by composite IMAP id; returns "Subject: …\n\n<body>". */
/**
 * Inline ceiling for get-message-rfc822 (#244): 6 MiB of raw bytes is 8 MiB of
 * base64, which keeps the whole JSON-RPC result under the MCP stdio client's
 * 10 MB hard cap (it drops the connection above that with no error text) with
 * room for the metadata around it.
 */
export const MAX_RFC822_INLINE_BYTES = 6 * 1024 * 1024;
/**
 * Ceiling when the bytes go to a file (`savePath`) instead of the result. Same
 * bound as the reply/forward source fetch: the fetch buffers in memory either
 * way, and this is the size the rest of the server already tolerates.
 */
export const MAX_RFC822_FILE_BYTES = MAX_COMPOSE_SOURCE_BYTES;

export interface ImapRfc822Acquisition {
  account: string;
  mailbox: string;
  uid: number;
  /** Mailbox `UIDVALIDITY` as a decimal string. With `uid` it is the durable
   *  identity of the source message; a UID alone is meaningful only for one
   *  UIDVALIDITY. Absent when the server did not report one. */
  uidValidity?: string;
  /** ISO 8601 `INTERNALDATE` — arrival, not the `Date:` header. */
  internalDate?: string;
  flags: string[];
  /** `RFC822.SIZE` as the server reported it, when it did. */
  size?: number;
  /** The stored bytes, exactly as received — no decoding, no re-serialization. */
  bytes: Buffer;
  /** Hex SHA-256 over exactly `bytes`. */
  sha256: string;
  /** Bare `Message-ID` from ENVELOPE, for convenience; the authoritative copy is in `bytes`. */
  messageId?: string;
  /** The IMAP commands used, for the acquisition record. */
  readMethod: string;
  warnings: string[];
}

export type ImapRfc822Result =
  { success: true; acquisition: ImapRfc822Acquisition } | { success: false; error: string };

/**
 * Acquire a message's stored RFC 822 bytes exactly as the server holds them
 * (#244). Read-only by construction: the mailbox is opened with EXAMINE
 * (`readOnly: true`) and the body is fetched with `BODY.PEEK[]`, so `\Seen`
 * is not set and no STORE, COPY, MOVE, APPEND or EXPUNGE is issued. Nothing is
 * decoded, charset-converted or re-serialized — `bytes` is the wire payload,
 * and `sha256` is computed over exactly those bytes.
 *
 * `maxBytes` is a refusal ceiling, never a truncation point: one extra byte is
 * requested so an exact-limit message is distinguishable from a truncated one
 * (the same trick as imapGetMessageSource), and anything larger is refused
 * with the server's `RFC822.SIZE` so the caller can choose `savePath`.
 */
export async function imapGetMessageRfc822(
  id: string,
  opts: { maxBytes?: number } = {},
  deps: ImapDeps = {}
): Promise<ImapRfc822Result> {
  const ref = decodeImapId(id);
  if (!ref) return { success: false, error: `Not an IMAP message id: "${id}".` };
  const requested = Math.floor(opts.maxBytes ?? MAX_RFC822_INLINE_BYTES);
  const limit = Math.min(Math.max(1, requested), MAX_RFC822_FILE_BYTES);
  return withClient(depsForMessageRef(ref, deps), async (client) => {
    const lock = await client.getMailboxLock(ref.path, { readOnly: true });
    try {
      const mb = client.mailbox;
      const uidValidity =
        mb && mb.uidValidity !== undefined && mb.uidValidity !== null
          ? String(mb.uidValidity)
          : undefined;
      const msg = await client.fetchOne(
        String(ref.uid),
        {
          uid: true,
          flags: true,
          internalDate: true,
          size: true,
          envelope: true,
          source: { start: 0, maxLength: limit + 1 },
        },
        { uid: true }
      );
      if (!msg) {
        return { success: false, error: `IMAP message UID ${ref.uid} not found in "${ref.path}".` };
      }
      if (!msg.source || !msg.source.length) {
        return { success: false, error: "IMAP returned no message source." };
      }
      const bytes = asBuffer(msg.source);
      const size = typeof msg.size === "number" ? msg.size : undefined;
      if (bytes.length > limit) {
        return {
          success: false,
          error:
            `Message UID ${ref.uid} in "${ref.path}" is larger than ${limit} bytes` +
            (size !== undefined ? ` (RFC822.SIZE ${size})` : "") +
            `; nothing was acquired (the ceiling refuses, it never truncates). ` +
            `Raise maxBytes — inline ceiling ${MAX_RFC822_INLINE_BYTES} — or pass savePath ` +
            `to write up to ${MAX_RFC822_FILE_BYTES} bytes to disk.`,
        };
      }
      const warnings: string[] = [];
      if (size !== undefined && size !== bytes.length) {
        warnings.push(
          `RFC822.SIZE is ${size} but ${bytes.length} bytes were acquired: the server's size ` +
            `accounting and its stored bytes disagree. sha256 covers what was received.`
        );
      }
      if (uidValidity === undefined) {
        warnings.push(
          "The server did not report UIDVALIDITY for this mailbox; uid alone is not a durable identity."
        );
      }
      return {
        success: true,
        acquisition: {
          account: ref.account,
          mailbox: ref.path,
          uid: ref.uid,
          uidValidity,
          internalDate: isoOrUndefined(msg.internalDate),
          flags: msg.flags ? Array.from(msg.flags) : [],
          size,
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          messageId: msg.envelope?.messageId
            ? normalizeMessageId(msg.envelope.messageId)
            : undefined,
          readMethod:
            `EXAMINE "${ref.path}"; UID FETCH ${ref.uid} ` +
            `(UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE BODY.PEEK[]<0.${limit + 1}>)`,
          warnings,
        },
      };
    } finally {
      lock.release();
    }
  });
}

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
      // INTERNALDATE rides along so the read can report the server's arrival
      // time beside the author's `Date:` header (#224). The envelope's `date`
      // IS the `Date:` header — imapflow builds ENVELOPE from the header block.
      { envelope: true, internalDate: true, source: true },
      { uid: true }
    );
    if (!msg)
      return { success: false, error: `IMAP message UID ${ref.uid} not found in "${ref.path}".` };
    const sourceBytes = msg.source ? asBuffer(msg.source) : Buffer.alloc(0);
    // ⚠️ latin1, not UTF-8: it is the byte-preserving string form. A UTF-8
    // decode of the whole source destroyed every 8bit latin-1 byte (U+FFFD)
    // before the MIME parser ever saw the part's charset (#234 §4).
    const src = sourceBytes.toString("latin1");
    const headerBytes = sourceBytes.length ? headerBlockBytes(sourceBytes, true) : undefined;
    const headerText = headerBytes ? decodeHeaderBytes(headerBytes) : undefined;
    // The subject from the source's own bytes first: iCloud rewrites 8-bit
    // header bytes to `*` inside ENVELOPE, and only BODY[] keeps them (#234 §4).
    const subject =
      (headerText ? parseHeaderBlock(headerText).subject : undefined) ||
      msg.envelope?.subject ||
      "(no subject)";
    // Report what was actually extracted. With no text/plain part the HTML part
    // is returned, and that used to go out flagged `isHtml: false` (#234 §4).
    let body: string | null;
    let isHtml = false;
    if (preferHtml) {
      body = extractHtmlBody(src);
      isHtml = body !== null;
      body ??= extractTextBody(src);
    } else {
      body = extractTextBody(src);
      if (body === null) {
        body = extractHtmlBody(src);
        isHtml = body !== null;
      }
    }
    return {
      success: true,
      info: `Subject: ${subject}\n\n${body ?? "(no readable body)"}`,
      meta: {
        isHtml,
        dateSent: isoOrUndefined(sentDate(msg, headerText)),
        dateReceived: isoOrUndefined(msg.internalDate),
        // The envelope carries the Message-ID; `info` deliberately does not (it
        // is subject + body), so the caller could never recover it from there.
        rfcMessageId: msg.envelope?.messageId ? normalizeMessageId(msg.envelope.messageId) : "",
      },
    };
  });
}

/** Bytes of BODY[] fetched to find a message's header block — see imapGetMessageHeaders. */
export const HEADER_WINDOW_BYTES = 64 * 1024;

/**
 * Fetch ONLY the RFC 5322 header block of a message by composite IMAP id (#224),
 * plus INTERNALDATE so the caller can show the server's arrival time next to the
 * author's `Date:`. Returns the raw block in `info` and `dateReceived` in `meta`.
 *
 * ⚠️ Reads the first {@link HEADER_WINDOW_BYTES} of `BODY.PEEK[]` and cuts the
 * block out, rather than `BODY.PEEK[HEADER]`. Verified against iCloud with a
 * probe message carrying a raw latin-1 display name (#234 §4): the server
 * rewrites every 8-bit header byte to `*` in ENVELOPE and in `BODY[HEADER]`, and
 * to U+FFFD in `BODY[HEADER.FIELDS]`; only `BODY[]` returns the bytes as stored.
 * No local decoding can recover a name from the first two. The window is still
 * cheap for a message with large attachments; a header block too big for it (a
 * very long Received: trace) falls back to the server's `BODY[HEADER]`.
 */
export async function imapGetMessageHeaders(
  id: string,
  deps: ImapDeps = {}
): Promise<ImapOpResult> {
  const ref = decodeImapId(id);
  if (!ref) return { success: false, error: `Not an IMAP message id: "${id}".` };
  return withMailbox(ref.path, depsForMessageRef(ref, deps), async (client) => {
    const msg = await client.fetchOne(
      String(ref.uid),
      { envelope: true, internalDate: true, source: { start: 0, maxLength: HEADER_WINDOW_BYTES } },
      { uid: true }
    );
    if (!msg)
      return { success: false, error: `IMAP message UID ${ref.uid} not found in "${ref.path}".` };
    const window = msg.source ? asBuffer(msg.source) : Buffer.alloc(0);
    const block = window.length
      ? headerBlockBytes(window, window.length < HEADER_WINDOW_BYTES)
      : undefined;
    let raw = block ? decodeHeaderBytes(block) : "";
    if (!raw.trim()) {
      const h = await client.fetchOne(String(ref.uid), { headers: true }, { uid: true });
      raw = h && h.headers ? decodeHeaderBytes(asBuffer(h.headers)) : "";
    }
    if (!raw.trim()) return { success: false, error: "IMAP returned no header block." };
    return {
      success: true,
      info: raw,
      meta: { dateReceived: isoOrUndefined(msg.internalDate) },
    };
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
    const destPath =
      dest.kind === "found" ? dest.path : await resolveMailboxPath(client, destMailbox, "list");
    const lock = await client.getMailboxLock(ref.path);
    try {
      const moved = assertMutated(
        await client.messageMove([ref.uid], destPath, { uid: true }),
        `IMAP move of UID ${ref.uid} to "${destPath}"`
      );
      const verification = await verifyMoved(client, moved, ref.uid, ref.path, destPath);
      return {
        success: true,
        info:
          verification.verdict === "verified"
            ? `Moved UID ${ref.uid} to "${destPath}" via IMAP (verified: ${verification.how}).`
            : `Moved UID ${ref.uid} to "${destPath}" via IMAP — UNVERIFIED: ${verification.why}.`,
        verification,
      };
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
  // LIST just failed above, so a fresh resolveMailboxPath call would only fail
  // the same way and fall back to this same static guess — skip straight to it.
  if (!listed) return staticMailboxAlias("trash");

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
): Promise<{ dest: string; expunged: boolean; moved?: ImapMoveResult }> {
  const dest = await resolveTrashPath(client);
  if (srcPath.trim().toLowerCase() === dest.trim().toLowerCase()) {
    assertMutated(
      await client.messageDelete(uids, { uid: true }),
      `IMAP expunge of ${uids.length} message(s) from "${srcPath}"`
    );
    return { dest, expunged: true };
  }
  const moved = assertMutated(
    await client.messageMove(uids, dest, { uid: true }),
    `IMAP move of ${uids.length} message(s) from "${srcPath}" to "${dest}"`
  );
  return { dest, expunged: false, moved };
}

/**
 * Corroborate an EXPUNGE the server already accepted. Same contract as
 * `verifyMoved`: never a failure, only "confirmed" vs "nobody looked". (#181)
 */
async function verifyExpunged(
  client: ImapClientLike,
  uid: number,
  path: string
): Promise<ImapVerification> {
  try {
    const stillThere = await client.fetchOne(String(uid), { uid: true }, { uid: true });
    if (!stillThere) {
      return { verdict: "verified", how: `UID ${uid} is no longer present in "${path}"` };
    }
    return {
      verdict: "unverified",
      why: `the server accepted the EXPUNGE but UID ${uid} is still present in "${path}"`,
    };
  } catch (e) {
    return { verdict: "unverified", why: `the post-delete check could not run: ${errText(e)}` };
  }
}

export async function imapDeleteMessageById(
  id: string,
  deps: ImapDeps = {}
): Promise<ImapOpResult> {
  const ref = decodeImapId(id);
  if (!ref) return { success: false, error: `Not an IMAP message id: "${id}".` };
  return withMailbox(ref.path, depsForMessageRef(ref, deps), async (client) => {
    try {
      const { dest, expunged, moved } = await trashUids(client, [ref.uid], ref.path);
      const verification =
        expunged || !moved
          ? await verifyExpunged(client, ref.uid, ref.path)
          : await verifyMoved(client, moved, ref.uid, ref.path, dest);
      const what = expunged
        ? `Permanently deleted UID ${ref.uid} from Trash ("${ref.path}") via IMAP`
        : `Moved UID ${ref.uid} to Trash ("${dest}") via IMAP`;
      return {
        success: true,
        info:
          verification.verdict === "verified"
            ? `${what} (verified: ${verification.how}).`
            : `${what} — UNVERIFIED: ${verification.why}.`,
        verification,
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
  /**
   * What the operation actually did to each SOURCE mailbox. (#181)
   *
   * Present only for operations that remove messages from their source — the
   * batch move and delete — because those are the ones where "how many left"
   * is a meaningful question. Marking read or flagging changes no count, and
   * emitting `expected: N, observed: 0` for them would manufacture an alarm.
   *
   * Same shape and the same classification as the AppleScript path, so a caller
   * reads one structure regardless of backend. Unlike that path, the numbers
   * come from the server's own `STATUS`, so they are not subject to the
   * Mail.app count lag #155 is about.
   */
  countDelta?: CountDelta[];
}

/** Server-side message count, or null when STATUS would not answer. */
async function mailboxCount(client: ImapClientLike, path: string): Promise<number | null> {
  try {
    const st = await client.status(path, { messages: true });
    return typeof st.messages === "number" ? st.messages : null;
  } catch {
    return null;
  }
}

async function imapBatch(
  ids: string[],
  deps: ImapDeps,
  op: (client: ImapClientLike, uids: number[], path: string) => Promise<void>,
  opts: { reconcile?: boolean } = {}
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
  const countDelta: CountDelta[] = [];
  for (const g of groups.values()) {
    try {
      await useClient(depsForAccount(g.account, deps), async (client) => {
        // STATUS is taken OUTSIDE the mailbox lock and before/after the op, so
        // the reading is the server's own and not this connection's cached view.
        const before = opts.reconcile ? await mailboxCount(client, g.path) : null;
        const lock = await client.getMailboxLock(g.path);
        try {
          await op(client, g.uids, g.path);
        } finally {
          lock.release();
        }
        if (!opts.reconcile) return;
        const after = await mailboxCount(client, g.path);
        const readable = before !== null && after !== null;
        const observed = readable ? before - after : null;
        const { status, unknownReason } = classifyCountStatus(readable, g.uids.length, observed);
        countDelta.push({
          account: g.account,
          mailbox: g.path,
          before,
          after,
          expected: g.uids.length,
          observed,
          status,
          ...(unknownReason ? { unknownReason } : {}),
          ...(unknownReason === "count-unreadable"
            ? { note: "The server did not answer STATUS for this mailbox" }
            : {}),
          ...(unknownReason === "count-did-not-move"
            ? {
                note:
                  `The mailbox count did not move. On a label store (Gmail) a message can stay ` +
                  `visible in an all-mail view after being moved out of a label, so this is not ` +
                  `by itself evidence the operation failed — check the destination.`,
              }
            : {}),
          ...(unknownReason === "count-partial"
            ? {
                note:
                  `Fewer messages left than were operated on. \`observed\` is a LOWER BOUND on ` +
                  `what left, not a count of what left — a concurrent delivery to this mailbox ` +
                  `masks departures one-for-one.`,
              }
            : {}),
        });
      });
      success += g.uids.length;
    } catch (e) {
      failed += g.uids.length;
      errors.push(`${g.path}: ${errText(e)}`);
    }
  }
  return { success, failed, errors, ...(countDelta.length ? { countDelta } : {}) };
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
  imapBatch(
    ids,
    deps,
    async (c, uids, path) => {
      await trashUids(c, uids, path);
    },
    { reconcile: true }
  );
export function imapBatchMove(
  ids: string[],
  destMailbox: string,
  deps: ImapDeps = {}
): Promise<ImapBatchResult> {
  return imapBatch(
    ids,
    deps,
    async (c, uids) => {
      // #137: throws on an ambiguous destination; imapBatch records it per group
      // as a failure rather than moving the batch somewhere the caller didn't name.
      const dest =
        (await findMailboxPathOrThrow(c, destMailbox)) ??
        (await resolveMailboxPath(c, destMailbox, "list"));
      assertMutated(
        await c.messageMove(uids, dest, { uid: true }),
        `IMAP move of ${uids.length} message(s) to "${dest}"`
      );
    },
    { reconcile: true }
  );
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
  return messageDateEpoch(m);
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
        const addFound = (found: number[] | false | undefined): void => {
          if (Array.isArray(found)) found.forEach((u) => uidSet.add(u));
        };
        // Descendants: anything referencing the seed.
        if (seedMsgId) {
          addFound(
            await client.search(
              { header: { references: seedMsgId }, ...NOT_DELETED },
              { uid: true }
            )
          );
          addFound(
            await client.search(
              { header: { "in-reply-to": seedMsgId }, ...NOT_DELETED },
              { uid: true }
            )
          );
        }
        // Ancestors: messages whose Message-ID is in the seed's References (bounded).
        for (const mid of [...refIds].slice(0, 20)) {
          addFound(
            await client.search({ header: { "message-id": mid }, ...NOT_DELETED }, { uid: true })
          );
        }
        if (uidSet.size <= 1) return null; // only the seed → caller falls back to subject

        const uids = [...uidSet].slice(0, limit);
        const msgs: ImapMessage[] = [];
        for await (const msg of client.fetch(
          uids.join(","),
          // Same reason as the list/search fetch: get-thread emits structured
          // rows too, so it needs BODYSTRUCTURE or its hasAttachments would
          // silently disagree with the same message seen via search.
          // INTERNALDATE and the Date: header ride along for the same reason as
          // the list/search fetch: the per-message date is recovered and
          // sanity-checked exactly as a row's dateSent is (#234).
          {
            envelope: true,
            flags: true,
            bodyStructure: true,
            internalDate: true,
            headers: ["date"],
          },
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
            // Was `new Date(m.envelope.date).toISOString()`, unguarded — a
            // truthy but unparseable `env.date` (e.g. a non-RFC-5322 header the
            // IMAP server's own ENVELOPE parser couldn't normalize) threw
            // `RangeError: Invalid time value` out of get-thread (#226 follow-up).
            // Same omitted-not-invented contract as `structuredRow` (2.19.2).
            date: isoOrEmpty(sentDate(m)),
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
