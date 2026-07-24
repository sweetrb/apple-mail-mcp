/**
 * Unit tests for the smart-mailbox (intelligente Postfächer) tools.
 *
 * Two layers:
 *  1. Pure logic — extractEmail, buildSmartMailboxEntry, and the newsletter
 *     grouping/scoring — with executeAppleScript mocked, so no Mail is needed.
 *  2. Real plist round-trips via the path-injectable *AtPath cores against a
 *     fixture SyncedSmartMailboxes.plist that deliberately contains <date> and
 *     <data> criteria. That fixture is the exact case that broke the original
 *     implementation (plutil's json converter rejects date/data, so it read the
 *     file as empty and would overwrite every existing smart mailbox). These
 *     tests assert the pre-existing entry — including its date/data — survives
 *     a create and a delete untouched, and that a .bak backup is written.
 *     They use only plutil / PlistBuddy (present on every macOS CI runner).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import { existsSync, writeFileSync, mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const h = vi.hoisted(() => ({ output: "" }));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: () => ({
      success: true,
      output: h.output,
      error: undefined as string | undefined,
    }),
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

// A fixture plist whose first entry carries a <date> and a <data> value —
// the types plutil's json converter cannot represent.
const FIXTURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
  <dict>
    <key>MailboxName</key><string>Existing Date Rule</string>
    <key>MailboxID</key><string>EXISTING-ID</string>
    <key>MailboxType</key><integer>7</integer>
    <key>MailboxCriteria</key>
    <array>
      <dict>
        <key>Header</key><string>DateReceived</string>
        <key>CriterionUniqueId</key><string>C-1</string>
        <key>SomeDate</key><date>2024-01-15T00:00:00Z</date>
        <key>SomeBlob</key><data>SGVsbG8gV29ybGQ=</data>
      </dict>
    </array>
  </dict>
</array>
</plist>`;

function makeFixture(dir: string): string {
  const xml = join(dir, "src.xml");
  const plist = join(dir, "SyncedSmartMailboxes.plist");
  writeFileSync(xml, FIXTURE_XML, "utf8");
  const r = spawnSync("plutil", ["-convert", "binary1", "-o", plist, xml], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`fixture build failed: ${r.stderr}`);
  return plist;
}

function xml1(plist: string): string {
  return spawnSync("plutil", ["-convert", "xml1", "-o", "-", plist], { encoding: "utf8" }).stdout;
}

describe("smart mailbox — pure logic", () => {
  let mgr: AppleMailManager;
  beforeEach(() => {
    mgr = new AppleMailManager();
  });

  it("extractEmail pulls the address out of a display-name header and lowercases it", () => {
    const ex = (m: string) => (mgr as any).extractEmail(m);
    expect(ex("Foo Bar <Foo@Bar.COM>")).toBe("foo@bar.com");
    expect(ex("plain@addr.com")).toBe("plain@addr.com");
    expect(ex("  Spaced <x@y.com>  ")).toBe("x@y.com");
  });

  it("buildSmartMailboxEntry selects the From/Subject/Body header from the given criterion", () => {
    const build = (f: string, s: string, b: string) =>
      (mgr as any).buildSmartMailboxEntry("Name", f, s, b);
    const userCrit = (e: any) => e.MailboxCriteria.find((c: any) => c.Header === "Compound");

    const fromE = build("news@x.com", "", "");
    expect(fromE.MailboxName).toBe("Name");
    expect(fromE.MailboxType).toBe(7);
    expect(userCrit(fromE).Criteria[0].Header).toBe("From");
    expect(userCrit(fromE).Criteria[0].Expression).toBe("news@x.com");

    expect(userCrit(build("", "Invoice", "")).Criteria[0].Header).toBe("Subject");
    expect(userCrit(build("", "", "urgent")).Criteria[0].Header).toBe("Body");
  });

  it("groupAndScoreNewsletters groups by sender, drops senders below minCount, and flags signals", () => {
    const rows = [
      {
        sender: "Acme News <news@acme.com>",
        subject: "Weekly Digest #1",
        source: "List-Unsubscribe: <https://acme.com/u>",
      },
      { sender: "Acme News <news@acme.com>", subject: "Weekly Digest #2", source: "body" },
      { sender: "Acme News <news@acme.com>", subject: "Weekly Digest #3", source: "body" },
      { sender: "Real Person <bob@personal.com>", subject: "lunch?", source: "hey" },
    ];
    const res = (mgr as any).groupAndScoreNewsletters(rows, 3);
    expect(res).toHaveLength(1);
    expect(res[0].email).toBe("news@acme.com");
    expect(res[0].count).toBe(3);
    expect(res[0].suggestedName).toBe("NL: Acme News");
    expect(res[0].signals).toContain("list_unsubscribe");
    expect(res[0].signals).toContain("keyword_or_list");
    expect(res[0].score).toBeGreaterThan(0);
  });

  it("groupAndScoreNewsletters detects repetitive subjects", () => {
    const rows = Array.from({ length: 4 }, () => ({
      sender: "Bot <bot@svc.com>",
      subject: "Your daily report is ready to view now",
      source: "plain",
    }));
    const res = (mgr as any).groupAndScoreNewsletters(rows, 3);
    expect(res[0].signals).toContain("repetitive_subject");
  });

  it("findNewsletterCandidates runs the (mocked) scan through grouping/scoring", () => {
    h.output = [
      "Acme <news@acme.com>|Digest 1|List-Unsubscribe: <x>",
      "Acme <news@acme.com>|Digest 2|body",
      "Acme <news@acme.com>|Digest 3|body",
      "",
    ].join("\n");
    const res = mgr.findNewsletterCandidates(90, 3);
    expect(res).toHaveLength(1);
    expect(res[0].email).toBe("news@acme.com");
  });
});

describe("smart mailbox — real plist round-trips (preserve date/data, backup, atomic)", () => {
  let dir: string;
  let plist: string;
  let mgr: AppleMailManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "smartmbox-"));
    plist = makeFixture(dir);
    mgr = new AppleMailManager();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a date/data plist via the PlistBuddy fallback (json converter can't)", () => {
    // The json fast-path fails on this fixture...
    const j = spawnSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" });
    expect(j.status).not.toBe(0);
    // ...but the manager still enumerates the entry structurally.
    const entries = (mgr as any).readSmartMailboxEntries(plist);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("Existing Date Rule");
  });

  it("createSmartMailboxAtPath appends without touching the existing date/data entry", () => {
    const r = (mgr as any).createSmartMailboxAtPath(plist, "NL: Acme", "news@acme.com", "", "");
    expect(r).toEqual({ created: true, alreadyExisted: false });

    // Existing entry's <date> and <data> survived verbatim.
    const out = xml1(plist);
    expect(out).toContain("<date>2024-01-15T00:00:00Z</date>");
    expect(out).toContain("SGVsbG8gV29ybGQ=");
    expect(out).toContain("Existing Date Rule");

    // Both entries present, still a valid plist, and a backup was written.
    const names = (mgr as any).readSmartMailboxEntries(plist).map((e: any) => e.name);
    expect(names).toEqual(["Existing Date Rule", "NL: Acme"]);
    expect(spawnSync("plutil", ["-lint", plist], { encoding: "utf8" }).status).toBe(0);
    expect(existsSync(`${plist}.bak`)).toBe(true);
    // Backup holds the pre-write state (single original entry).
    expect(readFileSync(`${plist}.bak`)).not.toBeNull();
    expect((mgr as any).readSmartMailboxEntries(`${plist}.bak`)).toHaveLength(1);
  });

  it("createSmartMailboxAtPath is idempotent on an existing name", () => {
    (mgr as any).createSmartMailboxAtPath(plist, "NL: Acme", "news@acme.com", "", "");
    const again = (mgr as any).createSmartMailboxAtPath(plist, "NL: Acme", "news@acme.com", "", "");
    expect(again).toEqual({ created: false, alreadyExisted: true });
    expect((mgr as any).readSmartMailboxEntries(plist)).toHaveLength(2);
  });

  it("deleteSmartMailboxAtPath removes only the named entry and preserves the rest", () => {
    (mgr as any).createSmartMailboxAtPath(plist, "NL: Acme", "news@acme.com", "", "");
    const del = (mgr as any).deleteSmartMailboxAtPath(plist, "NL: Acme");
    expect(del).toEqual({ deleted: true });

    const names = (mgr as any).readSmartMailboxEntries(plist).map((e: any) => e.name);
    expect(names).toEqual(["Existing Date Rule"]);
    // The surviving entry still has its date/data intact.
    const out = xml1(plist);
    expect(out).toContain("<date>2024-01-15T00:00:00Z</date>");
    expect(out).toContain("SGVsbG8gV29ybGQ=");
  });

  it("deleteSmartMailboxAtPath reports not-found without mutating the file", () => {
    const before = xml1(plist);
    const del = (mgr as any).deleteSmartMailboxAtPath(plist, "Does Not Exist");
    expect(del.deleted).toBe(false);
    expect(xml1(plist)).toBe(before);
  });
});
