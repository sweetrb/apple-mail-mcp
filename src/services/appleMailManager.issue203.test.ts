/**
 * Regression tests for #203.
 *
 * The issue reported two symptoms on v2.3.0 (many releases behind current):
 *
 *   Bug 1 — a mailbox name starting with "_" times out the whole account when
 *   scoped search/list addresses it, because (per the reporter's AppleScript
 *   testing) the named specifier `mailbox "_Foo" of account "X"` raises -1728
 *   even when the mailbox exists, and the caller falls back to an unbounded
 *   account-wide scan.
 *
 *   Bug 2 — an unscoped `search-messages` stamps every result `mailbox:
 *   "INBOX"` regardless of where the message actually lives.
 *
 * Both mechanisms were already replaced by the time of this test: mailbox
 * scoping resolves against a container-walked canonical path via
 * `mailboxLookupFragment` (iterate-and-match by `name`, never a named
 * specifier) — see `resolveMailbox`/`fetchMailboxNames` — and the
 * all-mailboxes scan tags every row with its real mailbox (`rowsIncludeMailbox`,
 * hardened for #198). These tests pin that behavior against the exact shapes
 * #203 described so a future change can't silently reintroduce either one.
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

const ICLOUD_MAILBOXES_WITH_UNDERSCORE = ["INBOX", "Sent", "Drafts", "Trash", "_Foo", "_Bar"];

beforeEach(() => {
  h.calls = [];
});

describe("#203 Bug 1: scoped search on an underscore-prefixed mailbox", () => {
  it("finds it by iterate-and-match, never a named specifier, and scans only that mailbox", () => {
    const row = ["5001", "Hi", "a@b.com", "2026-8-20-9-0-0", "false", "false"].join(FIELD_SEP);
    h.router.fn = makeRouter({ mailboxNames: ICLOUD_MAILBOXES_WITH_UNDERSCORE, searchOutput: row });
    const mgr = new AppleMailManager();

    const msgs = mgr.searchMessages(undefined, "_Foo", "iCloud", 50);

    const scan = [...h.calls].reverse().find((s) => s.includes("set outputText to"));
    expect(scan).toBeDefined();
    // Iterate-and-match against the canonical path, not a named specifier.
    expect(scan).toMatch(/if _mbcPath is "_Foo"/);
    expect(scan).not.toMatch(/mailbox "_Foo" of account/);
    // Only the one mailbox is opened for messages — no account-wide repeat.
    expect(scan).not.toMatch(/repeat with mb in mailboxes/);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe("5001");
  });

  it("a nested underscore-prefixed path resolves the same way", () => {
    h.router.fn = makeRouter({ mailboxNames: ICLOUD_MAILBOXES_WITH_UNDERSCORE, searchOutput: "" });
    const mgr = new AppleMailManager();

    mgr.searchMessages(undefined, "_Bar", "iCloud", 50);

    const scan = [...h.calls].reverse().find((s) => s.includes("set outputText to"));
    expect(scan).toMatch(/if _mbcPath is "_Bar"/);
    expect(scan).not.toMatch(/mailbox "_Bar" of account/);
  });
});

describe("#203 Bug 2: fully unscoped search-messages (mailbox omitted)", () => {
  it("reports each message's real mailbox, not a blanket 'INBOX'", () => {
    // Two rows from two different real mailboxes, including Sent Messages —
    // the exact companion effect the issue called out.
    const rows = [
      ["10", "Newsletter", "x@y.com", "2026-8-20-9-0-0", "true", "false", "Archive"].join(
        FIELD_SEP
      ),
      ["11", "Re: Hi", "me@icloud.com", "2026-8-19-9-0-0", "true", "false", "Sent Messages"].join(
        FIELD_SEP
      ),
    ].join(String.fromCharCode(30)); // RS between records
    h.router.fn = makeRouter({
      mailboxNames: ["INBOX", "Archive", "Sent Messages"],
      searchOutput: rows,
    });
    const mgr = new AppleMailManager();

    // mailbox is OMITTED entirely (undefined), matching the issue's repro
    // ("search-messages with only a dateFrom filter") rather than mailbox: "".
    const msgs = mgr.searchMessages(undefined, undefined, "iCloud", 50, "2026-08-01");

    expect(msgs).toHaveLength(2);
    expect(msgs.find((m) => m.id === "10")?.mailbox).toBe("Archive");
    expect(msgs.find((m) => m.id === "11")?.mailbox).toBe("Sent Messages");
    expect(msgs.some((m) => m.mailbox === "INBOX")).toBe(false);
  });
});
