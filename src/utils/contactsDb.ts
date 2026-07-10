/**
 * Contacts database reader.
 *
 * Reads the macOS Contacts (AddressBook) SQLite databases directly, instead of
 * driving Contacts.app via AppleScript. This needs only **Full Disk Access** (a
 * stable TCC grant the Node runtime already holds), and — unlike the AppleScript
 * `tell application "Contacts"` path — raises **no Automation / Apple-Events
 * permission prompt**. On a headless/scheduled host missing that Automation
 * grant, the old path would hang on an unanswerable prompt until timeout; this
 * one just reads the files.
 *
 * Data lives in per-source Core Data ("Z" schema) databases:
 *   ~/Library/Application Support/AddressBook/AddressBook-v22.abcddb              (top-level "On My Mac")
 *   ~/Library/Application Support/AddressBook/Sources/<UUID>/AddressBook-v22.abcddb  (one per account source)
 *
 * @module utils/contactsDb
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Contact } from "@/types.js";

/** Minimal shape of the `node:sqlite` DatabaseSync we rely on. */
interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

/**
 * Lazily load the built-in `node:sqlite` module. Returns `null` (and logs one
 * line to stderr) on Node runtimes where it is absent (< 22.5) or experimental
 * loading throws — callers then return no results rather than falling back to
 * the AppleScript path (which would reintroduce the permission prompt this
 * module exists to avoid).
 */
function loadSqlite(): SqliteModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("node:sqlite") as SqliteModule;
    if (!mod || typeof mod.DatabaseSync !== "function") {
      console.error(
        "[contactsDb] node:sqlite unavailable (no DatabaseSync export); returning no contacts"
      );
      return null;
    }
    return mod;
  } catch (err) {
    console.error(
      `[contactsDb] node:sqlite not available (requires Node >= 22.5); returning no contacts: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

/**
 * Resolve the set of AddressBook SQLite files to scan: the top-level
 * `AddressBook-v22.abcddb` (if present) plus every
 * `Sources/<UUID>/AddressBook-v22.abcddb`.
 */
export function resolveContactsDbPaths(baseDir?: string): string[] {
  const root = baseDir ?? join(homedir(), "Library", "Application Support", "AddressBook");
  const paths: string[] = [];

  const topLevel = join(root, "AddressBook-v22.abcddb");
  if (existsSync(topLevel)) paths.push(topLevel);

  const sourcesDir = join(root, "Sources");
  if (existsSync(sourcesDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(sourcesDir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const candidate = join(sourcesDir, entry, "AddressBook-v22.abcddb");
      if (existsSync(candidate)) paths.push(candidate);
    }
  }

  return paths;
}

const RECORD_SQL = `
  SELECT r.Z_PK pk,
         TRIM(COALESCE(r.ZFIRSTNAME,'')||' '||COALESCE(r.ZLASTNAME,'')) fullname,
         r.ZORGANIZATION org, r.ZNICKNAME nick
  FROM ZABCDRECORD r
  WHERE lower(TRIM(COALESCE(r.ZFIRSTNAME,'')||' '||COALESCE(r.ZLASTNAME,''))) LIKE ?
     OR lower(COALESCE(r.ZORGANIZATION,'')) LIKE ?
     OR lower(COALESCE(r.ZNICKNAME,''))     LIKE ?
     OR r.Z_PK IN (SELECT ZOWNER FROM ZABCDEMAILADDRESS WHERE lower(COALESCE(ZADDRESS,'')) LIKE ?)
`;

const EMAILS_SQL = `SELECT ZADDRESS AS v FROM ZABCDEMAILADDRESS WHERE ZOWNER = ? AND ZADDRESS IS NOT NULL`;
const PHONES_SQL = `SELECT ZFULLNUMBER AS v FROM ZABCDPHONENUMBER WHERE ZOWNER = ? AND ZFULLNUMBER IS NOT NULL`;

function displayName(row: { fullname?: unknown; org?: unknown; nick?: unknown }): string {
  const fullname = typeof row.fullname === "string" ? row.fullname.trim() : "";
  if (fullname) return fullname;
  const org = typeof row.org === "string" ? row.org.trim() : "";
  if (org) return org;
  const nick = typeof row.nick === "string" ? row.nick.trim() : "";
  if (nick) return nick;
  return "(no name)";
}

/** Scan a single AddressBook DB (read-only). Returns [] on any open/query error. */
function searchOneDb(sqlite: SqliteModule, dbPath: string, like: string): Contact[] {
  let db: SqliteDatabase | null = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const records = db.prepare(RECORD_SQL).all(like, like, like, like);
    const emailStmt = db.prepare(EMAILS_SQL);
    const phoneStmt = db.prepare(PHONES_SQL);

    const contacts: Contact[] = [];
    for (const rec of records) {
      const pk = rec.pk as number;
      const emails = emailStmt
        .all(pk)
        .map((r) => r.v)
        .filter((v): v is string => typeof v === "string" && v.length > 0);
      const phones = phoneStmt
        .all(pk)
        .map((r) => r.v)
        .filter((v): v is string => typeof v === "string" && v.length > 0);
      contacts.push({ name: displayName(rec), emails, phones });
    }
    return contacts;
  } catch (err) {
    console.error(
      `[contactsDb] skipping unreadable Contacts DB ${dbPath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore close errors */
    }
  }
}

/**
 * Search the macOS Contacts databases for people whose full name, organization,
 * nickname, or any email address contains `query` (case-insensitive substring).
 *
 * @param query    Search string (a substring match; empty query returns []).
 * @param opts.dbPaths  Explicit DB file paths to scan (tests inject fixtures);
 *                      when omitted, resolves the real AddressBook files.
 * @returns De-duplicated contacts (by name + email set), each with emails/phones.
 */
export function searchContactsDb(query: string, opts?: { dbPaths?: string[] }): Contact[] {
  if (!query || !query.trim()) return [];

  const sqlite = loadSqlite();
  if (!sqlite) return [];

  const dbPaths = opts?.dbPaths ?? resolveContactsDbPaths();
  const like = `%${query.toLowerCase()}%`;

  const seen = new Set<string>();
  const results: Contact[] = [];

  for (const dbPath of dbPaths) {
    for (const contact of searchOneDb(sqlite, dbPath, like)) {
      const key = `${contact.name} ${[...contact.emails].sort().join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(contact);
    }
  }

  return results;
}
