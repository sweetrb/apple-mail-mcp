/**
 * Body index: the FTS5 schema, the query layer, and the indexer that fills it.
 *
 * AppleScript can't search message bodies at any useful scale — `content
 * contains` drags every body through the Apple Event bridge — so body search
 * has been IMAP-only. This module keeps a local SQLite FTS5 index of the bodies
 * Mail.app already stores on disk as `.emlx` files under
 * `~/Library/Mail/V<N>/<account>/<mailbox>.mbox/…/Messages/<ROWID>.emlx`. A
 * search attaches the index read-only to the Envelope Index query
 * (envelopeIndex.ts), so the body match, the header filters and the coverage
 * count for the searched scope are one query.
 *
 * Who runs what (one writer, many readers, the watcher) lives in
 * bodyIndexSync.ts; this module only knows the file.
 *
 * Contract:
 *  - **Our file only.** The index is stamped with `PRAGMA application_id` and
 *    `user_version`. A file at the index path that doesn't carry our
 *    application id is never modified or deleted. A file that does, but has an
 *    older layout or is corrupt, is rebuilt — by the writer only.
 *  - **Sensitive.** A token index still reveals a lot about the mail, so the
 *    directory is created `0700` and the database, its `-wal`/`-shm` and the
 *    writer lock `0600`, set explicitly rather than left to the umask.
 *  - **Contentless.** `content=''` FTS5 stores only the inverted index, never a
 *    second plaintext copy of any body.
 *  - **Never writes the mail store.** `.emlx` files are only read, and never
 *    one above {@link MAX_EMLX_BYTES}.
 *  - **Bounded steps.** Walking the store and indexing both run in small
 *    time-boxed slices, so the caller can yield between them.
 *
 * @module utils/bodyIndex
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
} from "fs";
import { basename, dirname, join } from "path";
import { homedir } from "os";
import { extractHtmlBody, extractTextBody } from "@/utils/mimeParse.js";
import { emlxSource, htmlToText } from "@/utils/emlx.js";
import type { SqliteDatabase, SqliteModule } from "@/utils/envelopeIndex.js";

/** Override for the index file location. */
export const BODY_INDEX_FILE_ENV = "APPLE_MAIL_MCP_BODY_INDEX_FILE";

/** `PRAGMA application_id` of every body index file: "AMBI" (Apple Mail Body Index). */
export const BODY_INDEX_APPLICATION_ID = 0x414d4249;
/** Bumped whenever the layout changes; the writer rebuilds an older file. */
export const BODY_INDEX_SCHEMA_VERSION = 5;

/** `.emlx` files larger than this are never read (attachments stored inline). */
export const MAX_EMLX_BYTES = 25 * 1024 * 1024;
/** Index at most this many characters of body text per message. */
const MAX_BODY_CHARS = 100_000;
/** Rows fetched per indexing query; bounds memory, not time. */
const INDEX_BATCH = 200;

/**
 * Per-message state in `docs`. Every message file the writer has seen on disk
 * has a row; a message in the Envelope Index without one has no `.emlx` file
 * (not downloaded) or arrived after the writer's last update.
 */
export const DocState = {
  /** On disk, not indexed yet (new, or changed since it was indexed). */
  queued: 0,
  /** Indexed from a complete download. */
  indexed: 1,
  /**
   * A `.partial.emlx` with no body text: Mail has only the headers (or only
   * attachment stubs). A partial file that does carry its text part — the
   * usual case, where only attachments weren't downloaded — is `indexed`.
   */
  partial: 2,
  /** Larger than {@link MAX_EMLX_BYTES}; not read. */
  tooLarge: 3,
  /** Only a bounded prefix was indexed; its remaining body was not searched. */
  truncated: 5,
} as const;

/** Where the index lives: `APPLE_MAIL_MCP_BODY_INDEX_FILE`, else Application Support. */
export function bodyIndexPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[BODY_INDEX_FILE_ENV];
  if (override && override.trim()) return override.trim();
  return join(homedir(), "Library", "Application Support", "apple-mail-mcp", "body-index.db");
}

