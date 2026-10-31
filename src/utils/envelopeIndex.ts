/**
 * Envelope Index reader (opt-in header search backend).
 *
 * Mail.app keeps the metadata of every message it has synced in a SQLite
 * database it maintains itself:
 *
 *   ~/Library/Mail/V<N>/MailData/Envelope Index
 *
 * Reading it directly answers header searches (subject / sender / mailbox /
 * date / read / flagged) in milliseconds, where the AppleScript `whose` scan
 * has to materialize every message and cannot finish on mailboxes of tens of
 * thousands of messages (see #24 / #26 — those mailboxes are skipped and
 * reported as partial).
 *
 * Contract:
 *  - **Opt-in.** Only used when `APPLE_MAIL_MCP_ENVELOPE_INDEX` is truthy.
 *  - **Read-only.** The database is opened `readOnly`; nothing here writes to
 *    the mail store.
 *  - **Never a false empty.** Any problem — `node:sqlite` missing (Node < 22.5),
 *    no Full Disk Access, an unexpected schema, an ambiguous mailbox, a filter
 *    the index can't answer — returns `{ ok: false, reason }` so the caller
 *    falls back to the AppleScript path instead of reporting "no messages".
 *  - **Same ids.** Rows carry `messages.ROWID`, which is the value AppleScript's
 *    `id of message` returns, so every by-id tool works on the results.
 *
 * Schema facts relied on (undocumented, verified at open time by
 * {@link checkSchema}): `messages(ROWID, subject→subjects, sender→addresses,
 * mailbox→mailboxes, date_received, read, flagged, deleted)`,
 * `subjects(subject)`, `addresses(address, comment)`, `mailboxes(url)`, and —
 * on Gmail-backed stores — `labels(message_id, mailbox_id)`, which is how a
 * Gmail message filed in `[Gmail]/All Mail` belongs to INBOX and other labels.
 *
 * @module utils/envelopeIndex
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { extractHtmlBody, extractRfcMessageIdFromSource } from "@/utils/mimeParse.js";
import { emlxCandidates, emlxSource, messageText } from "@/utils/emlx.js";
import {
  ATTACH_ALIAS,
  bodyMatchClause,
  scopeCoverage,
  stampMismatch,
  type BodyScopeCoverage,
} from "@/utils/bodyIndex.js";

/** Minimal shape of the `node:sqlite` DatabaseSync we rely on. */
export interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): unknown;
  setReadBigInts(enabled: boolean): void;
}
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
export interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

/** Env switch for this backend. */
export const ENVELOPE_INDEX_ENV = "APPLE_MAIL_MCP_ENVELOPE_INDEX";
/** Override for the Mail data root (tests point it at a fixture tree). */
export const MAIL_DIR_ENV = "APPLE_MAIL_MCP_MAIL_DIR";

/**
 * Why the Mail store can't be read, worded once for every reader of it (the
 * Envelope Index header search, store reads, the body index, `doctor`).
 */
export const FULL_DISK_ACCESS_REASON =
  "Envelope Index not readable (grant Full Disk Access to the server's Node runtime)";

/** True when `value` is one of the usual truthy spellings. */
export function isTruthyFlag(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

/** Whether the Envelope Index backend is switched on. */
export function isEnvelopeIndexEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyFlag(env[ENVELOPE_INDEX_ENV]);
}

let sqliteCache: SqliteModule | null | undefined;

/**
 * Lazily load the built-in `node:sqlite` module, or `null` on runtimes without
 * it (< 22.5). Cached; the caller turns `null` into a fallback reason.
 */
export function loadSqlite(): SqliteModule | null {
  if (sqliteCache !== undefined) return sqliteCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("node:sqlite") as SqliteModule;
    sqliteCache = mod && typeof mod.DatabaseSync === "function" ? mod : null;
  } catch {
    sqliteCache = null;
  }
  return sqliteCache;
}

/** The Mail data root: `APPLE_MAIL_MCP_MAIL_DIR`, else `~/Library/Mail`. */
export function mailRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[MAIL_DIR_ENV];
  if (override && override.trim()) return override.trim();
  return join(homedir(), "Library", "Mail");
}

