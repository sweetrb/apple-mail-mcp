/**
 * Regression test for the `rowsIncludeMailbox` field-count desync (#198 review).
 *
 * `mailbox` is merely `.optional()` in the tool schema, so an explicit empty
 * string is schema-legal and — being falsy — takes the same "list/search ALL
 * mailboxes" AppleScript branch as `undefined`. `rowsIncludeMailbox` has to
 * track that same falsy check; tracking `mailbox === undefined` instead
 * desyncs for `mailbox: ""`, so `parseMessageList` picks neither the
 * single-mailbox nor the all-mailboxes row shape and every message reports a
 * fallback mailbox with `hasAttachments: false`, regardless of the real
 * values — and caches the wrong mailbox for later by-id reads/replies/deletes.
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

const FIELD_SEP = String.fromCharCode(31); // US
const RECORD_SEP = String.fromCharCode(30); // RS

function makeRouter(opts: {
  mailboxNames: string[];
  searchOutput?: string;
}): (script: string) => ScriptResult {
  return (script: string): ScriptResult => {
    if (script.includes("set end of mbNames to mbPath")) {
      return { success: true, output: opts.mailboxNames.join(", ") };
    }
    if (script.includes("set outputText to")) {
      return { success: true, output: opts.searchOutput ?? "" };
    }
    return { success: true, output: "" };
  };
}

const MAILBOXES = ["INBOX", "Sent", "Drafts", "Trash", "Work/Receipts"];

beforeEach(() => {
  h.calls = [];
});

describe("listMessages(mailbox: '') takes the all-mailboxes row shape", () => {
  it("reports the real per-message mailbox and attachment flag, not a fallback", () => {
    // 8-field all-mailboxes row: id|subject|sender|date|read|flagged|mailbox|hasAtt
    const row = [
      "77",
      "Invoice",
      "billing@example.com",
      "2026-8-20-9-0-0",
      "false",
      "false",
      "Work/Receipts",
      "true",
    ].join(FIELD_SEP);
    h.router.fn = makeRouter({ mailboxNames: MAILBOXES, searchOutput: row });
    const mgr = new AppleMailManager();

    const msgs = mgr.listMessages("", "rob@superiortech.io", 50);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].mailbox).toBe("Work/Receipts");
    expect(msgs[0].hasAttachments).toBe(true);
  });

  it("remembers the real mailbox for a later by-id lookup, not the fallback", () => {
    const row = [
      "77",
      "Invoice",
      "billing@example.com",
      "2026-8-20-9-0-0",
      "false",
      "false",
      "Work/Receipts",
      "true",
    ].join(FIELD_SEP);
    h.router.fn = makeRouter({ mailboxNames: MAILBOXES, searchOutput: row });
    const mgr = new AppleMailManager();

    mgr.listMessages("", "rob@superiortech.io", 50);
    h.calls = [];
    mgr.getRawSource("77");

    // The scoped-lookup attempt (tried before any unscoped fallback scan) is
    // what proves rememberLocation cached the real mailbox, not the fallback.
    const scoped = h.calls.find((s) => s.includes("if _mbPath is"));
    expect(scoped).toContain('if _mbPath is "Work/Receipts" then');
  });
});

describe("searchMessages(mailbox: '') takes the all-mailboxes row shape", () => {
  it("reports the real per-message mailbox, not the 'INBOX' fallback", () => {
    // 7-field all-mailboxes row (search never requests attachments):
    // id|subject|sender|date|read|flagged|mailbox
    const row = [
      "88",
      "Statement",
      "billing@example.com",
      "2026-8-20-9-0-0",
      "false",
      "false",
      "Work/Receipts",
    ].join(FIELD_SEP);
    h.router.fn = makeRouter({ mailboxNames: MAILBOXES, searchOutput: row });
    const mgr = new AppleMailManager();

    const msgs = mgr.searchMessages(undefined, "", "rob@superiortech.io", 50);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].mailbox).toBe("Work/Receipts");
  });
});

// Void the unused-var lint in case a future case needs a multi-record payload.
void RECORD_SEP;
