/**
 * Body index: schema, ownership, file modes, the indexer, and the query layer
 * as the Envelope Index search uses it. Everything runs on a synthetic temp-dir
 * mail store and a synthetic Envelope Index; nothing touches ~/Library/Mail.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BODY_INDEX_APPLICATION_ID,
  BODY_INDEX_SCHEMA_VERSION,
  BodyIndexWriter,
  MAX_EMLX_BYTES,
  describeScopeGap,
  ftsPhrase,
  fts5Unsupported,
  inspectIndexFile,
  isScopeComplete,
  messageIdFromFilename,
  parseEmlxBody,
} from "@/utils/bodyIndex.js";
import { searchEnvelopeIndex, type SqliteModule } from "@/utils/envelopeIndex.js";
import {
  buildEnvelopeIndex,
  emlx,
  plainMessage,
  sqlite,
  writeEmlx,
  type FixtureMessage,
} from "@/utils/envelopeIndex.testFixture.js";

const describeIfSqlite = sqlite ? describe : describe.skip;

describe("messageIdFromFilename", () => {
  it("reads full and partial .emlx names", () => {
    expect(messageIdFromFilename("12345.emlx")).toBe(12345);
    expect(messageIdFromFilename("12345.partial.emlx")).toBe(12345);
  });
  it("ignores everything else", () => {
    for (const name of ["Info.plist", "12345.eml", "x12.emlx", "12.partial", ".emlx"]) {
      expect(messageIdFromFilename(name)).toBeNull();
    }
  });
});

describe("ftsPhrase", () => {
  it("quotes text as one phrase and doubles embedded quotes", () => {
    expect(ftsPhrase("wire transfer")).toBe('"wire transfer"');
    expect(ftsPhrase('say "hi"')).toBe('"say ""hi"""');
  });
});

describe("parseEmlxBody", () => {
  it("extracts a plain-text body and ignores Mail's plist footer", () => {
    const text = parseEmlxBody(emlx(plainMessage("Hi", "Please wire the deposit today.")));
    expect(text).toBe("Please wire the deposit today.");
    expect(text).not.toMatch(/plist|integer/);
  });

  it("turns an HTML-only body into text, decoding &amp; last", () => {
    const msg =
      "Subject: x\r\nContent-Type: text/html; charset=utf-8\r\n\r\n" +
      "<html><style>p{color:red}</style><body><p>Tracking&nbsp;number <b>ZX-99</b> &amp;lt;ok&amp;gt;</p></body></html>";
    expect(parseEmlxBody(emlx(msg))).toBe("Tracking number ZX-99 &lt;ok&gt;");
  });

  it("prefers the text/plain part of a multipart message", () => {
    const msg = [
      "Subject: x",
      'Content-Type: multipart/alternative; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "plain version",
      "--b1",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>html version</p>",
      "--b1--",
      "",
    ].join("\r\n");
    expect(parseEmlxBody(emlx(msg))).toBe("plain version");
  });

  it("decodes quoted-printable UTF-8", () => {
    const msg =
      "Subject: x\r\nContent-Type: text/plain; charset=utf-8\r\n" +
      "Content-Transfer-Encoding: quoted-printable\r\n\r\nCaf=C3=A9 r=C3=A9serv=C3=A9\r\n";
    expect(parseEmlxBody(emlx(msg))).toBe("Café réservé");
  });

  it("decodes a legacy 8-bit charset (ISO-8859-1) and base64", () => {
    const latin1 =
      "Subject: x\r\nContent-Type: text/plain; charset=iso-8859-1\r\n" +
      "Content-Transfer-Encoding: 8bit\r\n\r\nNa\xefve fa\xe7ade\r\n";
    expect(parseEmlxBody(emlx(latin1))).toBe("Naïve façade");
    const b64 =
      "Subject: x\r\nContent-Type: text/plain; charset=utf-8\r\n" +
      `Content-Transfer-Encoding: base64\r\n\r\n${Buffer.from("Grüße aus Köln").toString("base64")}\r\n`;
    expect(parseEmlxBody(emlx(b64))).toBe("Grüße aus Köln");
  });

  it("returns null for files without the byte-count framing", () => {
    expect(parseEmlxBody(Buffer.from("From: a\r\n\r\nno count line"))).toBeNull();
    expect(parseEmlxBody(Buffer.from(""))).toBeNull();
    expect(parseEmlxBody(Buffer.from("-5\nx"))).toBeNull();
  });

  it("returns null when there is no text at all", () => {
    expect(parseEmlxBody(emlx(plainMessage("x", "   ")))).toBeNull();
  });
});

describe("scope coverage wording", () => {
  it("names only the non-zero gaps", () => {
    const c = { notDownloaded: 1234, notIndexedYet: 0, partlyDownloaded: 2, tooLarge: 1 };
    expect(isScopeComplete(c)).toBe(false);
    expect(describeScopeGap(c)).toBe(
      "1,234 messages not downloaded, 2 with no body downloaded yet, 1 over the 25 MB size cap"
    );
    expect(
      isScopeComplete({ notDownloaded: 0, notIndexedYet: 0, partlyDownloaded: 0, tooLarge: 0 })
    ).toBe(true);
  });
});

describeIfSqlite("fts5Unsupported", () => {
  it("accepts the bundled SQLite", () => {
    expect(fts5Unsupported(sqlite!)).toBeNull();
  });

  it("explains a SQLite without contentless_delete instead of throwing", () => {
    const old: SqliteModule = {
      DatabaseSync: class {
        exec(): void {
          throw new Error("unrecognized option: contentless_delete");
        }
        close(): void {}
      } as unknown as SqliteModule["DatabaseSync"],
    };
    expect(fts5Unsupported(old)).toMatch(/contentless_delete.*3\.43/);
    const r = BodyIndexWriter.open("/nowhere", "/nowhere/body.db", old);
    expect(r).toEqual({ reason: expect.stringMatching(/contentless_delete/) });
    expect(existsSync("/nowhere")).toBe(false);
  });
});

/** Everything the writer does, start to finish, with no time limit. */
function buildAll(w: BodyIndexWriter): void {
  w.startWalk();
  while (!w.walkStep(60_000));
  while (w.indexStep(60_000) > 0);
}

