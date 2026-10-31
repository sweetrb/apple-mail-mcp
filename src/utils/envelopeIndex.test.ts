import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  checkSchema,
  containsGlob,
  envelopeIndexClosed,
  isEnvelopeIndexEnabled,
  isTruthyFlag,
  likePattern,
  needsUnicodeCaseFold,
  parseMailboxUrl,
  readMessageFromStore,
  resolveMailStore,
  searchEnvelopeIndex,
  searchOpenIndex,
  type EnvelopeSearchParams,
  type SchemaFeatures,
} from "@/utils/envelopeIndex.js";
import {
  buildEnvelopeIndex,
  plainMessage,
  sqlite,
  writeEmlx,
  type FixtureMessage,
} from "@/utils/envelopeIndex.testFixture.js";

/** Skip, rather than fail, where node:sqlite is missing — as the module degrades. */
const describeIfSqlite = sqlite ? describe : describe.skip;

const DAY = 86_400;
/** 2026-03-10T12:00:00Z */
const T0 = Date.UTC(2026, 2, 10, 12) / 1000;

const GMAIL = "GMAIL-ACCOUNT-ID";
const WORK = "EWS-WORK-ID";

const MESSAGES: FixtureMessage[] = [
  {
    id: 101,
    account: GMAIL,
    mailbox: "[Gmail]/All Mail",
    labels: ["INBOX"],
    subject: "Quarterly invoice",
    address: "billing@acme.com",
    name: "Acme Billing",
    received: T0,
    sent: T0 - 60,
    read: false,
    attachments: ["invoice.pdf"],
  },
  {
    id: 102,
    account: GMAIL,
    mailbox: "[Gmail]/All Mail",
    labels: ["INBOX", "Receipts"],
    subject: "Your receipt",
    subjectPrefix: "Re: ",
    address: "store@shop.example",
    received: T0 - DAY,
    read: true,
    flagged: true,
  },
  {
    id: 103,
    account: GMAIL,
    mailbox: "[Gmail]/Sent Mail",
    subject: "100% done_final",
    address: "me@gmail.com",
    name: "Me",
    received: T0 - 2 * DAY,
    read: true,
  },
  {
    id: 104,
    account: GMAIL,
    mailbox: "[Gmail]/All Mail",
    labels: ["INBOX"],
    subject: "Deleted invoice",
    address: "billing@acme.com",
    received: T0 + DAY,
    deleted: true,
  },
  {
    id: 201,
    account: WORK,
    mailbox: "Inbox",
    subject: "Invoice approval",
    address: "boss@work.example",
    name: "The Boss",
    received: T0 - 3 * DAY,
  },
  {
    id: 202,
    account: WORK,
    mailbox: "Projects/Receipts",
    subject: "Team lunch",
    address: "hr@work.example",
    received: T0 - 4 * DAY,
  },
];

function params(p: Partial<EnvelopeSearchParams>): EnvelopeSearchParams {
  return { accountId: GMAIL, limit: 50, ...p };
}

describe("isTruthyFlag / isEnvelopeIndexEnabled", () => {
  it("accepts the usual truthy spellings, case-insensitively", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " on "]) expect(isTruthyFlag(v)).toBe(true);
  });

  it("treats anything else, and unset, as off", () => {
    for (const v of [undefined, "", "0", "false", "no", "enabled"]) {
      expect(isTruthyFlag(v)).toBe(false);
    }
  });

  it("reads APPLE_MAIL_MCP_ENVELOPE_INDEX", () => {
    expect(isEnvelopeIndexEnabled({ APPLE_MAIL_MCP_ENVELOPE_INDEX: "1" })).toBe(true);
    expect(isEnvelopeIndexEnabled({})).toBe(false);
  });
});