/**
 * Resolve the newest `V<N>` store under the Mail root that has an Envelope
 * Index, returning both paths, or `null` when there is none (or the root can't
 * be listed — which is what a missing Full Disk Access grant looks like).
 */
export function resolveMailStore(
  root: string = mailRoot()
): { versionDir: string; indexPath: string } | null {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  const versions = entries
    .map((e) => /^V(\d+)$/.exec(e))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const v of versions) {
    const versionDir = join(root, v[0]);
    const indexPath = join(versionDir, "MailData", "Envelope Index");
    if (existsSync(indexPath)) return { versionDir, indexPath };
  }
  return null;
}

/**
 * Split a mailbox URL (`imap://<ACCOUNT-ID>/INBOX`,
 * `ews://<ACCOUNT-ID>/Sent%20Items`, `imap://<ID>/%5BGmail%5D/All%20Mail`) into
 * its account id and decoded, account-relative mailbox path.
 */
export function parseMailboxUrl(url: string): { accountId: string; path: string } | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)\/?(.*)$/i.exec(url);
  if (!m) return null;
  let path = m[2] ?? "";
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep the raw path if it isn't valid percent-encoding */
  }
  return { accountId: m[1], path: path.replace(/\/+$/, "") };
}

/** Columns each required table must have for the queries below. */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  messages: [
    "ROWID",
    "subject",
    "sender",
    "mailbox",
    "date_received",
    "read",
    "flagged",
    "deleted",
  ],
  subjects: ["ROWID", "subject"],
  addresses: ["ROWID", "address", "comment"],
  mailboxes: ["ROWID", "url"],
};

/** Optional schema features, detected per database. */
export interface SchemaFeatures {
  /** Gmail label membership table (`labels(message_id, mailbox_id)`). */
  labels: boolean;
  /** `messages.subject_prefix` ("Re: ", "Fwd: ") stored apart from the subject. */
  subjectPrefix: boolean;
  /** `messages.date_sent`. */
  dateSent: boolean;
  /** `attachments(message)` table. */
  attachments: boolean;
}

function columnsOf(db: SqliteDatabase, table: string): Set<string> {
  // PRAGMA can't take a bound table name; `table` only ever comes from the
  // fixed lists in this module.
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((r) => String(r.name)));
}

/**
 * Verify the tables/columns the queries depend on. Returns the optional
 * features present, or a human-readable mismatch reason.
 */
export function checkSchema(db: SqliteDatabase): SchemaFeatures | { mismatch: string } {
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    const have = columnsOf(db, table);
    // `ROWID` is implicit and never listed by table_info.
    const missing = cols.filter((c) => c !== "ROWID" && !have.has(c));
    if (have.size === 0) return { mismatch: `table "${table}" not found` };
    if (missing.length > 0) {
      return { mismatch: `table "${table}" lacks column(s) ${missing.join(", ")}` };
    }
  }
  const labels = columnsOf(db, "labels");
  const messages = columnsOf(db, "messages");
  const attachments = columnsOf(db, "attachments");
  return {
    labels: labels.has("message_id") && labels.has("mailbox_id"),
    subjectPrefix: messages.has("subject_prefix"),
    dateSent: messages.has("date_sent"),
    attachments: attachments.has("message"),
  };
}

/** Header filters the index can answer. Mirrors searchMessagesWithDiagnostics. */
export interface EnvelopeSearchParams {
  /** Mail account id (`id of account`) — the host part of its mailbox URLs. */
  accountId: string;
  /** Subject-OR-sender substring. */
  query?: string;
  /** Substring of the full sender string (display name + address). */
  from?: string;
  /** Subject substring. */
  subject?: string;
  /** Account-relative mailbox path or leaf name; omit for every mailbox. */
  mailbox?: string;
  dateFrom?: string;
  dateTo?: string;
  isRead?: boolean;
  isFlagged?: boolean;
  /** Restrict to these ROWIDs (body-search hits), in addition to the filters. */
  rowIds?: number[];
  /**
   * Body text to match through the local body index (see bodyIndex.ts). The
   * index file is attached read-only for the query, and the outcome carries
   * how many messages in scope it could not search.
   */
  body?: { text: string; indexFile: string };
  limit: number;
}

