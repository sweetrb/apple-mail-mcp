/**
 * Opt-in Envelope Index routing in searchMessagesWithDiagnostics and getMessageContent.
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
    process.env.APPLE_MAIL_MCP_MAIL_DIR = root;
    mgr = new AppleMailManager();
  });
  afterEach(() => {
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