describe("parseMailboxUrl", () => {
  it("splits an IMAP URL into account id and path", () => {
    expect(parseMailboxUrl("imap://ABC-123/INBOX")).toEqual({
      accountId: "ABC-123",
      path: "INBOX",
    });
  });

  it("percent-decodes nested Gmail paths", () => {
    expect(parseMailboxUrl("imap://G/%5BGmail%5D/All%20Mail")).toEqual({
      accountId: "G",
      path: "[Gmail]/All Mail",
    });
  });

  it("handles Exchange URLs and trailing slashes", () => {
    expect(parseMailboxUrl("ews://W/Sent%20Items/")).toEqual({
      accountId: "W",
      path: "Sent Items",
    });
  });

  it("keeps a path that isn't valid percent-encoding as-is", () => {
    expect(parseMailboxUrl("imap://A/100%")?.path).toBe("100%");
  });

  it("rejects strings that aren't URLs", () => {
    expect(parseMailboxUrl("INBOX")).toBeNull();
    expect(parseMailboxUrl("")).toBeNull();
  });
});

describe("likePattern", () => {
  it("lowercases and wraps in %", () => {
    expect(likePattern("Invoice")).toBe("%invoice%");
  });

  it("escapes LIKE wildcards and the escape character", () => {
    expect(likePattern("100%_a\\b")).toBe("%100\\%\\_a\\\\b%");
  });
});

describe("needsUnicodeCaseFold", () => {
  it("is true only for a letter outside ASCII that has case forms", () => {
    for (const t of ["über", "CAFÉ", "Ελλάδα", "Привет", "ß2", "İ"])
      expect(needsUnicodeCaseFold(t)).toBe(true);
    for (const t of ["Invoice 100%", "明天", "🎉", ""]) expect(needsUnicodeCaseFold(t)).toBe(false);
  });
});

describe("containsGlob", () => {
  it("turns every cased character into a class of its case forms", () => {
    expect(containsGlob("Ab1")).toBe("*[Aa][bB]1*");
    expect(containsGlob("ü")).toBe("*[üÜ]*");
    expect(containsGlob("Σ")).toBe("*[Σςσ]*");
  });

  it("matches GLOB's own wildcards literally and leaves LIKE's alone", () => {
    expect(containsGlob("*?[")).toBe("*[*][?][[]*");
    expect(containsGlob("100%_")).toBe("*100%_*");
  });

  it("pairs every case form of a letter, not only one upper and one lower", () => {
    expect(containsGlob("ß")).toBe("*[ßẞ]*"); // its upper case is "SS", yet ẞ lowers to it
    expect(containsGlob("ς")).toBe("*[ςΣσ]*"); // final sigma
    expect(containsGlob("İ")).toBe("*[İIiı]*"); // lowers to i + a combining dot
    expect(containsGlob("ǅ")).toBe("*[ǅǄǆ]*"); // a titlecase digraph
    expect(containsGlob("\u{10400}")).toBe("*[\u{10400}\u{10428}]*"); // Deseret, past the BMP
  });

  it("pairs an ASCII letter with its other ASCII case only, as LIKE does", () => {
    expect(containsGlob("ks")).toBe("*[kK][sS]*"); // not the Kelvin sign or long s
  });
});

describe("resolveMailStore", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mailstore-test-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("returns null for an unreadable or missing root (no Full Disk Access)", () => {
    expect(resolveMailStore(join(root, "does-not-exist"))).toBeNull();
  });

  it("picks the newest V<N> that has an Envelope Index", () => {
    for (const v of ["V9", "V10", "V11"]) mkdirSync(join(root, v, "MailData"), { recursive: true });
    writeFileSync(join(root, "V9", "MailData", "Envelope Index"), "");
    writeFileSync(join(root, "V10", "MailData", "Envelope Index"), "");
    // V11 exists but has no index yet (e.g. mid-migration) — skipped.
    mkdirSync(join(root, "NotAVersion"), { recursive: true });
    expect(resolveMailStore(root)).toEqual({
      versionDir: join(root, "V10"),
      indexPath: join(root, "V10", "MailData", "Envelope Index"),
    });
  });
});

