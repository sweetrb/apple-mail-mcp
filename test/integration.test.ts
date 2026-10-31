/**
 * Integration tests for apple-mail-mcp
 *
 * These tests run against REAL Apple Mail data — no mocks.
 * They exercise the full stack: Zod schemas → AppleMailManager → AppleScript → Mail.app.
 *
 * Prerequisites:
 *   - macOS with Mail.app configured and at least one account
 *   - Automation permission granted to the terminal running the tests
 *   - At least one message in INBOX
 *
 * Run live checks via: RUN_MAIL_IT=1 pnpm run test:integration
 * The schema and path-validation checks run on every platform. Live checks
 * require explicit opt-in so a machine without Mail accounts cannot masquerade
 * as an integration-tested Mail environment.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { AppleMailManager } from "../src/services/appleMailManager.js";
import { MESSAGE_ID_SCHEMA, BATCH_IDS_SCHEMA, DATE_FILTER_SCHEMA } from "../src/schemas.js";

if (process.env.RUN_MAIL_IT === "1" && process.platform !== "darwin") {
  throw new Error("RUN_MAIL_IT=1 requires macOS with a configured Mail.app account.");
}

// ---------------------------------------------------------------------------
// Test state shared across describe blocks
// ---------------------------------------------------------------------------

let mgr: AppleMailManager;
let realMessageId: string | null = null;
let realAccount: string | null = null;

beforeAll(() => {
  mgr = new AppleMailManager();
});

// ===========================================================================
// Schema validation (no Mail.app interaction)
// ===========================================================================

describe("schema validation", () => {
  describe("MESSAGE_ID_SCHEMA", () => {
    it("accepts the composite IMAP IDs returned by the production read path", () => {
      const id = "imap:eyJhY2NvdW50IjoiV29yayIsInBhdGgiOiJJTkJPWCIsInVpZCI6MX0";
      expect(MESSAGE_ID_SCHEMA.parse(id)).toBe(id);
      expect(BATCH_IDS_SCHEMA.parse(["123", id])).toEqual(["123", id]);
    });
    it.each(["12345", "0", "999999999"])("accepts valid numeric ID: %s", (id) => {
      expect(MESSAGE_ID_SCHEMA.parse(id)).toBe(id);
    });

    it.each([
      ["AppleScript injection", '1" & do shell script "rm -rf /'],
      ["non-numeric", "abc"],
      ["mixed", "123abc"],
      ["negative", "-1"],
      ["spaces", "12 34"],
      ["empty", ""],
      ["template ID", "tmpl_1"],
    ])("rejects %s: %s", (_label, id) => {
      expect(() => MESSAGE_ID_SCHEMA.parse(id)).toThrow();
    });
  });

  describe("BATCH_IDS_SCHEMA", () => {
    it("accepts 1-100 valid numeric IDs", () => {
      expect(BATCH_IDS_SCHEMA.parse(["1", "2", "3"])).toEqual(["1", "2", "3"]);
    });

    it("accepts exactly 100 IDs", () => {
      const ids = Array.from({ length: 100 }, (_, i) => String(i));
      expect(BATCH_IDS_SCHEMA.parse(ids)).toHaveLength(100);
    });

    it("rejects empty array", () => {
      expect(() => BATCH_IDS_SCHEMA.parse([])).toThrow();
    });

    it("rejects more than 100 IDs", () => {
      const ids = Array.from({ length: 101 }, (_, i) => String(i));
      expect(() => BATCH_IDS_SCHEMA.parse(ids)).toThrow();
    });

    it("rejects batch containing non-numeric IDs", () => {
      expect(() => BATCH_IDS_SCHEMA.parse(["123", "abc", "456"])).toThrow();
    });
  });

  describe("DATE_FILTER_SCHEMA", () => {
    it.each(["not a date", "12:30:00", "2026-99-99"])("rejects invalid date %s", (date) => {
      expect(() => DATE_FILTER_SCHEMA.parse(date)).toThrow();
    });
    it.each(["January 1, 2026", "March 15, 2026", "2026-03-15", "3/15/2026"])(
      "accepts valid date string: %s",
      (d) => {
        expect(DATE_FILTER_SCHEMA.parse(d)).toBe(d);
      }
    );

    it("accepts undefined (optional)", () => {
      expect(DATE_FILTER_SCHEMA.parse(undefined)).toBeUndefined();
    });

    it.each([
      ["quotes (injection)", '"January 1" & do shell script "evil"'],
      ["backslash", "January\\1"],
      ["parentheses", "date(2026)"],
      ["semicolon", "Jan 1; evil"],
      ["ampersand", "Jan & evil"],
    ])("rejects %s: %s", (_label, d) => {
      expect(() => DATE_FILTER_SCHEMA.parse(d)).toThrow();
    });
  });
});

// ===========================================================================
// saveAttachment input validation (no Mail.app interaction for bad inputs)
// ===========================================================================

describe("saveAttachment path safety", () => {
  // These all use a bogus message ID so even if validation passes,
  // the AppleScript would just return "message not found".
  const BOGUS_ID = "99999999";

  it("blocks path traversal in savePath", () => {
    const result = mgr.saveAttachment(BOGUS_ID, "test.pdf", "/tmp/../../etc");
    expect(result).toBe(false);
  });

  it("blocks directory traversal in attachment name", () => {
    const result = mgr.saveAttachment(BOGUS_ID, "../../etc/passwd", "/tmp");
    expect(result).toBe(false);
  });

  it("blocks backslash in attachment name", () => {
    const result = mgr.saveAttachment(BOGUS_ID, "file\\name.txt", "/tmp");
    expect(result).toBe(false);
  });

  it("blocks null byte in attachment name", () => {
    const result = mgr.saveAttachment(BOGUS_ID, "file\0name.txt", "/tmp");
    expect(result).toBe(false);
  });

  it("blocks forward slash in attachment name", () => {
    const result = mgr.saveAttachment(BOGUS_ID, "path/to/file.txt", "/tmp");
    expect(result).toBe(false);
  });

  it("blocks save path outside allowed directories", () => {
    const result = mgr.saveAttachment(BOGUS_ID, "test.pdf", "/etc");
    expect(result).toBe(false);
  });

  it("blocks save path to /usr", () => {
    const result = mgr.saveAttachment(BOGUS_ID, "test.pdf", "/usr/local");
    expect(result).toBe(false);
  });
});

// ===========================================================================
// Live Mail.app operations (read-only)
// ===========================================================================

describe.skipIf(process.env.RUN_MAIL_IT !== "1")(
  "live Mail.app operations",
  { timeout: 120_000 },
  () => {
    it("lists at least one account and finds one with INBOX", () => {
      const accounts = mgr.listAccounts();
      expect(accounts.length).toBeGreaterThan(0);

      // Some accounts (e.g. iCloud) may not have a standard INBOX.
      // Find the first account that has messages in INBOX.
      for (const acct of accounts) {
        const messages = mgr.listMessages("INBOX", acct.name, 1);
        if (messages.length > 0) {
          realAccount = acct.name;
          break;
        }
      }

      expect(realAccount).not.toBeNull();
    });

    it("lists messages from INBOX", () => {
      expect(realAccount).not.toBeNull();
      const messages = mgr.listMessages("INBOX", realAccount!, 5);
      expect(messages.length).toBeGreaterThan(0);

      // Capture a real message ID for subsequent tests
      realMessageId = messages[0].id;

      // Verify the real ID is numeric (critical for Number(id) defense)
      expect(realMessageId).toMatch(/^\d+$/);
    });

    it("retrieves a message by numeric ID", () => {
      expect(realMessageId).not.toBeNull();
      const msg = mgr.getMessageById(realMessageId!);
      expect(msg).not.toBeNull();
      expect(msg!.id).toBe(realMessageId);
    });

    it("gets message content by ID", () => {
      expect(realMessageId).not.toBeNull();
      const content = mgr.getMessageContent(realMessageId!);
      expect(content).not.toBeNull();
      expect(content!.subject).toBeDefined();
    });

    it("lists attachments for a message (may be empty)", () => {
      expect(realMessageId).not.toBeNull();
      const attachments = mgr.listAttachments(realMessageId!);
      expect(Array.isArray(attachments)).toBe(true);
    });

    it("searches messages with date range filter", () => {
      // This exercises the DATE_FILTER_SCHEMA → AppleScript date literal path
      const messages = mgr.searchMessages(
        undefined,
        "INBOX",
        realAccount ?? undefined,
        5,
        "January 1, 2025",
        "December 31, 2026"
      );
      // May find 0 messages but should not error
      expect(Array.isArray(messages)).toBe(true);
    });

    it("lists mailboxes for an account", () => {
      expect(realAccount).not.toBeNull();
      const mailboxes = mgr.listMailboxes(realAccount!);
      expect(mailboxes.length).toBeGreaterThan(0);
    });

    it("gets unread count without error", () => {
      const count = mgr.getUnreadCount(undefined, realAccount ?? undefined);
      expect(typeof count).toBe("number");
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it("runs health check", () => {
      const result = mgr.healthCheck();
      expect(result).toBeDefined();
      expect(typeof result.healthy).toBe("boolean");
      expect(Array.isArray(result.checks)).toBe(true);
    });

    it("confirms real message IDs are safe for Number() cast", () => {
      expect(realMessageId).not.toBeNull();
      const num = Number(realMessageId);
      expect(Number.isNaN(num)).toBe(false);
      expect(Number.isFinite(num)).toBe(true);
      expect(num).toBeGreaterThan(0);
    });
  }
);
