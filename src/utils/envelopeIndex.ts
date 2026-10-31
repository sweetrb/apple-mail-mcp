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

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  extractHtmlBody,
  extractRfcMessageIdFromSource,
  extractTextBody,
} from "@/utils/mimeParse.js";
import { emlxCandidates, emlxSource, htmlToText } from "@/utils/emlx.js";
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
  const wanted = mailbox.replace(/\/+$/, "").toLowerCase();
  const exact: { id: number; path: string }[] = [];
  const leaf: { id: number; path: string }[] = [];
  for (const r of rows) {
    const parsed = parseMailboxUrl(String(r.url ?? ""));
    if (!parsed || parsed.accountId !== accountId) continue;
    const path = parsed.path;
    const lower = path.toLowerCase();
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

  if (params.query) {
    where.push(
      `(lower(${subjectExpr}) LIKE ? ESCAPE '\\' OR lower(${senderExpr}) LIKE ? ESCAPE '\\')`
    );
    args.push(likePattern(params.query), likePattern(params.query));
  }
  if (params.subject) {
    where.push(`lower(${subjectExpr}) LIKE ? ESCAPE '\\'`);
    args.push(likePattern(params.subject));
  }
  if (params.from) {
    where.push(`lower(${senderExpr}) LIKE ? ESCAPE '\\'`);
    args.push(likePattern(params.from));
  }
  if (params.isRead !== undefined) {
    where.push(`m.read = ?`);
    args.push(params.isRead ? 1 : 0);
  }
  if (params.isFlagged !== undefined) {
    where.push(`m.flagged = ?`);
    args.push(params.isFlagged ? 1 : 0);
  }
  if (params.dateFrom) {
    where.push(`m.date_received >= ?`);
    args.push(Math.floor(parseFilterDate(params.dateFrom).getTime() / 1000));
  }
  if (params.dateTo) {
    where.push(`m.date_received <= ?`);
    args.push(Math.floor(upperBound(params.dateTo).getTime() / 1000));
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
  // Coverage is counted over the header filters alone: every message the body
  // match had to look at, whether or not it matched.
  const bodyCoverage = params.body ? scopeCoverage(db, fromSql, where, args) : undefined;
  const filterWhere = [...where];
  const filterArgs = [...args];
  if (params.body) {
    const clause = bodyMatchClause(params.body.text);
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
    /** Explicit account and optional mailbox/label membership to verify before reading a file. */
    scope?: { accountId: string; mailbox?: string };
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

  let db: SqliteDatabase | null = null;
  let row: Record<string, unknown> | undefined;
  let features: SchemaFeatures;
  try {
    db = new sqlite.DatabaseSync(store.indexPath, { readOnly: true });
    const checked = checkSchema(db);
    if ("mismatch" in checked)
      return { reason: `unexpected Envelope Index schema: ${checked.mismatch}` };
    features = checked;
    let membership = "";
    const parameters: (number | string)[] = [id];
    if (opts.scope?.mailbox) {
      const mailboxes = resolveMailboxIds(db, opts.scope.accountId, opts.scope.mailbox);
      if ("reason" in mailboxes) return mailboxes;
      const placeholders = mailboxes.ids.map(() => "?").join(", ");
      const clauses = [`m.mailbox IN (${placeholders})`];
      parameters.push(...mailboxes.ids);
      if (features.labels) {
        clauses.push(
          `EXISTS (SELECT 1 FROM labels l WHERE l.message_id = m.ROWID AND l.mailbox_id IN (${placeholders}))`
        );
        parameters.push(...mailboxes.ids);
      }
      membership = ` AND (${clauses.join(" OR ")})`;
    }
    row = db
      .prepare(
        `SELECT ${features.subjectPrefix ? "COALESCE(m.subject_prefix, '') || " : ""}COALESCE(s.subject, '') AS subject,
                m.date_received AS date_received,
                ${features.dateSent ? "m.date_sent" : "NULL"} AS date_sent,
                m.deleted AS deleted, mb.url AS url
         FROM messages m
         LEFT JOIN subjects s ON m.subject = s.ROWID
         LEFT JOIN mailboxes mb ON m.mailbox = mb.ROWID
         WHERE m.ROWID = ?${membership}`
      )
      .get(...parameters);
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
  if (!row) {
    return {
      reason: opts.scope
        ? `message ${id} not in requested index scope ${opts.scope.accountId} / ${opts.scope.mailbox ?? "*"}`
        : `message ${id} not in the Envelope Index`,
    };
  }
  if (Number(row.deleted) === 1) return { reason: `message ${id} is deleted` };
  const location = parseMailboxUrl(String(row.url ?? ""));
  if (!location) return { reason: `message ${id} has no mailbox URL` };
  if (opts.scope && location.accountId !== opts.scope.accountId) {
    return { reason: `message ${id} belongs to a different indexed account` };
  }

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
    const text = extractTextBody(source) ?? (html !== null ? htmlToText(html) : "");
    return {
      subject: typeof row.subject === "string" ? row.subject : "",
      plainText: text,
      ...(opts.includeHtml && html !== null ? { htmlContent: html } : {}),
      rfcMessageId: extractRfcMessageIdFromSource(source),
      ...(toDate(row.date_sent) ? { dateSent: toDate(row.date_sent) } : {}),
      ...(toDate(row.date_received) ? { dateReceived: toDate(row.date_received) } : {}),
      partial: path.endsWith(".partial.emlx"),
    };
  }
  return { reason: `no readable .emlx for message ${id} under ${location.path}` };
}