describeIfSqlite("checkSchema", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "envidx-schema-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reports the optional features of a full schema", () => {
    const path = join(dir, "full");
    buildEnvelopeIndex(path, MESSAGES);
    const db = new sqlite!.DatabaseSync(path, { readOnly: true });
    expect(checkSchema(db)).toEqual({
      labels: true,
      subjectPrefix: true,
      dateSent: true,
      attachments: true,
    });
    db.close();
  });

  it("detects a store without Gmail labels or subject prefixes", () => {
    const path = join(dir, "plain");
    buildEnvelopeIndex(path, MESSAGES, { labels: false, subjectPrefix: false });
    const db = new sqlite!.DatabaseSync(path, { readOnly: true });
    const f = checkSchema(db) as SchemaFeatures;
    expect(f.labels).toBe(false);
    expect(f.subjectPrefix).toBe(false);
    db.close();
  });

  it("names a missing table", () => {
    const path = join(dir, "notable");
    const db = new sqlite!.DatabaseSync(path);
    db.exec(`
      CREATE TABLE messages (subject, sender, mailbox, date_received, read, flagged, deleted);
    `);
    expect(checkSchema(db)).toEqual({ mismatch: 'table "subjects" not found' });
    db.close();
  });

  it("names missing columns", () => {
    const path = join(dir, "nocol");
    const db = new sqlite!.DatabaseSync(path);
    db.exec(`
      CREATE TABLE messages (subject INTEGER, sender INTEGER, mailbox INTEGER, date_received INTEGER);
    `);
    expect(checkSchema(db)).toEqual({
      mismatch: 'table "messages" lacks column(s) read, flagged, deleted',
    });
    db.close();
  });
});