function openWriter(store: string, path: string): BodyIndexWriter {
  const w = BodyIndexWriter.open(store, path, sqlite!);
  if ("reason" in w) throw new Error(w.reason);
  return w;
}

describeIfSqlite("BodyIndexWriter: ownership and file modes", () => {
  let root: string;
  let store: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bodyidx-own-"));
    store = join(root, "V10");
    path = join(root, "support", "body.db");
    writeEmlx(store, "ACC", "INBOX", 1, plainMessage("a", "harbour cruise"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("creates the directory 0700 and the database and its WAL files 0600", () => {
    const w = openWriter(store, path);
    buildAll(w);
    expect(statSync(join(root, "support")).mode & 0o777).toBe(0o700);
    for (const p of [path, `${path}-wal`, `${path}-shm`]) {
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).mode & 0o777).toBe(0o600);
    }
    w.close();
  });

  it("leaves an existing directory's mode alone", () => {
    const dir = join(root, "mine");
    rmSync(dir, { force: true, recursive: true });
    mkdirSync(dir, { mode: 0o755 });
    const w = openWriter(store, join(dir, "body.db"));
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    w.close();
  });

  it("stamps the file with our application_id and schema version", () => {
    openWriter(store, path).close();
    expect(inspectIndexFile(path)).toBe("ours");
    const db = new sqlite!.DatabaseSync(path, { readOnly: true });
    expect(Number(db.prepare("PRAGMA application_id").get()!.application_id)).toBe(
      BODY_INDEX_APPLICATION_ID
    );
    expect(Number(db.prepare("PRAGMA user_version").get()!.user_version)).toBe(
      BODY_INDEX_SCHEMA_VERSION
    );
    db.close();
  });

  it("never touches a SQLite file that isn't ours", () => {
    mkdirSync(join(root, "support"));
    const other = new sqlite!.DatabaseSync(path);
    other.exec("CREATE TABLE precious (x); INSERT INTO precious VALUES ('keep me')");
    other.close();
    const before = readFileSync(path);
    const r = BodyIndexWriter.open(store, path, sqlite!);
    expect(r).toEqual({ reason: expect.stringContaining("not an apple-mail-mcp body index") });
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("never touches a non-SQLite file at the index path", () => {
    mkdirSync(join(root, "support"));
    writeFileSync(path, "my notes, not a database");
    expect(BodyIndexWriter.open(store, path, sqlite!)).toEqual({
      reason: expect.stringContaining("leaving it untouched"),
    });
    expect(readFileSync(path, "utf8")).toBe("my notes, not a database");
  });

  it("rebuilds one of ours with an older schema, and records why", () => {
    openWriter(store, path).close();
    const db = new sqlite!.DatabaseSync(path);
    db.exec("PRAGMA user_version = 1");
    db.close();
    const w = openWriter(store, path);
    expect(w.rebuilt).toBe(`schema v1 → v${BODY_INDEX_SCHEMA_VERSION}`);
    expect(w.state().meta.lastRebuild).toMatch(/schema v1/);
    buildAll(w);
    expect(w.state().counts.indexed).toBe(1);
    w.close();
  });

  it("rebuilds one of ours that is damaged (the header still proves it's ours)", () => {
    const w = openWriter(store, path);
    buildAll(w);
    w.close();
    // Keep the 100-byte header (with our application_id), wreck the rest.
    const bytes = readFileSync(path);
    bytes.fill(0xff, 100);
    writeFileSync(path, bytes);
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    expect(inspectIndexFile(path)).toBe("ours");
    const again = openWriter(store, path);
    expect(again.rebuilt).toMatch(/unreadable index file/);
    buildAll(again);
    expect(again.state().counts.indexed).toBe(1);
    again.close();
  });

  it("starts fresh on an empty file", () => {
    mkdirSync(join(root, "support"));
    writeFileSync(path, "");
    expect(inspectIndexFile(path)).toBe("empty");
    const w = openWriter(store, path);
    expect(w.rebuilt).toBeNull();
    w.close();
  });
});

describeIfSqlite("BodyIndexWriter: walking and indexing", () => {
  let root: string;
  let store: string;
  let path: string;
  let w: BodyIndexWriter;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bodyidx-idx-"));
    store = join(root, "V10");
    path = join(root, "support", "body.db");
    writeEmlx(store, "ACC", "INBOX", 1, plainMessage("a", "Your tracking number is ZX-99."));
    writeEmlx(store, "ACC", "INBOX", 2, plainMessage("b", "Lunch on Friday? Café downstairs."));
    writeEmlx(store, "ACC", "[Gmail]/All Mail", 3, plainMessage("c", "wire transfer"));
    w = openWriter(store, path);
  });
  afterEach(() => {
    w.close();
    rmSync(root, { recursive: true, force: true });
  });

  function bodies(text: string): number[] {
    return w.db
      .prepare("SELECT rowid AS id FROM bodies WHERE bodies MATCH ? ORDER BY rowid")
      .all(ftsPhrase(text))
      .map((r) => Number(r.id));
  }

  it("walks, queues, then indexes; counts move from queued to indexed", () => {
    w.startWalk();
    while (!w.walkStep(60_000));
    expect(w.state().counts).toEqual({ indexed: 0, queued: 3, partial: 0, tooLarge: 0 });
    expect(w.state().meta.lastWalkFiles).toBe(3);
    expect(w.state().meta.lastFullWalk).toBeDefined();
    while (w.indexStep(60_000) > 0);
    expect(w.state().counts).toEqual({ indexed: 3, queued: 0, partial: 0, tooLarge: 0 });
    expect(bodies("cafe")).toEqual([2]);
    expect(bodies("wire transfer")).toEqual([3]);
  });

  it("does nothing with a zero time budget", () => {
    w.startWalk();
    expect(w.walkStep(0)).toBe(false);
    expect(w.walking).toBe(true);
    while (!w.walkStep(60_000));
    expect(w.indexStep(0)).toBe(0);
  });

  it("indexes newest message ids first, one bounded slice at a time", () => {
    w.close();
    // A clock that moves 1 ms each time it is read: a 1.5 ms slice fits one file.
    let t = 0;
    w = BodyIndexWriter.open(store, path, sqlite!, {
      now: () => Date.now(),
      monotonic: () => (t += 1),
    }) as BodyIndexWriter;
    w.startWalk();
    while (!w.walkStep(1e9));
    const order: number[] = [];
    while (w.indexStep(1.5) > 0) {
      for (const r of w.db.prepare("SELECT id FROM docs WHERE state != 0").all()) {
        if (!order.includes(Number(r.id))) order.push(Number(r.id));
      }
    }
    expect(order).toEqual([3, 2, 1]);
  });

  it("stores no copy of the body text, only the search index", () => {
    buildAll(w);
    const raw =
      readFileSync(path).toString("latin1") + readFileSync(`${path}-wal`).toString("latin1");
    expect(raw).not.toContain("Your tracking number is ZX-99");
    expect(bodies("tracking number")).toEqual([1]);
  });

  it("only re-reads files whose (path, size, mtime) changed", () => {
    buildAll(w);
    const changed = join(store, "ACC", "INBOX.mbox", "STORE-UUID", "Data", "Messages", "2.emlx");
    writeFileSync(changed, emlx(plainMessage("b", "Dinner instead")));
    utimesSync(changed, new Date(), new Date(Date.now() + 5_000));
    w.startWalk();
    while (!w.walkStep(60_000));
    expect(w.state().counts.queued).toBe(1);
    while (w.indexStep(60_000) > 0);
    expect(bodies("dinner")).toEqual([2]);
    expect(bodies("lunch")).toEqual([]);
  });

  it("drops a message whose file disappeared, at the end of the next walk", () => {
    buildAll(w);
    unlinkSync(join(store, "ACC", "INBOX.mbox", "STORE-UUID", "Data", "Messages", "1.emlx"));
    w.startWalk();
    while (!w.walkStep(60_000));
    expect(bodies("tracking")).toEqual([]);
    expect(w.state().counts.indexed).toBe(2);
  });

  it("searches a partial download that has its text (only attachments missing)", () => {
    const attachmentsMissing = [
      "Subject: d",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "statement attached",
      "--b",
      "Content-Type: application/pdf",
      "Content-Disposition: attachment; filename=s.pdf",
      "",
      "",
      "--b--",
      "",
    ].join("\r\n");
    writeEmlx(store, "ACC", "INBOX", 4, attachmentsMissing, { partial: true });
    buildAll(w);
    expect(w.state().counts.partial).toBe(0);
    expect(bodies("statement attached")).toEqual([4]);
  });

  it("counts a partial download without body text as not searched, until the full file arrives", () => {
    const headersOnly = "Subject: d\r\nContent-Type: text/plain\r\n\r\n";
    const partial = writeEmlx(store, "ACC", "INBOX", 4, headersOnly, { partial: true });
    buildAll(w);
    expect(w.state().counts.partial).toBe(1);
    writeEmlx(store, "ACC", "INBOX", 4, plainMessage("d", "first half and second half"));
    unlinkSync(partial);
    buildAll(w);
    expect(w.state().counts.partial).toBe(0);
    expect(bodies("second half")).toEqual([4]);
  });

  it("never reads a file above the 25 MB cap, and counts it", () => {
    const big = writeEmlx(store, "ACC", "INBOX", 5, plainMessage("e", "needle in a big file"));
    truncateSync(big, MAX_EMLX_BYTES + 1);
    buildAll(w);
    expect(w.state().counts.tooLarge).toBe(1);
    expect(bodies("needle")).toEqual([]);
  });

  it("records unparseable files as done, so they aren't retried forever", () => {
    const junk = join(store, "ACC", "INBOX.mbox", "STORE-UUID", "Data", "Messages", "6.emlx");
    writeFileSync(junk, "not an emlx file");
    buildAll(w);
    expect(w.state().counts.queued).toBe(0);
    expect(w.indexStep(60_000)).toBe(0);
  });

  it("skips MailData, where the Envelope Index lives", () => {
    const md = join(store, "MailData", "Messages");
    mkdirSync(md, { recursive: true });
    writeFileSync(join(md, "77.emlx"), emlx(plainMessage("x", "not a mailbox")));
    buildAll(w);
    expect(bodies("mailbox")).toEqual([]);
  });

  it("applies a new, a changed and a deleted file reported by path, without a walk", () => {
    buildAll(w);
    const added = writeEmlx(store, "ACC", "INBOX", 8, plainMessage("h", "dentist appointment"));
    w.applyChanges([added]);
    while (w.indexStep(60_000) > 0);
    expect(bodies("dentist")).toEqual([8]);
    unlinkSync(added);
    w.applyChanges([added]);
    expect(bodies("dentist")).toEqual([]);
  });

  it("keeps a moved message, whichever of its two events comes first", () => {
    buildAll(w);
    const from = join(store, "ACC", "INBOX.mbox", "STORE-UUID", "Data", "Messages", "1.emlx");
    const toDir = join(store, "ACC", "Archive.mbox", "STORE-UUID", "Data", "Messages");
    mkdirSync(toDir, { recursive: true });
    const to = join(toDir, "1.emlx");
    renameSync(from, to);
    w.applyChanges([to, from]); // new path first
    while (w.indexStep(60_000) > 0);
    expect(bodies("tracking")).toEqual([1]);
    renameSync(to, from);
    w.applyChanges([to]); // old path first
    w.applyChanges([from]);
    while (w.indexStep(60_000) > 0);
    expect(bodies("tracking")).toEqual([1]);
  });

  it("keeps what it indexed across restarts", () => {
    buildAll(w);
    w.close();
    w = openWriter(store, path);
    expect(w.rebuilt).toBeNull();
    expect(bodies("wire")).toEqual([3]);
  });

  // node:sqlite's run() reports the connection's last-insert rowid as a JS
  // number and throws once it is past 2^53 — which FTS5's own writes can leave
  // behind. That breaks every later run() on the connection, not only the
  // statement that caused it, so every write path must survive it.
  it("keeps writing when the connection's last-insert rowid is past 2^53", () => {
    const poison = () =>
      w.db.exec(
        "CREATE TEMP TABLE IF NOT EXISTS big (x); INSERT INTO big (rowid, x) VALUES (1152921504606846976 + abs(random() % 1000), 1)"
      );
    poison();
    w.startWalk();
    expect(() => {
      while (!w.walkStep(60_000));
    }).not.toThrow();
    poison();
    expect(() => {
      while (w.indexStep(60_000) > 0);
    }).not.toThrow();
    poison();
    const p = join(store, "ACC", "INBOX.mbox", "STORE-UUID", "Data", "Messages", "1.emlx");
    unlinkSync(p);
    expect(() => w.applyChanges([p])).not.toThrow();
    poison();
    const big = writeEmlx(store, "ACC", "INBOX", 9, plainMessage("i", "x"));
    truncateSync(big, MAX_EMLX_BYTES + 1);
    w.applyChanges([big]);
    poison();
    expect(() => w.indexStep(60_000)).not.toThrow();
    poison();
    expect(() => w.setMeta("lastError", "x")).not.toThrow();
  });
});