/** The writer lock that sits next to the index (see bodyIndexSync.ts). */
export function bodyIndexLockPath(indexPath: string): string {
  return `${indexPath}.writer-lock`;
}

/**
 * Mail's message id from an `.emlx` file name: `12345.emlx` or a not yet fully
 * downloaded `12345.partial.emlx`. Null for anything else.
 */
export function messageIdFromFilename(name: string): number | null {
  const m = /^(\d+)(\.partial)?\.emlx$/.exec(name);
  return m ? Number(m[1]) : null;
}

/**
 * Searchable body text from an `.emlx` file's bytes, whitespace-collapsed. Uses
 * the same framing, MIME and charset path as `readMessageFromStore`
 * (emlxSource → extractTextBody, else htmlToText of the HTML part). Null when
 * the file isn't framed as `.emlx` or carries no text.
 */
export function parseEmlxBody(bytes: Buffer): string | null {
  const source = emlxSource(bytes);
  if (source === null) return null;
  const text = extractTextBody(source) ?? htmlToText(extractHtmlBody(source) ?? "");
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized || null;
}

/** Quote user text as one FTS5 phrase so operators in it are taken literally. */
export function ftsPhrase(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// Capability checks
// ---------------------------------------------------------------------------

let fts5Checked: { module: SqliteModule; reason: string | null } | null = null;

/**
 * Null when the bundled SQLite can build the index, else why not. Needs FTS5
 * with `contentless_delete` (SQLite 3.43+), so a re-indexed message can replace
 * its old entry. Checked once per module on a throwaway in-memory database.
 */
export function fts5Unsupported(sqlite: SqliteModule): string | null {
  if (fts5Checked?.module === sqlite) return fts5Checked.reason;
  let reason: string | null = null;
  let db: SqliteDatabase | null = null;
  try {
    db = new sqlite.DatabaseSync(":memory:");
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(x, content = '', contentless_delete = 1)`);
  } catch (err) {
    reason =
      `the bundled SQLite lacks FTS5 contentless_delete (needs SQLite 3.43+): ` +
      (err instanceof Error ? err.message : String(err));
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
  fts5Checked = { module: sqlite, reason };
  return reason;
}

// ---------------------------------------------------------------------------
// Ownership and file modes
// ---------------------------------------------------------------------------

const SQLITE_MAGIC = "SQLite format 3\0";

/**
 * What is at `path`, judged from the 100-byte SQLite header alone (so it works
 * on a file too damaged to open): nothing, an empty file, our index, or
 * something that isn't ours.
 */
export function inspectIndexFile(path: string): "missing" | "empty" | "ours" | "foreign" {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return existsSync(path) ? "foreign" : "missing";
  }
  try {
    if (fstatSync(fd).size === 0) return "empty";
    const header = Buffer.alloc(100);
    const n = readSync(fd, header, 0, 100, 0);
    if (n < 100 || header.toString("latin1", 0, 16) !== SQLITE_MAGIC) return "foreign";
    return header.readUInt32BE(68) === BODY_INDEX_APPLICATION_ID ? "ours" : "foreign";
  } finally {
    closeSync(fd);
  }
}

/**
 * Create the index directory `0700` if it doesn't exist. An existing directory
 * is left as it is: `APPLE_MAIL_MCP_BODY_INDEX_FILE` can point into a directory
 * the user owns for other reasons.
 */
export function ensurePrivateDir(dir: string): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Create `path` as an empty `0600` file if it doesn't exist; force `0600` either way. */
export function ensurePrivateFile(path: string): void {
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
}

/** Force `0600` on the database's WAL and shared-memory files when they exist. */
function privateSidecars(path: string): void {
  for (const p of [`${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(p, 0o600);
    } catch {
      /* not created yet */
    }
  }
}

function removeIndexFiles(path: string): void {
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Check the stamp of an index visible on `db` as schema `schema` (`main` for a
 * direct connection, the alias for an attached one). Null when it is ours and
 * current; otherwise why it can't be searched. A reader never repairs this: a
 * writer mid-migration reads as "unavailable", never as an empty index.
 */
export function stampMismatch(db: SqliteDatabase, schema = "main"): string | null {
  const appId = Number(db.prepare(`PRAGMA ${schema}.application_id`).get()?.application_id ?? 0);
  if (appId !== BODY_INDEX_APPLICATION_ID) {
    return "the file at the body index path is not an apple-mail-mcp body index";
  }
  const version = Number(db.prepare(`PRAGMA ${schema}.user_version`).get()?.user_version ?? 0);
  if (version !== BODY_INDEX_SCHEMA_VERSION) {
    return `body index is being rebuilt (schema v${version}, this server expects v${BODY_INDEX_SCHEMA_VERSION})`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS docs (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    mtime INTEGER NOT NULL,
    size INTEGER NOT NULL,
    state INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS docs_state ON docs (state, id);
  CREATE VIRTUAL TABLE IF NOT EXISTS bodies
    USING fts5(body, content = '', contentless_delete = 1,
               tokenize = 'unicode61 remove_diacritics 2');
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Counts of indexed messages by state, from `docs`. */
export interface IndexCounts {
  indexed: number;
  queued: number;
  partial: number;
  tooLarge: number;
  /** Present when at least one message exceeded the body-text indexing cap. */
  truncated?: number;
}

/** Writer-recorded facts about the index, kept in its `meta` table. */
export interface IndexMeta {
  /** ISO time the last full walk of the store finished. */
  lastFullWalk?: string;
  /** How long that walk took, in ms of work (excluding pauses). */
  lastWalkMs?: number;
  /** Message files that walk found. */
  lastWalkFiles?: number;
  /** ISO time and reason of the last rebuild. */
  lastRebuild?: string;
  /** Last indexing or walk error. */
  lastError?: string;
}

/** Read counts and meta from an open index (`schema` as in {@link stampMismatch}). */
export function readIndexState(
  db: SqliteDatabase,
  schema = "main"
): { counts: IndexCounts; meta: IndexMeta } {
  const counts: IndexCounts = { indexed: 0, queued: 0, partial: 0, tooLarge: 0 };
  for (const r of db
    .prepare(`SELECT state, count(*) AS n FROM ${schema}.docs GROUP BY state`)
    .all()) {
    const n = Number(r.n);
    switch (Number(r.state)) {
      case DocState.queued:
        counts.queued = n;
        break;
      case DocState.indexed:
        counts.indexed = n;
        break;
      case DocState.partial:
        counts.partial = n;
        break;
      case DocState.tooLarge:
        counts.tooLarge = n;
        break;
      case DocState.truncated:
        counts.truncated = n;
        break;
    }
  }
  const meta: IndexMeta = {};
  for (const r of db.prepare(`SELECT key, value FROM ${schema}.meta`).all()) {
    const key = String(r.key);
    const value = String(r.value);
    if (key === "lastWalkMs" || key === "lastWalkFiles") meta[key] = Number(value);
    else if (key === "lastFullWalk" || key === "lastRebuild" || key === "lastError") {
      meta[key] = value;
    }
  }
  return { counts, meta };
}

// ---------------------------------------------------------------------------
// Query layer (used by envelopeIndex.searchOpenIndex on an attached index)
// ---------------------------------------------------------------------------

/** Alias under which a search attaches the body index. */
export const ATTACH_ALIAS = "bi";

/** WHERE clause restricting Envelope Index messages to body matches. */
export function bodyMatchClause(text: string): { sql: string; args: unknown[] } {
  return {
    sql: `m.ROWID IN (SELECT rowid FROM ${ATTACH_ALIAS}.bodies WHERE bodies MATCH ?)`,
    args: [ftsPhrase(text)],
  };
}

/** Messages in a search scope that the body search could not fully read. */
export interface BodyScopeCoverage {
  /** In the Envelope Index, no `.emlx` the writer has seen (not downloaded, or brand new). */
  notDownloaded: number;
  /** On disk but not indexed yet. */
  notIndexedYet: number;
  /** A partial download with no body text yet: not searched. */
  partlyDownloaded: number;
  /** Over the size cap; not read. */
  tooLarge: number;
  /** Only the first {@link MAX_BODY_CHARS} characters were indexed. */
  truncated?: number;
}

/**
 * Coverage for the messages matching `where` (the search's header filters,
 * without the body clause): how many of them the body search did not see in
 * full. Runs on the Envelope Index connection with the index attached.
 */
export function scopeCoverage(
  db: SqliteDatabase,
  fromSql: string,
  where: string[],
  args: unknown[]
): BodyScopeCoverage {
  const row = db
    .prepare(
      `SELECT
         sum(d.id IS NULL) AS missing,
         sum(d.state = ${DocState.queued}) AS queued,
         sum(d.state = ${DocState.partial}) AS partial,
         sum(d.state = ${DocState.tooLarge}) AS too_large,
         sum(d.state = ${DocState.truncated}) AS truncated
       ${fromSql}
       LEFT JOIN ${ATTACH_ALIAS}.docs d ON d.id = m.ROWID
       WHERE ${where.join(" AND ")}`
    )
    .get(...args);
  return {
    notDownloaded: Number(row?.missing ?? 0),
    notIndexedYet: Number(row?.queued ?? 0),
    partlyDownloaded: Number(row?.partial ?? 0),
    tooLarge: Number(row?.too_large ?? 0),
    ...(Number(row?.truncated ?? 0) > 0 ? { truncated: Number(row!.truncated) } : {}),
  };
}

/** True when every message in scope was searched in full. */
export function isScopeComplete(c: BodyScopeCoverage): boolean {
  return (
    c.notDownloaded + c.notIndexedYet + c.partlyDownloaded + c.tooLarge + (c.truncated ?? 0) === 0
  );
}

/** `1,234 messages not downloaded, 12 not indexed yet, …` — the non-zero parts only. */
export function describeScopeGap(c: BodyScopeCoverage): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const parts: string[] = [];
  if (c.notDownloaded) parts.push(`${fmt(c.notDownloaded)} messages not downloaded`);
  if (c.notIndexedYet) parts.push(`${fmt(c.notIndexedYet)} not indexed yet`);
  if (c.partlyDownloaded) parts.push(`${fmt(c.partlyDownloaded)} with no body downloaded yet`);
  if (c.tooLarge) parts.push(`${fmt(c.tooLarge)} over the 25 MB size cap`);
  if (c.truncated) {
    parts.push(`${fmt(c.truncated)} over the ${fmt(MAX_BODY_CHARS)}-character body cap`);
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Writer: open, walk, index
// ---------------------------------------------------------------------------

/** Clock and timer used for deadlines; swappable in tests. */
export interface Clock {
  /** Wall time in ms (recorded in meta, used for walk scheduling). */
  now(): number;
  /** Monotonic ms for slice deadlines. */
  monotonic(): number;
}
export const realClock: Clock = { now: () => Date.now(), monotonic: () => performance.now() };

/**
 * One full walk of the store, done in slices. Each slice lists directories and
 * compares each message file's `(path, size, mtime)` with what `docs` holds;
 * only a new or changed file is queued for parsing. When the walk finishes,
 * rows for files no longer on disk are dropped.
 */
class StoreWalk {
  private readonly stack: string[];
  private readonly seen = new Set<number>();
  workMs = 0;

  constructor(private readonly versionDir: string) {
    this.stack = [versionDir];
  }

  get files(): number {
    return this.seen.size;
  }

  /** List directories until `deadline`; true when the walk has covered everything. */
  step(
    deadline: number,
    clock: Clock,
    onFile: (id: number, path: string, mtime: number, size: number) => void
  ): boolean {
    while (this.stack.length > 0 && clock.monotonic() < deadline) {
      const dir = this.stack.pop()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const names = new Set(entries.map((e) => e.name));
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          // MailData holds the Envelope Index and friends, never messages.
          if (!(dir === this.versionDir && e.name === "MailData")) this.stack.push(full);
          continue;
        }
        const id = messageIdFromFilename(e.name);
        if (id === null || this.seen.has(id)) continue;
        // A full download wins over a partial one of the same message.
        if (e.name.endsWith(".partial.emlx") && names.has(`${id}.emlx`)) continue;
        let st;
        try {
          st = statSync(full);
        } catch {
          continue; // vanished between readdir and stat
        }
        this.seen.add(id);
        onFile(id, full, Math.floor(st.mtimeMs), st.size);
      }
    }
    return this.stack.length === 0;
  }

  /** Ids found on disk by the finished walk. */
  has(id: number): boolean {
    return this.seen.has(id);
  }
}

/**
 * The index file, opened read-write by the writer instance: schema and
 * migrations, the store walk, and indexing. Readers never construct one.
 */
export class BodyIndexWriter {
  readonly db: SqliteDatabase;
  private walk: StoreWalk | null = null;
  private lastWalkDone = 0;
  /** Set when this open rebuilt the file; surfaced once in diagnostics. */
  readonly rebuilt: string | null;

  private constructor(
    readonly versionDir: string,
    readonly path: string,
    db: SqliteDatabase,
    rebuilt: string | null,
    private readonly clock: Clock
  ) {
    this.db = db;
    this.rebuilt = rebuilt;
  }

  /**
   * Open (creating if needed) the index at `path`. Refuses a file that isn't
   * ours; rebuilds one of ours that is corrupt or has an older layout.
   */
  static open(
    versionDir: string,
    path: string,
    sqlite: SqliteModule,
    clock: Clock = realClock
  ): BodyIndexWriter | { reason: string } {
    const unsupported = fts5Unsupported(sqlite);
    if (unsupported) return { reason: unsupported };
    const what = inspectIndexFile(path);
    if (what === "foreign") {
      return {
        reason: `${path} exists and is not an apple-mail-mcp body index; leaving it untouched (set APPLE_MAIL_MCP_BODY_INDEX_FILE to another path)`,
      };
    }
    ensurePrivateDir(dirname(path));
    let rebuilt: string | null = null;
    const tryOpen = (): SqliteDatabase => {
      ensurePrivateFile(path);
      const db = new sqlite.DatabaseSync(path);
      try {
        // Readers search while the writer writes; wait for a lock briefly
        // instead of failing on the moments they overlap.
        db.exec(`PRAGMA busy_timeout = 5000`);
        // Touches the header and schema, so a damaged file throws here.
        db.prepare(`SELECT count(*) FROM sqlite_master`).get();
        return db;
      } catch (err) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        throw err;
      }
    };
    let db: SqliteDatabase;
    try {
      db = tryOpen();
    } catch (err) {
      // The header said it's ours (or it was empty), so it is safe to replace.
      rebuilt = `unreadable index file (${err instanceof Error ? err.message : String(err)})`;
      removeIndexFiles(path);
      try {
        db = tryOpen();
      } catch (err2) {
        return {
          reason: `body index could not be created: ${err2 instanceof Error ? err2.message : String(err2)}`,
        };
      }
    }
    try {
      const version = Number(db.prepare(`PRAGMA user_version`).get()?.user_version ?? 0);
      if (what === "ours" && version !== BODY_INDEX_SCHEMA_VERSION) {
        rebuilt ??= `schema v${version} → v${BODY_INDEX_SCHEMA_VERSION}`;
        db.exec(
          `DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS bodies; DROP TABLE IF EXISTS meta;`
        );
      }
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA application_id = ${BODY_INDEX_APPLICATION_ID};
        ${SCHEMA_SQL}
        PRAGMA user_version = ${BODY_INDEX_SCHEMA_VERSION};
      `);
      privateSidecars(path);
      const w = new BodyIndexWriter(versionDir, path, db, rebuilt, clock);
      if (rebuilt) w.setMeta("lastRebuild", `${new Date(clock.now()).toISOString()} (${rebuilt})`);
      return w;
    } catch (err) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      return {
        reason: `body index could not be opened: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  setMeta(key: keyof IndexMeta, value: string | number): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, String(value));
  }

  /** Whether a full walk is running. */
  get walking(): boolean {
    return this.walk !== null;
  }

  /** Whether a full walk is due (`intervalMs` since the last one finished, or never ran). */
  walkDue(intervalMs: number): boolean {
    return (
      this.walk === null &&
      (this.lastWalkDone === 0 || this.clock.now() - this.lastWalkDone >= intervalMs)
    );
  }

  /** Start a full walk now (no-op while one is running). */
  startWalk(): void {
    this.walk ??= new StoreWalk(this.versionDir);
  }

  /**
   * Run the current walk for up to `budgetMs`. Returns true when it finished
   * in this slice (and the cleanup of vanished files ran).
   */
  walkStep(budgetMs: number): boolean {
    const walk = this.walk;
    if (!walk) return false;
    const t0 = this.clock.monotonic();
    const get = this.prep(`SELECT path, mtime, size FROM docs WHERE id = ?`);
    const queue = this.prep(
      `INSERT INTO docs (id, path, mtime, size, state) VALUES (?, ?, ?, ?, ${DocState.queued})
       ON CONFLICT(id) DO UPDATE SET path = excluded.path, mtime = excluded.mtime,
         size = excluded.size, state = ${DocState.queued}`
    );
    let finished: boolean;
    this.db.exec("BEGIN");
    try {
      finished = walk.step(t0 + budgetMs, this.clock, (id, path, mtime, size) => {
        const known = get.get(id);
        if (
          !known ||
          String(known.path) !== path ||
          Number(known.mtime) !== mtime ||
          Number(known.size) !== size
        ) {
          queue.run(id, path, mtime, size);
        }
      });
      if (finished) this.dropMissing(walk);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    walk.workMs += this.clock.monotonic() - t0;
    if (finished) {
      this.walk = null;
      this.lastWalkDone = this.clock.now();
      this.setMeta("lastFullWalk", new Date(this.lastWalkDone).toISOString());
      this.setMeta("lastWalkMs", Math.round(walk.workMs));
      this.setMeta("lastWalkFiles", walk.files);
    }
    return finished;
  }

  private dropMissing(walk: StoreWalk): void {
    const gone: number[] = [];
    for (const r of this.prep(`SELECT id FROM docs`).all()) {
      const id = Number(r.id);
      if (!walk.has(id)) gone.push(id);
    }
    if (gone.length === 0) return;
    const delDoc = this.prep(`DELETE FROM docs WHERE id = ?`);
    const delBody = this.deleteBodyStatement();
    for (const id of gone) {
      delDoc.run(id);
      delBody.run(id);
    }
  }

  private deleteBodyStatement() {
    return this.prep(`DELETE FROM bodies WHERE rowid = ?`);
  }

  /**
   * Prepare a statement that reads integers as BigInt. FTS5's own writes can
   * leave the connection's last-insert rowid above 2^53, and from then on
   * node:sqlite's `run()` throws while reporting it — on any statement, not
   * just the one that caused it. Every value read here goes through Number()
   * or String(), which take a BigInt.
   */
  private prep(sql: string) {
    const s = this.db.prepare(sql);
    s.setReadBigInts(true);
    return s;
  }

  /** Whether any message is waiting to be indexed. */
  hasQueued(): boolean {
    return (
      this.prep(`SELECT 1 AS x FROM docs WHERE state = ${DocState.queued} LIMIT 1`).get() !==
      undefined
    );
  }

  /**
   * Index queued messages, newest id first, until `budgetMs` has passed.
   * Returns how many were processed. A file that can't be read or carries no
   * text is still marked done, so it isn't retried on every step.
   */
  indexStep(budgetMs: number): number {
    const deadline = this.clock.monotonic() + budgetMs;
    const next = this.prep(
      `SELECT id, path FROM docs WHERE state = ${DocState.queued} ORDER BY id DESC LIMIT ${INDEX_BATCH}`
    );
    const setState = this.prep(`UPDATE docs SET state = ? WHERE id = ?`);
    const delBody = this.deleteBodyStatement();
    const addBody = this.prep(`INSERT INTO bodies (rowid, body) VALUES (?, ?)`);
    let done = 0;
    while (this.clock.monotonic() < deadline) {
      const batch = next.all();
      if (batch.length === 0) break;
      this.db.exec("BEGIN");
      try {
        for (const r of batch) {
          // At least one message per slice, so a slice always makes progress.
          if (done > 0 && this.clock.monotonic() >= deadline) break;
          const id = Number(r.id);
          const path = String(r.path);
          const read = readEmlxCapped(path);
          delBody.run(id);
          if (read === "tooLarge") {
            setState.run(DocState.tooLarge, id);
          } else {
            const text = read === null ? null : parseEmlxBody(read);
            if (text) addBody.run(id, text.slice(0, MAX_BODY_CHARS));
            // A partial download without its text was not really searched.
            const bodyMissing = !text && path.endsWith(".partial.emlx");
            const state =
              text && text.length > MAX_BODY_CHARS
                ? DocState.truncated
                : bodyMissing
                  ? DocState.partial
                  : DocState.indexed;
            setState.run(state, id);
          }
          done++;
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
    return done;
  }

  /**
   * Apply changes reported for individual `.emlx` paths (from the file
   * watcher), without a walk. A path that exists is queued if new or changed;
   * a path that is gone drops its row if the row still points there (a moved
   * message keeps its id and is queued again from its new path by its own
   * event, whichever event comes first). A `.partial` file is ignored while
   * the full file for the same id exists.
   */
  applyChanges(paths: Iterable<string>): void {
    const get = this.prep(`SELECT path, mtime, size FROM docs WHERE id = ?`);
    const queue = this.prep(
      `INSERT INTO docs (id, path, mtime, size, state) VALUES (?, ?, ?, ?, ${DocState.queued})
       ON CONFLICT(id) DO UPDATE SET path = excluded.path, mtime = excluded.mtime,
         size = excluded.size, state = ${DocState.queued}`
    );
    const delDoc = this.prep(`DELETE FROM docs WHERE id = ?`);
    const delBody = this.deleteBodyStatement();
    this.db.exec("BEGIN");
    try {
      for (const path of paths) {
        const name = basename(path);
        const id = messageIdFromFilename(name);
        if (id === null) continue;
        let st;
        try {
          st = statSync(path);
        } catch {
          st = null;
        }
        const known = get.get(id);
        if (!st) {
          if (known && String(known.path) === path) {
            delDoc.run(id);
            delBody.run(id);
          }
          continue;
        }
        if (name.endsWith(".partial.emlx") && existsSync(join(dirname(path), `${id}.emlx`))) {
          continue; // the full file wins
        }
        const mtime = Math.floor(st.mtimeMs);
        if (
          known &&
          String(known.path) === path &&
          Number(known.mtime) === mtime &&
          Number(known.size) === st.size
        ) {
          continue;
        }
        queue.run(id, path, mtime, st.size);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Counts and meta as stored. */
  state(): { counts: IndexCounts; meta: IndexMeta } {
    return readIndexState(this.db);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore close errors */
    }
  }
}

/** One read buffer, reused for every file, so indexing doesn't churn the allocator. */
const READ_BUFFER_BYTES = 1024 * 1024;
let readBuffer: Buffer = Buffer.allocUnsafe(0);

/**
 * Read an `.emlx` file, but never one above the size cap: the size is checked
 * on the open descriptor, so a file that grew since the walk is still refused.
 * The bytes live in a buffer shared across calls — parse them before the next
 * read. After an unusually large file the buffer goes back to 1 MB. Null when
 * the file can't be read.
 */
function readEmlxCapped(path: string): Buffer | "tooLarge" | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_EMLX_BYTES) return "tooLarge";
    let buf = readBuffer;
    if (buf.length < size) {
      buf = Buffer.allocUnsafe(Math.max(size, READ_BUFFER_BYTES));
      // Keep a 1 MB buffer around; a larger one is used once and dropped.
      if (buf.length === READ_BUFFER_BYTES) readBuffer = buf;
    }
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
