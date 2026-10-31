import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  checkSchema,
  isEnvelopeIndexEnabled,
  isTruthyFlag,
  likePattern,
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

  it.each(["[Gmail]/All Mail", "INBOX"])(
    "reads a scoped message from its physical mailbox or label %s",
    (mailbox) => {
      expect(
        readMessageFromStore(101, { store, scope: { accountId: GMAIL, mailbox } })
      ).toMatchObject({
        rfcMessageId: "inv-101@acme.com",
        plainText: expect.stringContaining("Amount due: $40."),
      });
    }
  );

  it.each([
    { accountId: WORK, mailbox: "Inbox" },
    { accountId: GMAIL, mailbox: "Sent" },
  ])("does not read a file outside requested index scope %j", (scope) => {
    expect(readMessageFromStore(101, { store, scope })).toMatchObject({
      reason: expect.any(String),
    });
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
