/**
 * Flag-color read-back and filtering on the AppleScript route (#286, @j5pu).
 *
 * Before this, `flag index` was never read by the search/list row builder, so
 * a message's color never reached search-messages/list-messages output, and
 * there was no way to filter by color at all. This covers:
 *   - buildSearchCondition emitting `flag index is N` for the new filter.
 *   - parseMessageList turning the raw `flag index` field (-1..6) into the
 *     palette name, on both the single-mailbox and all-mailboxes row shapes.
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

import { AppleMailManager, buildSearchCondition } from "@/services/appleMailManager.js";

type ScriptResult = { success: boolean; output: string; error?: string };

const FIELD_SEP = String.fromCharCode(31); // US

function makeRouter(opts: { mailboxNames: string[]; searchOutput?: string }) {
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

const MAILBOXES = ["INBOX", "Sent", "Drafts", "Trash"];

beforeEach(() => {
  h.calls = [];
});

describe("buildSearchCondition flagColorIndex", () => {
  it("emits `flag index is N` and needs no separate flagged status check", () => {
    expect(buildSearchCondition({ flagColorIndex: 4 })).toBe("whose flag index is 4");
  });

  it("combines with other filters as additional ANDed conditions", () => {
    expect(buildSearchCondition({ isRead: false, flagColorIndex: 0 })).toBe(
      "whose read status is false and flag index is 0"
    );
  });

  it("omits the condition entirely when flagColorIndex is absent", () => {
    expect(buildSearchCondition({ isFlagged: true })).toBe("whose flagged status is true");
  });
});

describe("parseMessageList flagColor (single-mailbox row shape)", () => {
  it("decodes a colored `flag index` into the palette name", () => {
    // 8-field single-mailbox row: id|subject|sender|dateReceived|dateSent|read|flagged|flagColorRaw
    const row = [
      "42",
      "Orange you glad",
      "a@b.com",
      "2026-8-20-9-0-0",
      "",
      "false",
      "true",
      "1",
    ].join(FIELD_SEP);
    h.router.fn = makeRouter({ mailboxNames: MAILBOXES, searchOutput: row });
    const mgr = new AppleMailManager();

    const msgs = mgr.searchMessages(undefined, "INBOX", "rob@superiortech.io", 50);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].flagColor).toBe("orange");
  });

  it("omits flagColor for -1 (unflagged, or flagged with Mail's plain default)", () => {
    const row = ["43", "Plain", "a@b.com", "2026-8-20-9-0-0", "", "false", "true", "-1"].join(
      FIELD_SEP
    );
    h.router.fn = makeRouter({ mailboxNames: MAILBOXES, searchOutput: row });
    const mgr = new AppleMailManager();

    const msgs = mgr.searchMessages(undefined, "INBOX", "rob@superiortech.io", 50);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].flagColor).toBeUndefined();
  });

  it("round-trips every palette color 0-6", () => {
    const names = ["red", "orange", "yellow", "green", "blue", "purple", "gray"];
    for (let i = 0; i <= 6; i++) {
      const row = ["1", "S", "a@b.com", "2026-8-20-9-0-0", "", "false", "true", String(i)].join(
        FIELD_SEP
      );
      h.router.fn = makeRouter({ mailboxNames: MAILBOXES, searchOutput: row });
      const mgr = new AppleMailManager();
      const msgs = mgr.searchMessages(undefined, "INBOX", "rob@superiortech.io", 50);
      expect(msgs[0].flagColor).toBe(names[i]);
    }
  });
});

describe("parseMessageList flagColor (all-mailboxes row shape)", () => {
  it("decodes flagColor alongside the trailing mailbox field", () => {
    // 9-field all-mailboxes row: id|subject|sender|dateReceived|dateSent|read|flagged|flagColorRaw|mailbox
    const row = [
      "77",
      "Statement",
      "billing@example.com",
      "2026-8-20-9-0-0",
      "",
      "false",
      "true",
      "5",
      "Work/Receipts",
    ].join(FIELD_SEP);
    h.router.fn = makeRouter({ mailboxNames: MAILBOXES, searchOutput: row });
    const mgr = new AppleMailManager();

    const msgs = mgr.searchMessages(undefined, "", "rob@superiortech.io", 50);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].mailbox).toBe("Work/Receipts");
    expect(msgs[0].flagColor).toBe("purple");
  });
});