describeIfSqlite("searchOpenIndex", () => {
  let dir: string;
  let db: InstanceType<NonNullable<typeof sqlite>["DatabaseSync"]>;
  let features: SchemaFeatures;
  const ids = (p: Partial<EnvelopeSearchParams>) => {
    const r = searchOpenIndex(db, features, params(p));
    if (!r.ok) throw new Error(r.reason);
    return r.rows.map((row) => row.id);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "envidx-search-"));
    const path = join(dir, "Envelope Index");
    buildEnvelopeIndex(path, MESSAGES, { extraMailboxes: [`${WORK}/Archive/Receipts`] });
    db = new sqlite!.DatabaseSync(path, { readOnly: true });
    features = checkSchema(db) as SchemaFeatures;
  });
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns only the account's messages, newest first, excluding deleted ones", () => {
    expect(ids({})).toEqual([101, 102, 103]);
    expect(ids({ accountId: WORK })).toEqual([201, 202]);
  });

  it("honours limit", () => {
    expect(ids({ limit: 2 })).toEqual([101, 102]);
  });

  it("matches query against the subject or the sender", () => {
    expect(ids({ query: "invoice" })).toEqual([101]);
    expect(ids({ query: "acme billing" })).toEqual([101]);
    expect(ids({ query: "shop.example" })).toEqual([102]);
  });

  it("matches the stored subject prefix as part of the subject", () => {
    expect(ids({ subject: "re: your" })).toEqual([102]);
  });

  it("filters by subject and by from (display name + address) independently", () => {
    expect(ids({ subject: "receipt" })).toEqual([102]);
    expect(ids({ from: "<billing@acme.com>" })).toEqual([101]);
    expect(ids({ subject: "receipt", from: "acme" })).toEqual([]);
  });

  it("takes LIKE wildcards in user text literally", () => {
    expect(ids({ subject: "100%" })).toEqual([103]);
    expect(ids({ subject: "done_final" })).toEqual([103]);
    expect(ids({ subject: "%" })).toEqual([103]);
    expect(ids({ subject: "e_f" })).toEqual([103]);
  });

  it("filters by read and flagged state", () => {
    expect(ids({ isRead: false })).toEqual([101]);
    expect(ids({ isRead: true })).toEqual([102, 103]);
    expect(ids({ isFlagged: true })).toEqual([102]);
  });

  it("treats a date-only dateTo as the end of that (local) day", () => {
    const yesterday = new Date((T0 - DAY) * 1000);
    const dateOnly = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
    expect(ids({ dateTo: dateOnly })).toEqual([102, 103]);
  });

  it("treats a date-only dateFrom as the start of that (local) day", () => {
    const yesterday = new Date((T0 - DAY) * 1000);
    const dateOnly = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
    expect(ids({ dateFrom: dateOnly })).toEqual([101, 102]);
    expect(ids({ dateFrom: new Date((T0 - DAY) * 1000).toISOString() })).toEqual([101, 102]);
  });

  it("accepts the long date form the tool schema documents", () => {
    const d = new Date((T0 - DAY) * 1000);
    const long = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    expect(ids({ dateFrom: long, dateTo: long })).toEqual([102]);
  });

  it("finds Gmail messages in a label mailbox through the labels table", () => {
    expect(ids({ mailbox: "INBOX" })).toEqual([101, 102]);
    expect(ids({ mailbox: "Receipts" })).toEqual([102]);
  });

  it("reports the scoped mailbox for a label hit, and the real one otherwise", () => {
    const scoped = searchOpenIndex(db, features, params({ mailbox: "inbox" }));
    expect(scoped.ok && scoped.rows.map((r) => r.mailbox)).toEqual(["INBOX", "INBOX"]);
    const all = searchOpenIndex(db, features, params({}));
    expect(all.ok && all.rows[0].mailbox).toBe("[Gmail]/All Mail");
  });

  it("matches a full nested path exactly, case-insensitively", () => {
    expect(ids({ accountId: WORK, mailbox: "projects/receipts" })).toEqual([202]);
    expect(ids({ mailbox: "[gmail]/sent mail" })).toEqual([103]);
  });

  it("matches a unique leaf name", () => {
    expect(ids({ mailbox: "Sent Mail" })).toEqual([103]);
  });

  it("refuses an ambiguous leaf name instead of guessing", () => {
    const r = searchOpenIndex(db, features, params({ accountId: WORK, mailbox: "Receipts" }));
    expect(r).toEqual({
      ok: false,
      reason: expect.stringContaining('mailbox "Receipts" is ambiguous'),
    });
  });

  it("reports an unknown mailbox rather than returning an empty result", () => {
    const r = searchOpenIndex(db, features, params({ mailbox: "Nope" }));
    expect(r.ok).toBe(false);
  });

  it("does not let one account's mailbox name match another account", () => {
    const r = searchOpenIndex(db, features, params({ mailbox: "Projects/Receipts" }));
    expect(r.ok).toBe(false);
  });

  it("restricts to given row ids (body-search hits) on top of the filters", () => {
    expect(ids({ rowIds: [102, 103, 201] })).toEqual([102, 103]);
    expect(ids({ rowIds: [102, 103], isFlagged: true })).toEqual([102]);
    expect(ids({ rowIds: [] })).toEqual([]);
  });

  it("builds the row: sender string, dates, flags, attachments", () => {
    const r = searchOpenIndex(db, features, params({ query: "invoice" }));
    expect(r.ok).toBe(true);
    const row = r.ok ? r.rows[0] : undefined;
    expect(row).toEqual({
      id: 101,
      subject: "Quarterly invoice",
      sender: "Acme Billing <billing@acme.com>",
      senderName: "Acme Billing",
      dateReceived: new Date(T0 * 1000),
      dateSent: new Date((T0 - 60) * 1000),
      isRead: false,
      isFlagged: false,
      mailbox: "[Gmail]/All Mail",
      hasAttachments: true,
    });
  });

  it("uses the bare address when there is no display name", () => {
    const r = searchOpenIndex(db, features, params({ query: "receipt" }));
    expect(r.ok && r.rows[0].sender).toBe("store@shop.example");
    expect(r.ok && "senderName" in r.rows[0]).toBe(false);
  });
});

