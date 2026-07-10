import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { searchContactsDb } from "@/utils/contactsDb.js";

/**
 * Load node:sqlite for building fixtures. If it's unavailable (Node < 22.5),
 * we skip the whole suite rather than fail — mirroring the module's own
 * graceful degradation.
 */
let sqlite: typeof import("node:sqlite") | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sqlite = require("node:sqlite");
} catch {
  sqlite = null;
}

const describeIfSqlite = sqlite ? describe : describe.skip;

/**
 * Build a fixture AddressBook DB with the real Core Data ("Z") schema columns
 * the reader queries, then insert the given contacts.
 */
function buildFixtureDb(
  path: string,
  contacts: Array<{
    first?: string;
    last?: string;
    org?: string;
    nick?: string;
    emails?: string[];
    phones?: string[];
  }>
): void {
  const db = new sqlite!.DatabaseSync(path);
  db.exec(`
    CREATE TABLE ZABCDRECORD (
      Z_PK INTEGER PRIMARY KEY,
      ZFIRSTNAME TEXT,
      ZLASTNAME TEXT,
      ZORGANIZATION TEXT,
      ZNICKNAME TEXT
    );
    CREATE TABLE ZABCDEMAILADDRESS (
      Z_PK INTEGER PRIMARY KEY,
      ZADDRESS TEXT,
      ZOWNER INTEGER
    );
    CREATE TABLE ZABCDPHONENUMBER (
      Z_PK INTEGER PRIMARY KEY,
      ZFULLNUMBER TEXT,
      ZOWNER INTEGER
    );
  `);

  const recStmt = db.prepare(
    `INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZNICKNAME) VALUES (?, ?, ?, ?, ?)`
  );
  const emailStmt = db.prepare(`INSERT INTO ZABCDEMAILADDRESS (ZADDRESS, ZOWNER) VALUES (?, ?)`);
  const phoneStmt = db.prepare(`INSERT INTO ZABCDPHONENUMBER (ZFULLNUMBER, ZOWNER) VALUES (?, ?)`);

  contacts.forEach((c, i) => {
    const pk = i + 1;
    recStmt.run(pk, c.first ?? null, c.last ?? null, c.org ?? null, c.nick ?? null);
    for (const e of c.emails ?? []) emailStmt.run(e, pk);
    for (const p of c.phones ?? []) phoneStmt.run(p, pk);
  });

  db.close();
}

describeIfSqlite("searchContactsDb", () => {
  let dir: string;
  let dbA: string;
  let dbB: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "contactsdb-test-"));
    dbA = join(dir, "A.abcddb");
    dbB = join(dir, "B.abcddb");

    buildFixtureDb(dbA, [
      {
        first: "Rob",
        last: "Sweet",
        org: "Superior Technologies",
        emails: ["rob@superiortech.io"],
        phones: ["906-231-0504"],
      },
      {
        first: "Alice",
        last: "Anderson",
        nick: "Ally",
        emails: ["alice@example.com", "ally@work.com"],
      },
      // Contact with no emails and no phones — must still be returned.
      { first: "Bob", last: "Barless" },
    ]);

    // Second DB duplicates Rob (same name + email) to exercise dedup, and adds
    // a distinct contact.
    buildFixtureDb(dbB, [
      { first: "Rob", last: "Sweet", emails: ["rob@superiortech.io"] },
      { first: "Carol", last: "Cavendish", emails: ["carol@globex.com"] },
    ]);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("matches by name substring (case-insensitive)", () => {
    const res = searchContactsDb("sweet", { dbPaths: [dbA] });
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe("Rob Sweet");
    expect(res[0].emails).toEqual(["rob@superiortech.io"]);
    expect(res[0].phones).toEqual(["906-231-0504"]);
  });

  it("matches by email substring", () => {
    const res = searchContactsDb("globex.com", { dbPaths: [dbB] });
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe("Carol Cavendish");
  });

  it("matches by organization", () => {
    const res = searchContactsDb("superior tech", { dbPaths: [dbA] });
    expect(res.map((c) => c.name)).toContain("Rob Sweet");
  });

  it("matches by nickname", () => {
    const res = searchContactsDb("ally", { dbPaths: [dbA] });
    // "ally" hits Alice's nickname AND her ally@work.com email — one contact.
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe("Alice Anderson");
    expect(res[0].emails).toEqual(["alice@example.com", "ally@work.com"]);
  });

  it("returns [] when nothing matches", () => {
    expect(searchContactsDb("zzz-no-such-person", { dbPaths: [dbA, dbB] })).toEqual([]);
  });

  it("returns [] for an empty/whitespace query without touching the DBs", () => {
    expect(searchContactsDb("   ", { dbPaths: [dbA] })).toEqual([]);
  });

  it("returns a contact that has no emails (emails: [])", () => {
    const res = searchContactsDb("barless", { dbPaths: [dbA] });
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe("Bob Barless");
    expect(res[0].emails).toEqual([]);
    expect(res[0].phones).toEqual([]);
  });

  it("de-duplicates the same contact seen across two DBs", () => {
    const res = searchContactsDb("rob", { dbPaths: [dbA, dbB] });
    const robs = res.filter((c) => c.name === "Rob Sweet");
    expect(robs).toHaveLength(1);
  });

  it("merges results across multiple DBs", () => {
    const res = searchContactsDb("c", { dbPaths: [dbA, dbB] });
    const names = res.map((c) => c.name);
    // Carol (dbB) + anyone with 'c' in name/org — at minimum Carol is present.
    expect(names).toContain("Carol Cavendish");
  });

  it("skips an unreadable/absent DB path without throwing", () => {
    const res = searchContactsDb("sweet", { dbPaths: [join(dir, "does-not-exist.abcddb"), dbA] });
    expect(res.map((c) => c.name)).toContain("Rob Sweet");
  });
});
