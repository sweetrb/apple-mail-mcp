/**
 * Unit tests for the Gmail virtual-INBOX handling (BUG A).
 *
 * On a Gmail-style account the literal "INBOX" mailbox is an empty shell — real
 * received mail lives under the "All Mail"/"Important" special mailboxes (nested
 * in Mail.app's [Gmail] container, so they don't resolve via a flat
 * `mailbox "All Mail"` lookup and must be matched by `name of mb`). These tests
 * mock executeAppleScript, feed a Gmail-style mailbox-name list, and assert:
 *   A1) INBOX-scoped search iterates the receiving set (not the empty INBOX),
 *       so it finds the messages an unscoped call reports; and a NON-Gmail
 *       account keeps the plain single-INBOX scan.
 *   A2) getRecentlyReceivedStats scans "All Mail" for Gmail-style accounts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  router: {
    fn: (_script: string) => ({
      success: true,
      output: "",
      error: undefined as string | undefined,
    }),
  },
}));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string) => {
      h.calls.push(script);
      return h.router.fn(script);
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

type ScriptResult = { success: boolean; output: string; error?: string };

const FIELD_SEP = String.fromCharCode(31); // US — must match appleMailManager
const RECORD_SEP = String.fromCharCode(30); // RS

/** The last script that contains `needle`, or undefined. */
const lastScript = (needle: string) => [...h.calls].reverse().find((s) => s.includes(needle));

/**
 * Router that reports `mailboxNames` for the mailbox-name fetch and, for a
 * search/list scan, emits `searchOutput` as the payload. Everything else
 * returns empty success.
 */
function makeRouter(opts: {
  mailboxNames: string[];
  searchOutput?: string;
}): (script: string) => ScriptResult {
  return (script: string): ScriptResult => {
    // fetchMailboxNames: `repeat with mb in mailboxes ... set end of mbNames to name of mb`
    if (script.includes("set end of mbNames to name of mb")) {
      return { success: true, output: opts.mailboxNames.join(", ") };
    }
    // A search/list scan returns its rows (the DIAG trailer is optional here).
    if (script.includes("set outputText to")) {
      return { success: true, output: opts.searchOutput ?? "" };
    }
    return { success: true, output: "" };
  };
}

const GMAIL_MAILBOXES = [
  "Important",
  "Starred",
  "All Mail",
  "Drafts",
  "Sent Mail",
  "Trash",
  "Spam",
  "INBOX",
];

const NON_GMAIL_MAILBOXES = ["INBOX", "Sent", "Drafts", "Trash", "Archive"];

// Void the unused-var lint for RECORD_SEP if a future row-set test needs it.
void RECORD_SEP;

beforeEach(() => {
  h.calls = [];
});

describe("A1: INBOX-scoped search on a Gmail-style account", () => {
  it("scans the receiving set (All Mail / Important) by name, not the empty INBOX", () => {
    h.router.fn = makeRouter({ mailboxNames: GMAIL_MAILBOXES });
    const mgr = new AppleMailManager();

    mgr.searchMessages(undefined, "INBOX", "robert.b.sweet@gmail.com", 50);

    const scan = lastScript("set outputText to");
    expect(scan).toBeDefined();
    // Iterates mailboxes and matches by lowercased name — the Gmail receiving set.
    expect(scan).toMatch(/repeat with mb in mailboxes/);
    expect(scan).toContain('"all mail"');
    expect(scan).toContain('"important"');
    // Does NOT bind the single empty INBOX mailbox directly.
    expect(scan).not.toMatch(/set theMailbox to mailbox "INBOX"/);
  });

  it("case-insensitively treats 'inbox' as the inbox scope", () => {
    h.router.fn = makeRouter({ mailboxNames: GMAIL_MAILBOXES });
    const mgr = new AppleMailManager();

    mgr.searchMessages(undefined, "inbox", "robert.b.sweet@gmail.com", 50);

    const scan = lastScript("set outputText to");
    expect(scan).toContain('"all mail"');
  });

  it("finds messages the receiving-set scan returns", () => {
    // One row: id 100, in All Mail. Six FIELD_SEP fields.
    const row = ["100", "Hello", "a@b.com", "2026-7-1-9-0-0", "false", "false"].join(FIELD_SEP);
    h.router.fn = makeRouter({ mailboxNames: GMAIL_MAILBOXES, searchOutput: row });
    const mgr = new AppleMailManager();

    const msgs = mgr.searchMessages(undefined, "INBOX", "robert.b.sweet@gmail.com", 50);

    expect(msgs.map((m) => m.id)).toContain("100");
  });
});

describe("A1: INBOX-scoped search on a NON-Gmail account is unchanged", () => {
  it("binds the single INBOX mailbox directly (no receiving-set iteration)", () => {
    h.router.fn = makeRouter({ mailboxNames: NON_GMAIL_MAILBOXES });
    const mgr = new AppleMailManager();

    mgr.searchMessages(undefined, "INBOX", "rob@superiortech.io", 50);

    const scan = lastScript("set outputText to");
    expect(scan).toBeDefined();
    expect(scan).toMatch(/set theMailbox to mailbox "INBOX"/);
    expect(scan).not.toContain('"all mail"');
  });

  it("a non-INBOX scope on a Gmail account still binds that mailbox directly", () => {
    h.router.fn = makeRouter({ mailboxNames: GMAIL_MAILBOXES });
    const mgr = new AppleMailManager();

    mgr.searchMessages(undefined, "Sent Mail", "robert.b.sweet@gmail.com", 50);

    const scan = lastScript("set outputText to");
    expect(scan).toMatch(/set theMailbox to mailbox "Sent Mail"/);
  });
});

describe("A2: getRecentlyReceivedStats scans the Gmail receiving set", () => {
  it("detects an 'All Mail' account and counts it (superset), not the empty INBOX", () => {
    h.router.fn = (script: string): ScriptResult => {
      if (script.includes("date received >=")) {
        // Assert the stats script iterates mailboxes and looks for "all mail".
        expect(script).toMatch(/repeat with mb in mailboxes of acct/);
        expect(script).toContain('"all mail"');
        // A per-mailbox count guard bounds the O(n) `whose` scan on a huge
        // "All Mail" so it can't hang (BUG A2 perf).
        expect(script).toMatch(/count of messages of theInbox\) > \d+ then error/);
        // A single 30-day pass is bucketed in-AppleScript (not three whose scans).
        expect(script).toContain("date received >= thirtyDaysAgo");
        return { success: true, output: [3, 5, 7].join(FIELD_SEP) };
      }
      return { success: true, output: "" };
    };
    const mgr = new AppleMailManager();

    const stats = mgr.getRecentlyReceivedStats();

    expect(stats).toEqual({ last24h: 3, last7d: 5, last30d: 7 });
  });

  it("still falls back to the literal INBOX for non-Gmail accounts", () => {
    h.router.fn = (script: string): ScriptResult => {
      if (script.includes("date received >=")) {
        // The fallback branch tries the common inbox names.
        expect(script).toContain('{"INBOX", "Inbox", "inbox"}');
        return { success: true, output: [1, 2, 3].join(FIELD_SEP) };
      }
      return { success: true, output: "" };
    };
    const mgr = new AppleMailManager();

    const stats = mgr.getRecentlyReceivedStats();

    expect(stats).toEqual({ last24h: 1, last7d: 2, last30d: 3 });
  });
});