describeIfSqlite("searchOpenIndex: text the index must match like AppleScript does", () => {
  const INTL = "INTL-ACCOUNT-ID";
  const NFD_MAILBOX = "Bu\u0308ro"; // "Büro" as macOS file names spell it
  let dir: string;
  let db: InstanceType<NonNullable<typeof sqlite>["DatabaseSync"]>;
  let features: SchemaFeatures;
  const search = (p: Partial<EnvelopeSearchParams>) =>
    searchOpenIndex(db, features, { accountId: INTL, limit: 50, ...p });
  const ids = (p: Partial<EnvelopeSearchParams>) => {
    const r = search(p);
    if (!r.ok) throw new Error(r.reason);
    return r.rows.map((row) => row.id);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "envidx-intl-"));
    const path = join(dir, "Envelope Index");
    const base = { account: INTL, mailbox: "INBOX", address: "x@example.com", received: T0 };
    buildEnvelopeIndex(path, [
      { ...base, id: 1, subject: "Über das Projekt" },
      { ...base, id: 2, subject: "CAFÉ menu", name: "JOSÉ García", received: T0 - 1 },
      { ...base, id: 3, subject: "ΕΛΛΗΝΙΚΆ νέα", received: T0 - 2 },
      { ...base, id: 4, subject: "[URGENT] *action* needed?", received: T0 - 3 },
      { ...base, id: 5, subject: "axb", mailbox: NFD_MAILBOX, received: T0 - 4 },
      { ...base, id: 6, subject: "GROẞE STRAẞE", received: T0 - 5 },
      { ...base, id: 7, subject: "ΟΔΟΣ ΑΘΗΝΩΝ", received: T0 - 6 },
      { ...base, id: 8, subject: "istanbul trip", received: T0 - 7 },
    ]);
    db = new sqlite!.DatabaseSync(path, { readOnly: true });
    features = checkSchema(db) as SchemaFeatures;
  });
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores case outside ASCII too (SQLite's LIKE folds ASCII only)", () => {
    expect(ids({ query: "über" })).toEqual([1]);
    expect(ids({ subject: "ÜBER DAS" })).toEqual([1]);
    expect(ids({ subject: "café" })).toEqual([2]);
    expect(ids({ subject: "ελληνικά" })).toEqual([3]);
    expect(ids({ from: "josé garcía" })).toEqual([2]);
    expect(ids({ query: "projekt" })).toEqual([1]);
  });

  it("matches letters whose case forms aren't one upper and one lower", () => {
    expect(ids({ subject: "straße" })).toEqual([6]);
    expect(ids({ subject: "οδος" })).toEqual([7]); // final sigma against Σ
    expect(ids({ subject: "İstanbul" })).toEqual([8]);
  });

  it("takes GLOB wildcards in user text literally, on the GLOB path too", () => {
    expect(ids({ subject: "über da?" })).toEqual([]);
    expect(ids({ subject: "über da*" })).toEqual([]);
    expect(ids({ subject: "über [d]" })).toEqual([]);
    expect(ids({ subject: "über das" })).toEqual([1]);
  });

  it("takes wildcards in plain ASCII text literally", () => {
    expect(ids({ subject: "[urgent]" })).toEqual([4]);
    expect(ids({ subject: "*action*" })).toEqual([4]);
    expect(ids({ subject: "?" })).toEqual([4]);
    expect(ids({ subject: "a?b" })).toEqual([]);
    expect(ids({ subject: "a*b" })).toEqual([]);
  });

  it("finds a mailbox stored in another Unicode normalization", () => {
    expect(ids({ mailbox: "Büro" })).toEqual([5]);
    expect(ids({ mailbox: "BÜRO" })).toEqual([5]);
  });

  it("refuses a filter it would answer wrongly instead of returning nothing", () => {
    expect(search({ query: "a\u0000b" })).toEqual({
      ok: false,
      reason: "a text filter contains a NUL character",
    });
    expect(search({ dateFrom: "not a date" })).toEqual({
      ok: false,
      reason: "unreadable date filter",
    });
    expect(search({ dateTo: "also not a date" })).toMatchObject({ ok: false });
  });
});