describeIfSqlite("body search through the Envelope Index (attached read-only)", () => {
  let root: string;
  let store: string;
  let indexPath: string;
  let path: string;
  let w: BodyIndexWriter;

  const messages: FixtureMessage[] = [
    {
      id: 1,
      account: "ACC",
      mailbox: "INBOX",
      subject: "Order",
      address: "shop@x.com",
      received: 1_700_000_100,
    },
    {
      id: 2,
      account: "ACC",
      mailbox: "INBOX",
      subject: "Hi",
      address: "pal@x.com",
      received: 1_700_000_200,
    },
    {
      id: 3,
      account: "ACC",
      mailbox: "Archive",
      subject: "Old",
      address: "shop@x.com",
      received: 1_600_000_000,
    },
    // In the Envelope Index, but Mail never downloaded its body.
    {
      id: 4,
      account: "ACC",
      mailbox: "INBOX",
      subject: "Headers only",
      address: "a@x.com",
      received: 1_700_000_300,
    },
    {
      id: 9,
      account: "OTHER",
      mailbox: "INBOX",
      subject: "Elsewhere",
      address: "z@x.com",
      received: 1_700_000_400,
    },
  ];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bodyidx-query-"));
    store = join(root, "V10");
    mkdirSync(join(store, "MailData"), { recursive: true });
    indexPath = join(store, "MailData", "Envelope Index");
    buildEnvelopeIndex(indexPath, messages);
    writeEmlx(
      store,
      "ACC",
      "INBOX",
      1,
      plainMessage("Order", "your parcel tracking ZX-99 ships today")
    );
    writeEmlx(store, "ACC", "INBOX", 2, plainMessage("Hi", "no parcel here, just lunch"));
    writeEmlx(store, "ACC", "Archive", 3, plainMessage("Old", "an old parcel receipt"));
    writeEmlx(store, "OTHER", "INBOX", 9, plainMessage("x", "parcel for another account"));
    path = join(root, "support", "body.db");
    w = openWriter(store, path);
  });
  afterEach(() => {
    w.close();
    rmSync(root, { recursive: true, force: true });
  });

  const search = (extra: Record<string, unknown> = {}) =>
    searchEnvelopeIndex(
      { accountId: "ACC", limit: 50, body: { text: "parcel", indexFile: path }, ...extra },
      { indexPath, sqlite }
    );

  it("matches bodies, newest first, scoped to the account", () => {
    buildAll(w);
    const r = search();
    expect(r.ok && r.rows.map((m) => m.id)).toEqual([2, 1, 3]);
  });

  it("reports incomplete coverage when a bounded body prefix omits the search term", () => {
    writeEmlx(
      store,
      "ACC",
      "Archive",
      3,
      plainMessage("Old", "parcel ".repeat(15_000) + " uniquelyfindabletail")
    );
    buildAll(w);
    const r = search({
      mailbox: "Archive",
      body: { text: "uniquelyfindabletail", indexFile: path },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toEqual([]);
    expect(isScopeComplete(r.bodyCoverage!)).toBe(false);
    expect(describeScopeGap(r.bodyCoverage!)).toContain("1 over the 100,000-character body cap");
    expect(w.state().counts).toMatchObject({ truncated: 1 });
    // Prefix matches remain useful, but never imply that the tail was searched.
    const prefix = search({ mailbox: "Archive" });
    expect(prefix.ok && prefix.rows.map((m) => m.id)).toEqual([3]);
    expect(prefix.ok && isScopeComplete(prefix.bodyCoverage!)).toBe(false);
    const other = search({ from: "shop@", mailbox: "INBOX" });
    expect(other.ok && isScopeComplete(other.bodyCoverage!)).toBe(true);
  });

  it("rebuilds old complete markers before reindexing truncated bodies", () => {
    writeEmlx(
      store,
      "ACC",
      "Archive",
      3,
      plainMessage("Old", "parcel ".repeat(15_000) + " uniquelyfindabletail")
    );
    buildAll(w);
    // Old schema v3 called a silently truncated prefix fully indexed.
    w.db.exec("UPDATE docs SET state = 1 WHERE id = 3; PRAGMA user_version = 3");
    w.close();
    w = openWriter(store, path);
    expect(w.rebuilt).toMatch(/schema v3/);
    const during = search({ mailbox: "Archive" });
    expect(during.ok && isScopeComplete(during.bodyCoverage!)).toBe(false);
    buildAll(w);
    const after = search({ mailbox: "Archive" });
    expect(after.ok && isScopeComplete(after.bodyCoverage!)).toBe(false);
    expect(w.state().counts).toMatchObject({ truncated: 1 });
  });

  it("combines the body match with header filters", () => {
    buildAll(w);
    const r = search({ from: "shop@", mailbox: "INBOX" });
    expect(r.ok && r.rows.map((m) => m.id)).toEqual([1]);
  });

  it("counts a message with no .emlx on disk as not downloaded — never as 'no match'", () => {
    buildAll(w);
    const r = search({ mailbox: "INBOX" });
    expect(r.ok && r.bodyCoverage).toEqual({
      notDownloaded: 1,
      notIndexedYet: 0,
      partlyDownloaded: 0,
      tooLarge: 0,
    });
    // Archive has every body: that scope is complete.
    const archive = search({ mailbox: "Archive" });
    expect(archive.ok && isScopeComplete(archive.bodyCoverage!)).toBe(true);
  });

  it("counts coverage over the header filters only", () => {
    buildAll(w);
    // The not-downloaded message is from a@x.com; filtering it out completes the scope.
    const r = search({ from: "shop@" });
    expect(r.ok && isScopeComplete(r.bodyCoverage!)).toBe(true);
  });

  it("mid-build: zero hits is reported with the unindexed count, not as empty", () => {
    w.startWalk();
    while (!w.walkStep(60_000));
    const r = search();
    expect(r.ok && r.rows).toEqual([]);
    expect(r.ok && r.bodyCoverage).toMatchObject({ notIndexedYet: 3, notDownloaded: 1 });
  });

  it("before the first walk: every message in scope is counted as not searched", () => {
    const r = search();
    expect(r.ok && r.rows).toEqual([]);
    expect(r.ok && r.bodyCoverage!.notDownloaded).toBe(4);
  });

  it("stale: a message that arrived after the last update is counted, not missed silently", () => {
    buildAll(w);
    const db = new sqlite!.DatabaseSync(indexPath);
    db.exec(
      "INSERT INTO messages (ROWID, subject, sender, mailbox, date_received, read, flagged, deleted) VALUES (5, 1, 1, 1, 1700000500, 0, 0, 0)"
    );
    db.close();
    writeEmlx(store, "ACC", "INBOX", 5, plainMessage("New", "fresh parcel"));
    const r = search({ mailbox: "INBOX" });
    expect(r.ok && r.rows.map((m) => m.id)).not.toContain(5);
    expect(r.ok && r.bodyCoverage!.notDownloaded).toBe(2);
  });

  it("schema mismatch (writer mid-migration) is unavailable, not empty", () => {
    buildAll(w);
    w.db.exec("PRAGMA user_version = 99");
    const r = search();
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("being rebuilt") });
  });

  it("a file that isn't ours is unavailable, not empty", () => {
    const foreign = join(root, "foreign.db");
    const db = new sqlite!.DatabaseSync(foreign);
    db.exec("CREATE TABLE docs (id); CREATE TABLE bodies (body)");
    db.close();
    const r = searchEnvelopeIndex(
      { accountId: "ACC", limit: 50, body: { text: "parcel", indexFile: foreign } },
      { indexPath, sqlite }
    );
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("not an apple-mail-mcp") });
  });

  it("an unreadable index is unavailable, not empty", () => {
    const r = searchEnvelopeIndex(
      {
        accountId: "ACC",
        limit: 50,
        body: { text: "parcel", indexFile: join(root, "nope", "x.db") },
      },
      { indexPath, sqlite }
    );
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("body index unreadable") });
  });

  it("the search connection cannot write the index", () => {
    buildAll(w);
    const before = statSync(path).mtimeMs;
    search();
    expect(statSync(path).mtimeMs).toBe(before);
  });
});