/** One message row, normalized for conversion to the server's `Message`. */
export interface EnvelopeRow {
  id: number;
  subject: string;
  /** Full sender string, `Name <address>` when a display name is known. */
  sender: string;
  senderName?: string;
  dateReceived: Date;
  dateSent?: Date;
  isRead: boolean;
  isFlagged: boolean;
  /** Account-relative mailbox path (the searched mailbox for a label hit). */
  mailbox: string;
  hasAttachments: boolean;
}

export type EnvelopeSearchOutcome =
  | { ok: true; rows: EnvelopeRow[]; bodyCoverage?: BodyScopeCoverage }
  | { ok: false; reason: string };

/** Escape `%`, `_` and `\` for a `LIKE ... ESCAPE '\'` pattern. */
export function likePattern(text: string): string {
  return `%${text.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The key every case form of a letter shares: its upper case's lower case, so
 * `ẞ` and `ß` share `ß`, and `Σ`, `σ` and `ς` share `σ`. `İ` lowers to `i` plus
 * a combining dot, which no one-character class can hold; it keys as `i`, as
 * Turkish pairs them.
 */
function foldKey(ch: string): string {
  if (ch === "\u0130") return "i";
  const upper = ch.toUpperCase();
  const lower = ([...upper].length === 1 ? upper : ch).toLowerCase();
  return [...lower].length === 1 ? lower : ch;
}

/** Each cased character outside ASCII → every character with its fold key. Built once, on first use. */
let caseClasses: Map<string, string[]> | null = null;

function buildCaseClasses(): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  // The Basic and Supplementary Multilingual Planes hold every cased letter.
  for (let cp = 0; cp <= 0x1ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates
    const c = String.fromCodePoint(cp);
    if (c.toUpperCase() === c && c.toLowerCase() === c) continue; // no case
    const key = foldKey(c);
    const members = byKey.get(key);
    if (members) members.push(c);
    else byKey.set(key, [c]);
  }
  const classes = new Map<string, string[]>();
  for (const [key, members] of byKey) {
    if (!members.includes(key)) members.push(key);
    if (members.length > 1) for (const m of members) classes.set(m, members);
  }
  return classes;
}

/**
 * `ch` and every other character that is the same letter in another case
 * (`ü`, `Ü`; `ß`, `ẞ`; `ς`, `σ`, `Σ`). An ASCII letter pairs with its other
 * ASCII case only, as SQLite's `LIKE` does, so a letter matches the same way
 * whether or not the rest of the text needs a class.
 */
function caseClass(ch: string): string[] {
  if (ch.charCodeAt(0) < 0x80) {
    const other = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
    return other === ch ? [ch] : [ch, other];
  }
  caseClasses ??= buildCaseClasses();
  const members = caseClasses.get(ch);
  return members ? [ch, ...members.filter((m) => m !== ch)] : [ch];
}

/** Whether `text` has a letter outside ASCII with another case form, which SQLite's `LIKE` can't fold. */
export function needsUnicodeCaseFold(text: string): boolean {
  for (const ch of text) {
    if (ch.charCodeAt(0) >= 0x80 && caseClass(ch).length > 1) return true;
  }
  return false;
}

/**
 * A GLOB pattern for "contains `text`, ignoring case". SQLite's `lower()` and
 * `LIKE` fold ASCII letters only, so `über` would miss `Über` and `café` miss
 * `CAFÉ`; here every character that has case forms becomes a class of them
 * (`[Üü]`), and GLOB's own wildcards (`*`, `?`, `[`) are matched literally.
 */
export function containsGlob(text: string): string {
  let pattern = "*";
  for (const ch of text) {
    const forms = caseClass(ch);
    if (forms.length > 1) pattern += `[${forms.join("")}]`;
    else pattern += ch === "*" || ch === "?" || ch === "[" ? `[${ch}]` : ch;
  }
  return `${pattern}*`;
}

/**
 * Parse a filter date. `new Date("2026-03-15")` is UTC midnight, which west of
 * Greenwich is the evening before — so an ISO date-only string is read as local
 * midnight, the same as "March 15, 2026" already is.
 */
export function parseFilterDate(value: string): Date {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return iso ? new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) : new Date(value);
}

/** Inclusive upper bound: a date-only `dateTo` means end of that day. */
function upperBound(dateTo: string): Date {
  const to = parseFilterDate(dateTo);
  if (!/\d:\d/.test(dateTo)) to.setHours(23, 59, 59, 999);
  return to;
}

/**
 * Resolve `mailbox` to the ROWIDs of matching mailboxes in one account: an exact
 * (case-insensitive) path match wins; otherwise a unique leaf-name match. Several
 * leaf matches are ambiguous — reported as a reason so the AppleScript resolver
 * (which knows how to say "did you mean") handles it.
 */
function resolveMailboxIds(
  db: SqliteDatabase,
  accountId: string,
  mailbox: string
): { ids: number[]; path: string } | { reason: string } {
  const rows = db
    .prepare(`SELECT ROWID AS id, url FROM mailboxes WHERE url LIKE ?`)
    .all(`%://${accountId}/%`);
  // Unicode-normalized, like the AppleScript resolver (#253): an NFD-stored
  // "é" is the same mailbox as the NFC "é" a caller types.
  const fold = (p: string) => p.normalize("NFC").toLowerCase();
  const wanted = fold(mailbox.replace(/\/+$/, ""));
  const exact: { id: number; path: string }[] = [];
  const leaf: { id: number; path: string }[] = [];
  for (const r of rows) {
    const parsed = parseMailboxUrl(String(r.url ?? ""));
    if (!parsed || parsed.accountId !== accountId) continue;
    const path = parsed.path;
    const lower = fold(path);
    if (lower === wanted) exact.push({ id: Number(r.id), path });
    else if (lower.split("/").pop() === wanted) leaf.push({ id: Number(r.id), path });
  }
  if (exact.length > 0) return { ids: exact.map((e) => e.id), path: exact[0].path };
  if (leaf.length === 1) return { ids: [leaf[0].id], path: leaf[0].path };
  if (leaf.length > 1) {
    return {
      reason: `mailbox "${mailbox}" is ambiguous in the index (${leaf.map((l) => l.path).join(", ")})`,
    };
  }
  return { reason: `mailbox "${mailbox}" not found in the index for this account` };
}

function toDate(seconds: unknown): Date | undefined {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : undefined;
}

/**
 * Search one account's messages in an open Envelope Index. Exposed separately
 * from {@link searchEnvelopeIndex} so tests can drive it on a fixture database.
 */
export function searchOpenIndex(
  db: SqliteDatabase,
  features: SchemaFeatures,
  params: EnvelopeSearchParams
): EnvelopeSearchOutcome {
  // SQLite ends a pattern at a NUL, which would quietly match something else.
  if ([params.query, params.subject, params.from].some((t) => t?.includes("\0"))) {
    return { ok: false, reason: "a text filter contains a NUL character" };
  }
  const dateFrom = params.dateFrom ? parseFilterDate(params.dateFrom).getTime() : undefined;
  const dateTo = params.dateTo ? upperBound(params.dateTo).getTime() : undefined;
  // An unreadable date would bind as NULL and match nothing: a false empty.
  if ([dateFrom, dateTo].some((t) => t !== undefined && !Number.isFinite(t))) {
    return { ok: false, reason: "unreadable date filter" };
  }
  const where: string[] = ["m.deleted = 0"];
  const args: unknown[] = [];
  let scopedPath: string | undefined;

  if (params.mailbox !== undefined && params.mailbox !== "") {
    const resolved = resolveMailboxIds(db, params.accountId, params.mailbox);
    if ("reason" in resolved) return { ok: false, reason: resolved.reason };
    scopedPath = resolved.path;
    const ids = JSON.stringify(resolved.ids);
    if (features.labels) {
      where.push(
        `(m.mailbox IN (SELECT value FROM json_each(?)) OR m.ROWID IN ` +
          `(SELECT message_id FROM labels WHERE mailbox_id IN (SELECT value FROM json_each(?))))`
      );
      args.push(ids, ids);
    } else {
      where.push(`m.mailbox IN (SELECT value FROM json_each(?))`);
      args.push(ids);
    }
  } else {
    where.push(`mb.url LIKE ?`);
    args.push(`%://${params.accountId}/%`);
  }

  const subjectExpr = features.subjectPrefix
    ? `COALESCE(m.subject_prefix, '') || COALESCE(s.subject, '')`
    : `COALESCE(s.subject, '')`;
  const senderExpr = `COALESCE(a.comment, '') || ' <' || COALESCE(a.address, '') || '>'`;
  // "Contains, ignoring case": `LIKE` (about twice as fast) when the text has
  // no letters outside ASCII with case forms, else a GLOB of case classes.
  const contains = (expr: string, text: string): string => {
    if (needsUnicodeCaseFold(text)) {
      args.push(containsGlob(text));
      return `${expr} GLOB ?`;
    }
    args.push(likePattern(text));
    return `lower(${expr}) LIKE ? ESCAPE '\\'`;
  };

  if (params.query) {
    where.push(`(${contains(subjectExpr, params.query)} OR ${contains(senderExpr, params.query)})`);
  }
  if (params.subject) where.push(contains(subjectExpr, params.subject));
  if (params.from) where.push(contains(senderExpr, params.from));
  if (params.isRead !== undefined) {
    where.push(`m.read = ?`);
    args.push(params.isRead ? 1 : 0);
  }
  if (params.isFlagged !== undefined) {
    where.push(`m.flagged = ?`);
    args.push(params.isFlagged ? 1 : 0);
  }
  if (dateFrom !== undefined) {
    where.push(`m.date_received >= ?`);
    args.push(Math.floor(dateFrom / 1000));
  }
  if (dateTo !== undefined) {
    where.push(`m.date_received <= ?`);
    args.push(Math.floor(dateTo / 1000));
  }
  if (params.rowIds) {
    where.push(`m.ROWID IN (SELECT value FROM json_each(?))`);
    args.push(JSON.stringify(params.rowIds));
  }

  const fromSql = `
    FROM messages m
    LEFT JOIN subjects s ON m.subject = s.ROWID
    LEFT JOIN addresses a ON m.sender = a.ROWID
    LEFT JOIN mailboxes mb ON m.mailbox = mb.ROWID`;
  // Text the body index can't match faithfully is refused before anything runs.
  const clause = params.body ? bodyMatchClause(params.body.text) : undefined;
  if (clause && "reason" in clause) return { ok: false, reason: clause.reason };
  // Coverage is counted over the header filters alone: every message the body
  // match had to look at, whether or not it matched.
  const bodyCoverage = clause ? scopeCoverage(db, fromSql, where, args) : undefined;
  const filterWhere = [...where];
  const filterArgs = [...args];
  if (clause) {
    filterWhere.push(clause.sql);
    filterArgs.push(...clause.args);
  }

  const sql = `
    SELECT m.ROWID AS id,
           ${subjectExpr} AS subject,
           a.address AS address,
           a.comment AS comment,
           m.date_received AS date_received,
           ${features.dateSent ? "m.date_sent" : "NULL"} AS date_sent,
           m.read AS is_read,
           m.flagged AS is_flagged,
           mb.url AS url,
           ${features.attachments ? "EXISTS (SELECT 1 FROM attachments t WHERE t.message = m.ROWID)" : "0"} AS has_attachments
    ${fromSql}
    WHERE ${filterWhere.join(" AND ")}
    ORDER BY m.date_received DESC
    LIMIT ?`;
  filterArgs.push(params.limit);

  const rows = db.prepare(sql).all(...filterArgs);
  return {
    ok: true,
    ...(bodyCoverage ? { bodyCoverage } : {}),
    rows: rows.map((r) => {
      const address = typeof r.address === "string" ? r.address : "";
      const name = typeof r.comment === "string" ? r.comment.trim() : "";
      const mailboxPath = parseMailboxUrl(String(r.url ?? ""))?.path ?? "";
      return {
        id: Number(r.id),
        subject: typeof r.subject === "string" ? r.subject : "",
        sender: name ? `${name} <${address}>` : address,
        ...(name ? { senderName: name } : {}),
        dateReceived: toDate(r.date_received) ?? new Date(NaN),
        ...(toDate(r.date_sent) ? { dateSent: toDate(r.date_sent) } : {}),
        isRead: Number(r.is_read) === 1,
        isFlagged: Number(r.is_flagged) === 1,
        // A Gmail label hit lives in All Mail; report the mailbox the caller
        // scoped to, which is where the message shows in Mail.
        mailbox: scopedPath ?? mailboxPath,
        hasAttachments: Number(r.has_attachments) === 1,
      };
    }),
  };
}

/**
 * Why opening Mail's Envelope Index read-only now would write to the mail
 * store, or null when it wouldn't. On a WAL database SQLite creates the `-wal`
 * and `-shm` files when they are missing, read-only connection or not. Mail
 * keeps them while it runs; when it has quit and they are gone, the index is
 * left alone and AppleScript answers instead (which starts Mail). Judged from
 * the file header (bytes 18–19 are 2 in WAL mode), read without SQLite.
 *
 * It sees whether the files exist, not whether Mail holds them: after a Mail
 * crash leaves them behind, a read can still update `-shm`, the shared-memory
 * index SQLite rebuilds from the `-wal` when Mail next opens the database.
 */
export function envelopeIndexClosed(indexPath: string): string | null {
  let fd: number | undefined;
  let wal: boolean;
  try {
    fd = openSync(indexPath, "r");
    const header = Buffer.alloc(20);
    wal = readSync(fd, header, 0, 20, 0) === 20 && (header[18] === 2 || header[19] === 2);
  } catch {
    return null; // the open reports whatever is wrong with the file
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!wal || (existsSync(`${indexPath}-wal`) && existsSync(`${indexPath}-shm`))) return null;
  return "Mail isn't running: the Envelope Index has no -wal/-shm files, and reading it would create them in the mail store";
}

/**
 * Search one account via the Envelope Index on disk. Opens the database
 * read-only, verifies the schema, runs the query, and closes it.
 */
export function searchEnvelopeIndex(
  params: EnvelopeSearchParams,
  opts: { indexPath?: string; sqlite?: SqliteModule | null } = {}
): EnvelopeSearchOutcome {
  const sqlite = opts.sqlite === undefined ? loadSqlite() : opts.sqlite;
  if (!sqlite) return { ok: false, reason: "node:sqlite unavailable (requires Node >= 22.5)" };

  const indexPath = opts.indexPath ?? resolveMailStore()?.indexPath;
  if (!indexPath) {
    return {
      ok: false,
      reason: FULL_DISK_ACCESS_REASON,
    };
  }

  const closed = envelopeIndexClosed(indexPath);
  if (closed) return { ok: false, reason: closed };

  let db: SqliteDatabase | null = null;
  try {
    db = new sqlite.DatabaseSync(indexPath, { readOnly: true });
    const features = checkSchema(db);
    if ("mismatch" in features) {
      return { ok: false, reason: `unexpected Envelope Index schema: ${features.mismatch}` };
    }
    if (params.body) {
      // Attached through a read-only connection, so it is read-only too: a
      // search can never write the body index, only the writer instance does.
      try {
        db.prepare(`ATTACH DATABASE ? AS ${ATTACH_ALIAS}`).run(params.body.indexFile);
        const mismatch = stampMismatch(db, ATTACH_ALIAS);
        if (mismatch) return { ok: false, reason: mismatch };
      } catch (err) {
        return {
          ok: false,
          reason: `body index unreadable: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    return searchOpenIndex(db, features, params);
  } catch (err) {
    return {
      ok: false,
      reason: `Envelope Index query failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore close errors */
    }
  }
}

/** A message read straight from its `.emlx` file. */
export interface StoredMessage {
  subject: string;
  plainText: string;
  htmlContent?: string;
  rfcMessageId: string;
  dateSent?: Date;
  dateReceived?: Date;
  /** True when Mail has only part of the message on disk (`.partial.emlx`). */
  partial: boolean;
}

/**
 * Read message `id` from disk: the Envelope Index says which mailbox (and so
 * which directory) holds it, and the `.emlx` there has the body. This skips
 * AppleScript's `whose id is` lookup, which times out on mailboxes of tens of
 * thousands of messages. A reason comes back whenever the file can't be found
 * or read, and the caller falls back to AppleScript.
 */
export function readMessageFromStore(
  id: number,
  opts: {
    includeHtml?: boolean;
    store?: { versionDir: string; indexPath: string } | null;
    sqlite?: SqliteModule | null;
  } = {}
): StoredMessage | { reason: string } {
  const sqlite = opts.sqlite === undefined ? loadSqlite() : opts.sqlite;
  if (!sqlite) return { reason: "node:sqlite unavailable (requires Node >= 22.5)" };
  const store = opts.store === undefined ? resolveMailStore() : opts.store;
  if (!store) {
    return {
      reason: FULL_DISK_ACCESS_REASON,
    };
  }

  const closed = envelopeIndexClosed(store.indexPath);
  if (closed) return { reason: closed };

  let db: SqliteDatabase | null = null;
  let row: Record<string, unknown> | undefined;
  let features: SchemaFeatures;
  try {
    db = new sqlite.DatabaseSync(store.indexPath, { readOnly: true });
    const checked = checkSchema(db);
    if ("mismatch" in checked)
      return { reason: `unexpected Envelope Index schema: ${checked.mismatch}` };
    features = checked;
    row = db
      .prepare(
        `SELECT ${features.subjectPrefix ? "COALESCE(m.subject_prefix, '') || " : ""}COALESCE(s.subject, '') AS subject,
                m.date_received AS date_received,
                ${features.dateSent ? "m.date_sent" : "NULL"} AS date_sent,
                m.deleted AS deleted, mb.url AS url
         FROM messages m
         LEFT JOIN subjects s ON m.subject = s.ROWID
         LEFT JOIN mailboxes mb ON m.mailbox = mb.ROWID
         WHERE m.ROWID = ?`
      )
      .get(id);
  } catch (err) {
    return {
      reason: `Envelope Index query failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore close errors */
    }
  }
  if (!row) return { reason: `message ${id} not in the Envelope Index` };
  if (Number(row.deleted) === 1) return { reason: `message ${id} is deleted` };
  const location = parseMailboxUrl(String(row.url ?? ""));
  if (!location) return { reason: `message ${id} has no mailbox URL` };

  for (const path of emlxCandidates(store.versionDir, location.accountId, location.path, id)) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      continue;
    }
    const source = emlxSource(bytes);
    if (source === null) continue;
    const html = extractHtmlBody(source);
    const text = messageText(source, html);
    const partial = path.endsWith(".partial.emlx");
    // Only the headers are on disk: AppleScript asks Mail, which downloads the
    // body, where this would return an empty one.
    if (partial && html === null && text.trim() === "") {
      return { reason: `message ${id} is only partly downloaded (no body on disk yet)` };
    }
    return {
      subject: typeof row.subject === "string" ? row.subject : "",
      plainText: text,
      ...(opts.includeHtml && html !== null ? { htmlContent: html } : {}),
      rfcMessageId: extractRfcMessageIdFromSource(source),
      ...(toDate(row.date_sent) ? { dateSent: toDate(row.date_sent) } : {}),
      ...(toDate(row.date_received) ? { dateReceived: toDate(row.date_received) } : {}),
      partial,
    };
  }
  return { reason: `no readable .emlx for message ${id} under ${location.path}` };
}