describeIfSqlite("searchEnvelopeIndex", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "envidx-open-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("searches a database on disk end to end", () => {
    const path = join(dir, "ok");
    buildEnvelopeIndex(path, MESSAGES);
    const r = searchEnvelopeIndex(params({ query: "invoice" }), { indexPath: path });
    expect(r.ok && r.rows.map((x) => x.id)).toEqual([101]);
  });

  it("falls back when node:sqlite is unavailable", () => {
    expect(searchEnvelopeIndex(params({}), { indexPath: "x", sqlite: null })).toEqual({
      ok: false,
      reason: expect.stringContaining("node:sqlite unavailable"),
    });
  });

  it("falls back on a schema it doesn't recognise", () => {
    const path = join(dir, "odd");
    const db = new sqlite!.DatabaseSync(path);
    db.exec(`CREATE TABLE something_else (x)`);
    db.close();
    expect(searchEnvelopeIndex(params({}), { indexPath: path })).toEqual({
      ok: false,
      reason: expect.stringContaining("unexpected Envelope Index schema"),
    });
  });

  it("falls back when the file can't be opened", () => {
    const r = searchEnvelopeIndex(params({}), { indexPath: join(dir, "missing", "db") });
    expect(r.ok).toBe(false);
  });

  // #342 review: a corrupt or half-written index takes the same fallback as a
  // schema mismatch: an ok:false outcome the caller turns into the AppleScript scan.
  it("falls back on a file that isn't a SQLite database", () => {
    const path = join(dir, "garbage");
    writeFileSync(path, Buffer.alloc(8192, 0x5a));
    const r = searchEnvelopeIndex(params({ query: "invoice" }), { indexPath: path });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("Envelope Index") });
  });

  it("falls back on a truncated database instead of returning partial rows", () => {
    const full = join(dir, "full");
    buildEnvelopeIndex(full, MESSAGES);
    const bytes = readFileSync(full);
    const pageSize = bytes.readUInt16BE(16) || 65536;
    const path = join(dir, "truncated");
    writeFileSync(path, bytes.subarray(0, pageSize));
    const r = searchEnvelopeIndex(params({ query: "invoice" }), { indexPath: path });
    expect(r.ok).toBe(false);
  });

  it("falls back while another connection holds the write lock (Mail mid-write)", () => {
    const path = join(dir, "busy");
    buildEnvelopeIndex(path, MESSAGES);
    const writer = new sqlite!.DatabaseSync(path);
    writer.exec(`PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE`);
    try {
      const r = searchEnvelopeIndex(params({ query: "invoice" }), { indexPath: path });
      expect(r).toEqual({ ok: false, reason: expect.stringContaining("Envelope Index") });
    } finally {
      writer.exec(`ROLLBACK`);
      writer.close();
    }
  });

  it("falls back on text too long for a SQLite pattern instead of failing or matching nothing", () => {
    const path = join(dir, "long-pattern");
    buildEnvelopeIndex(path, MESSAGES);
    // SQLite refuses LIKE/GLOB patterns over 50,000 bytes; a class per letter grows fast.
    for (const subject of ["ü".repeat(10_000), "a".repeat(60_000)]) {
      expect(searchEnvelopeIndex(params({ subject }), { indexPath: path })).toEqual({
        ok: false,
        reason: expect.stringContaining("pattern too complex"),
      });
    }
  });

  it("leaves a closed WAL index alone rather than create its -wal/-shm in the mail store", () => {
    const path = join(dir, "closed-wal");
    buildEnvelopeIndex(path, MESSAGES);
    const mail = new sqlite!.DatabaseSync(path);
    mail.exec(`PRAGMA journal_mode = WAL`);
    mail.close(); // the last connection to close deletes -wal and -shm, as when Mail quits
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(searchEnvelopeIndex(params({ query: "invoice" }), { indexPath: path })).toEqual({
      ok: false,
      reason: expect.stringContaining("Mail isn't running"),
    });
    expect(existsSync(`${path}-wal`) || existsSync(`${path}-shm`)).toBe(false);
  });

  it("reads a WAL index while Mail has it open", () => {
    const path = join(dir, "open-wal");
    buildEnvelopeIndex(path, MESSAGES);
    const mail = new sqlite!.DatabaseSync(path);
    try {
      mail.exec(`PRAGMA journal_mode = WAL; UPDATE messages SET read = read`);
      expect(envelopeIndexClosed(path)).toBeNull();
      const r = searchEnvelopeIndex(params({ query: "invoice" }), { indexPath: path });
      expect(r.ok && r.rows.map((x) => x.id)).toEqual([101]);
    } finally {
      mail.close();
    }
  });

  it("judges only WAL databases, and lets the open report a file it can't read", () => {
    const path = join(dir, "rollback");
    buildEnvelopeIndex(path, MESSAGES);
    expect(envelopeIndexClosed(path)).toBeNull(); // rollback journal: nothing is created
    expect(envelopeIndexClosed(join(dir, "missing"))).toBeNull();
    const short = join(dir, "short");
    writeFileSync(short, "SQLite");
    expect(envelopeIndexClosed(short)).toBeNull();
  });

  it("never writes to the index", () => {
    const path = join(dir, "ro");
    buildEnvelopeIndex(path, MESSAGES);
    searchEnvelopeIndex(params({ query: "x" }), { indexPath: path });
    const db = new sqlite!.DatabaseSync(path, { readOnly: true });
    expect(db.prepare(`SELECT count(*) AS n FROM messages`).get()).toEqual({ n: 6 });
    db.close();
  });
});

