/**
 * Opt-in Envelope Index / body index routing in searchMessagesWithDiagnostics and getMessageContent.
 *
 * executeAppleScript is mocked: it answers the account and account-id reads,
 * and records every other script so a test can tell whether the AppleScript
 * search scan ran (it always contains `_timedOut`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildEnvelopeIndex,
  plainMessage,
  sqlite,
  writeEmlx,
} from "@/utils/envelopeIndex.testFixture.js";
import { resetBodyIndexForTests } from "@/utils/bodyIndexSync.js";
import { BodyIndexWriter } from "@/utils/bodyIndex.js";

const FS = "\x1f";
const RS = "\x1e";

const h = vi.hoisted(() => ({ calls: [] as string[], idLookupFails: false }));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string) => {
      h.calls.push(script);
      if (script.includes("(id of acct)")) {
        return h.idLookupFails
          ? { success: false, output: "", error: "Mail not running" }
          : {
              success: true,
              output: `Google${FS}GMAIL-ID${RS}Work${FS}EWS-WORK`,
              error: undefined,
            };
      }
      if (script.includes("email addresses of acct")) {
        return {
          success: true,
          output: `Google${FS}me@gmail.com${FS}true${RS}Work${FS}me@work.example${FS}true`,
          error: undefined,
        };
      }
      return { success: true, output: "", error: undefined as string | undefined };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

const describeIfSqlite = sqlite ? describe : describe.skip;
const T0 = Date.UTC(2026, 2, 10, 12) / 1000;
const appleScanRan = () => h.calls.some((s) => s.includes("_timedOut"));

describeIfSqlite("searchMessagesWithDiagnostics — Envelope Index backend", () => {
  const saved = { ...process.env };
  let root: string;
  let mgr: AppleMailManager;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mgr-envidx-"));
    const v10 = join(root, "V10");
    mkdirSync(join(v10, "MailData"), { recursive: true });
    buildEnvelopeIndex(join(v10, "MailData", "Envelope Index"), [
      {
        id: 11,
        account: "GMAIL-ID",
        mailbox: "[Gmail]/All Mail",
        labels: ["INBOX"],
        subject: "Flight confirmation",
        address: "noreply@airline.example",
        name: "Airline",
        received: T0,
      },
      {
        id: 12,
        account: "GMAIL-ID",
        mailbox: "[Gmail]/All Mail",
        labels: ["INBOX"],
        subject: "Weekly digest",
        address: "news@site.example",
        received: T0 - 3600,
        read: true,
      },
      {
        id: 21,
        account: "EWS-WORK",
        mailbox: "Inbox",
        subject: "Flight policy update",
        address: "hr@work.example",
        received: T0 - 7200,
      },
    ]);
    writeEmlx(v10, "GMAIL-ID", "[Gmail]/All Mail", 11, plainMessage("x", "Booking ref QX7Z"));
    writeEmlx(v10, "GMAIL-ID", "[Gmail]/All Mail", 12, plainMessage("x", "This week in news"));
    writeEmlx(v10, "EWS-WORK", "Inbox", 21, plainMessage("x", "Booking rules changed"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  beforeEach(() => {
    h.calls.length = 0;
    h.idLookupFails = false;
    resetBodyIndexForTests();
    process.env.APPLE_MAIL_MCP_MAIL_DIR = root;
    process.env.APPLE_MAIL_MCP_BODY_INDEX_FILE = join(root, "support", "body.db");
    mgr = new AppleMailManager();
  });
  afterEach(() => {
    resetBodyIndexForTests();
    process.env = { ...saved };
  });

  it("is off by default: the AppleScript scan runs as before", () => {
    mgr.searchMessagesWithDiagnostics("flight", undefined, "Google");
    expect(appleScanRan()).toBe(true);
  });

  it("answers from the index when enabled, without an AppleScript scan", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    const r = mgr.searchMessagesWithDiagnostics("flight", undefined, "Google");
    expect(appleScanRan()).toBe(false);
    expect(r.diagnostics.partial).toBe(false);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({
      id: "11",
      subject: "Flight confirmation",
      sender: "Airline <noreply@airline.example>",
      account: "Google",
      mailbox: "[Gmail]/All Mail",
      isRead: false,
    });
  });

  it("returns ids AppleScript can use (Mail's numeric message id)", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    const r = mgr.searchMessagesWithDiagnostics(undefined, "INBOX", "Google");
    expect(r.messages.map((m) => m.id)).toEqual(["11", "12"]);
  });

  it("searches every account when none is given", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    const r = mgr.searchMessagesWithDiagnostics("flight");
    expect(r.messages.map((m) => `${m.account}:${m.id}`).sort()).toEqual(["Google:11", "Work:21"]);
    expect(appleScanRan()).toBe(false);
  });

  it("applies read-state filters through the index", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    const r = mgr.searchMessagesWithDiagnostics(
      undefined,
      undefined,
      "Google",
      50,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );
    expect(r.messages.map((m) => m.id)).toEqual(["12"]);
  });

  it("falls back to AppleScript for a flag-colour filter", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    mgr.searchMessagesWithDiagnostics(
      undefined,
      undefined,
      "Google",
      50,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      0
    );
    expect(appleScanRan()).toBe(true);
  });

  it("falls back to AppleScript when the account id can't be read", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    h.idLookupFails = true;
    mgr.searchMessagesWithDiagnostics("flight", undefined, "Google");
    expect(appleScanRan()).toBe(true);
  });

  it("falls back to AppleScript when the index isn't readable", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    process.env.APPLE_MAIL_MCP_MAIL_DIR = join(root, "no-access");
    mgr.searchMessagesWithDiagnostics("flight", undefined, "Google");
    expect(appleScanRan()).toBe(true);
  });

  it("falls back to AppleScript for a mailbox the index doesn't know", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    mgr.searchMessagesWithDiagnostics(undefined, "Nonexistent", "Google");
    expect(appleScanRan()).toBe(true);
  });

  it("tags an account answered from the index", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    const r = mgr.searchMessagesWithDiagnostics("flight", undefined, "Google");
    expect(r.diagnostics.backendByAccount).toEqual({ Google: "envelope-index" });
  });

  it("tags every account in an all-account search", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    const r = mgr.searchMessagesWithDiagnostics("flight");
    expect(r.diagnostics.backendByAccount).toEqual({
      Google: "envelope-index",
      Work: "envelope-index",
    });
  });

  it("tags an account that fell back to AppleScript", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    const r = mgr.searchMessagesWithDiagnostics(
      undefined,
      undefined,
      "Google",
      50,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      0
    );
    expect(r.diagnostics.backendByAccount).toEqual({ Google: "applescript" });
  });

  it("falls back to AppleScript when the index file is corrupt", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    const bad = join(root, "corrupt");
    mkdirSync(join(bad, "V10", "MailData"), { recursive: true });
    writeFileSync(join(bad, "V10", "MailData", "Envelope Index"), Buffer.alloc(8192, 0x5a));
    process.env.APPLE_MAIL_MCP_MAIL_DIR = bad;
    const r = mgr.searchMessagesWithDiagnostics("flight", undefined, "Google");
    expect(appleScanRan()).toBe(true);
    expect(r.diagnostics.backendByAccount).toEqual({ Google: "applescript" });
  });

  it("leaves results untagged when the index is disabled", () => {
    const r = mgr.searchMessagesWithDiagnostics("flight", undefined, "Google");
    expect(r.diagnostics.backendByAccount).toBeUndefined();
  });

  it("reports a body search it can't serve as not searched — never as no matches", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    const r = mgr.searchMessagesWithDiagnostics(
      undefined,
      undefined,
      "Google",
      50,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "booking"
    );
    expect(appleScanRan()).toBe(false);
    expect(r.messages).toEqual([]);
    expect(r.diagnostics.partial).toBe(true);
    expect(r.diagnostics.notSearchedMailboxes[0]).toBe(
      "Google / * (body search unavailable: body index disabled)"
    );
  });

  /** Build the body index the way the writer's background loop would. */
  function buildBodyIndex(): void {
    const w = BodyIndexWriter.open(
      join(root, "V10"),
      process.env.APPLE_MAIL_MCP_BODY_INDEX_FILE!,
      sqlite!
    );
    if ("reason" in w) throw new Error(w.reason);
    w.startWalk();
    while (!w.walkStep(60_000));
    while (w.indexStep(60_000) > 0);
    w.close();
  }

  it("searches bodies through the body index, per account", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    process.env.APPLE_MAIL_MCP_BODY_INDEX = "1";
    buildBodyIndex();
    const search = (account: string) =>
      mgr.searchMessagesWithDiagnostics(
        undefined,
        undefined,
        account,
        50,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "booking"
      );
    const google = search("Google");
    expect(google.messages.map((m) => m.id)).toEqual(["11"]);
    expect(google.diagnostics.partial).toBe(false);
    expect(search("Work").messages.map((m) => m.id)).toEqual(["21"]);
    expect(appleScanRan()).toBe(false);
  });

  it("combines a body match with header filters", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    process.env.APPLE_MAIL_MCP_BODY_INDEX = "1";
    buildBodyIndex();
    const r = mgr.searchMessagesWithDiagnostics(
      undefined,
      undefined,
      "Google",
      50,
      undefined,
      undefined,
      "news@",
      undefined,
      undefined,
      undefined,
      undefined,
      "booking"
    );
    expect(r.messages).toEqual([]);
    expect(r.diagnostics.partial).toBe(false);
  });

  it("reports an incomplete index as partial with counts, even with zero hits (#346)", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    process.env.APPLE_MAIL_MCP_BODY_INDEX = "1";
    buildBodyIndex();
    const db = new sqlite!.DatabaseSync(process.env.APPLE_MAIL_MCP_BODY_INDEX_FILE!);
    db.exec("UPDATE docs SET state = 0 WHERE id = 12; DELETE FROM docs WHERE id = 11");
    db.close();
    // Search as a reader (another instance is the writer), so nothing catches up first.
    const other = new sqlite!.DatabaseSync(
      `${process.env.APPLE_MAIL_MCP_BODY_INDEX_FILE}.writer-lock`
    );
    other.exec("BEGIN EXCLUSIVE");
    const r = mgr.searchMessagesWithDiagnostics(
      undefined,
      undefined,
      "Google",
      50,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "no such words anywhere"
    );
    other.exec("ROLLBACK");
    other.close();
    expect(r.messages).toEqual([]);
    expect(r.diagnostics.partial).toBe(true);
    expect(r.diagnostics.notSearchedMailboxes).toEqual([
      "Google / * (1 messages not downloaded, 1 not indexed yet)",
    ]);
    expect(appleScanRan()).toBe(false);
  });

  it("reports a missing index file as not searched, not as no matches", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    process.env.APPLE_MAIL_MCP_BODY_INDEX = "1";
    process.env.APPLE_MAIL_MCP_BODY_INDEX_FILE = join(root, "support", "absent", "x.db");
    // Another instance holds the writer role, so this one can't create the file.
    const lockDir = join(root, "support", "absent");
    mkdirSync(lockDir, { recursive: true });
    const other = new sqlite!.DatabaseSync(join(lockDir, "x.db.writer-lock"));
    other.exec("BEGIN EXCLUSIVE");
    try {
      const r = mgr.searchMessagesWithDiagnostics(
        undefined,
        undefined,
        "Google",
        50,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "booking"
      );
      expect(r.diagnostics.partial).toBe(true);
      expect(r.diagnostics.notSearchedMailboxes).toEqual([
        "Google / * (body search unavailable: body index not created yet)",
      ]);
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
  });

  it("reads a message from disk when enabled, without an AppleScript lookup", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    const content = mgr.getMessageContent("11");
    expect(content).toMatchObject({
      id: "11",
      subject: "Flight confirmation",
      plainText: expect.stringContaining("Booking ref QX7Z"),
      dateReceived: new Date(T0 * 1000),
    });
    expect(h.calls.some((s) => s.includes("whose id is"))).toBe(false);
  });

  it("reads through AppleScript when disabled", () => {
    mgr.getMessageContent("11", false, { account: "Google", mailbox: "INBOX" });
    expect(h.calls.length).toBeGreaterThan(0);
  });

  it("retains indexed retrieval for existing scoped get-message reads", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    const result = mgr.getMessageContent("11", false, {
      account: "Google",
      mailbox: "[Gmail]/All Mail",
    });
    expect(result).toMatchObject({
      id: "11",
      plainText: expect.stringContaining("Booking ref QX7Z"),
    });
    expect(h.calls.some((script) => script.includes("whose id is"))).toBe(false);
  });

  it("reads a scoped label member from its physical file without a message scan", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    const result = mgr.getMessageContent("11", false, { account: "Google", mailbox: "INBOX" });
    expect(result?.plainText).toContain("Booking ref QX7Z");
    expect(h.calls.some((script) => script.includes("whose id is"))).toBe(false);
  });

  it("keeps the disk fast path for a matching account-only scope", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    expect(mgr.getMessageContent("11", false, { account: "Google" })?.plainText).toContain(
      "Booking ref QX7Z"
    );
    expect(h.calls.some((script) => script.includes("whose id is"))).toBe(false);
  });

  it.each([
    { account: "Work", mailbox: "Inbox" },
    { account: "Google", mailbox: "Unknown mailbox" },
  ])("does not return an indexed body outside ordinary explicit scope %j", (scope) => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    const result = mgr.getMessageContent("11", false, scope);
    expect(result).toBeNull();
    expect(h.calls.some((script) => script.includes("whose id is"))).toBe(true);
    expect(mgr.consumeLastMessageLookupError()).toContain(scope.account);
  });

  it("uses only the scoped AppleScript lookup when the index account id is unavailable", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    h.idLookupFails = true;
    expect(mgr.getMessageContent("11", false, { account: "Google", mailbox: "INBOX" })).toBeNull();
    const lookup = h.calls.find((script) => script.includes("whose id is"));
    expect(lookup).toContain('if (name of _scopeAccount) is "Google"');
    expect(lookup).not.toContain("repeat with acct in every account");
  });

  it("does not use an index match from another mailbox for a strict compose read", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    const result = mgr.getMessageContent(
      "11",
      false,
      { account: "Work", mailbox: "Inbox" },
      { requireScopedLocation: true }
    );
    expect(result).toBeNull();
    expect(h.calls.some((script) => script.includes('if (name of _scopeAccount) is "Work"'))).toBe(
      true
    );
  });

  it("falls back to AppleScript for an id it can't find on disk", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    mgr.getMessageContent("999", false, { account: "Google", mailbox: "INBOX" });
    expect(h.calls.length).toBeGreaterThan(0);
  });

  it("never treats a non-numeric (IMAP) id as an index row", () => {
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    mgr.getMessageContent("imap:abc", false, { account: "Google", mailbox: "INBOX" });
    expect(h.calls.length).toBeGreaterThan(0);
  });
});