describeIfSqlite("readMessageFromStore", () => {
  let root: string;
  let store: { versionDir: string; indexPath: string };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "envidx-read-"));
    const versionDir = join(root, "V10");
    mkdirSync(join(versionDir, "MailData"), { recursive: true });
    store = { versionDir, indexPath: join(versionDir, "MailData", "Envelope Index") };
    buildEnvelopeIndex(store.indexPath, MESSAGES);
    // 101 lives in Gmail's All Mail (and INBOX via a label); 102 is only
    // partially downloaded; 201 is an Exchange message with an HTML-only body;
    // 103 has no file on disk; 104 is deleted.
    writeEmlx(
      versionDir,
      GMAIL,
      "[Gmail]/All Mail",
      101,
      "Message-ID: <inv-101@acme.com>\r\nSubject: Quarterly invoice\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nAmount due: $40.\r\nThanks!\r\n"
    );
    writeEmlx(versionDir, GMAIL, "[Gmail]/All Mail", 102, plainMessage("r", "partial body"), {
      partial: true,
    });
    writeEmlx(
      versionDir,
      WORK,
      "Inbox",
      201,
      "Subject: Invoice approval\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Please <b>approve</b></p>"
    );
    writeEmlx(versionDir, GMAIL, "[Gmail]/All Mail", 104, plainMessage("d", "gone"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reads subject, body, Message-ID and dates without AppleScript", () => {
    expect(readMessageFromStore(101, { store })).toEqual({
      subject: "Quarterly invoice",
      plainText: "Amount due: $40.\r\nThanks!\r\n",
      rfcMessageId: "inv-101@acme.com",
      dateSent: new Date((T0 - 60) * 1000),
      dateReceived: new Date(T0 * 1000),
      partial: false,
    });
  });

  it("includes the HTML part only when asked", () => {
    const plain = readMessageFromStore(201, { store });
    expect(plain).toMatchObject({ plainText: "Please approve" });
    expect("htmlContent" in plain).toBe(false);
    const html = readMessageFromStore(201, { store, includeHtml: true });
    expect(html).toMatchObject({ htmlContent: "<p>Please <b>approve</b></p>" });
  });

  it("reads a partially downloaded message and says so", () => {
    expect(readMessageFromStore(102, { store })).toMatchObject({
      subject: "Re: Your receipt",
      plainText: expect.stringContaining("partial body"),
      partial: true,
    });
  });

  it("gives a reason for each case it can't serve, so the caller falls back", () => {
    expect(readMessageFromStore(103, { store })).toEqual({
      reason: expect.stringContaining("no readable .emlx for message 103"),
    });
    expect(readMessageFromStore(104, { store })).toEqual({ reason: "message 104 is deleted" });
    expect(readMessageFromStore(999, { store })).toEqual({
      reason: "message 999 not in the Envelope Index",
    });
    expect(readMessageFromStore(101, { store: null })).toEqual({
      reason: expect.stringContaining("Full Disk Access"),
    });
    expect(readMessageFromStore(101, { store, sqlite: null })).toEqual({
      reason: expect.stringContaining("node:sqlite unavailable"),
    });
  });
});

describeIfSqlite("readMessageFromStore: bodies it must not report as empty", () => {
  const ACC = "READ-ACCOUNT-ID";
  let root: string;
  let store: { versionDir: string; indexPath: string };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "envidx-read-edge-"));
    const versionDir = join(root, "V10");
    mkdirSync(join(versionDir, "MailData"), { recursive: true });
    store = { versionDir, indexPath: join(versionDir, "MailData", "Envelope Index") };
    const base = { account: ACC, mailbox: "INBOX", address: "x@example.com", received: T0 };
    buildEnvelopeIndex(store.indexPath, [
      { ...base, id: 1, subject: "headers only" },
      { ...base, id: 2, subject: "blank plain part" },
      { ...base, id: 3, subject: "partial with text" },
    ]);
    writeEmlx(
      versionDir,
      ACC,
      "INBOX",
      1,
      "Subject: headers only\r\nContent-Type: text/plain\r\n\r\n",
      {
        partial: true,
      }
    );
    writeEmlx(
      versionDir,
      ACC,
      "INBOX",
      2,
      'Subject: blank plain part\r\nContent-Type: multipart/alternative; boundary="b"\r\n\r\n' +
        "--b\r\nContent-Type: text/plain\r\n\r\n \r\n\r\n" +
        "--b\r\nContent-Type: text/html\r\n\r\n<p>The real message</p>\r\n--b--\r\n"
    );
    writeEmlx(versionDir, ACC, "INBOX", 3, plainMessage("p", "text arrived"), { partial: true });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("sends a message with only its headers on disk to AppleScript, which downloads the body", () => {
    expect(readMessageFromStore(1, { store })).toEqual({
      reason: "message 1 is only partly downloaded (no body on disk yet)",
    });
  });

  it("reads the HTML part when the plain part is blank", () => {
    expect(readMessageFromStore(2, { store })).toMatchObject({ plainText: "The real message" });
  });

  it("still reads a partial download that has its text", () => {
    expect(readMessageFromStore(3, { store })).toMatchObject({
      plainText: expect.stringContaining("text arrived"),
      partial: true,
    });
  });

  it("leaves a closed WAL index alone here too", () => {
    const mail = new sqlite!.DatabaseSync(store.indexPath);
    mail.exec(`PRAGMA journal_mode = WAL`);
    mail.close();
    try {
      expect(readMessageFromStore(3, { store })).toEqual({
        reason: expect.stringContaining("Mail isn't running"),
      });
      expect(existsSync(`${store.indexPath}-shm`)).toBe(false);
    } finally {
      const back = new sqlite!.DatabaseSync(store.indexPath);
      back.exec(`PRAGMA journal_mode = DELETE`);
      back.close();
    }
  });
});
