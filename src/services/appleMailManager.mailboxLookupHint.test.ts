/**
 * Mailbox lookup by position.
 *
 * Working out a mailbox's path walks its containers (several Apple events each).
 * The list, search and unread-count scripts did that for every mailbox of the
 * account on every call to find the one they wanted: ~12 s on an iCloud account
 * with 119 mailboxes, paid again on each call. The mailbox-path list is cached
 * in the same order as the account's `mailboxes`, so the scripts now check the
 * one mailbox at the cached position first and walk the rest only when its path
 * does not match (the list changed since it was cached). Both only build and run
 * AppleScript, so the script is what is checked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string) => {
      h.calls.push(script);
      if (script.includes("set end of mbNames to mbPath")) {
        return { success: true, output: "Archive, INBOX, Sent, Drafts" };
      }
      return { success: true, output: "0" };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

beforeEach(() => {
  h.calls = [];
});

const ACCOUNT = "rob@superiortech.io";

function lastScript(marker: string): string {
  const hit = [...h.calls].reverse().find((s) => s.includes(marker));
  expect(hit, `no script containing ${marker}`).toBeDefined();
  return hit!;
}

describe("mailbox lookup by cached position", () => {
  it("list-messages checks the mailbox at its cached position before walking", () => {
    new AppleMailManager().listMessages("INBOX", ACCOUNT, 10);
    const script = lastScript("set outputText to");
    expect(script).toContain("set _mbc to item 2 of (mailboxes)");
    // The full walk stays, behind a missing-value guard.
    const hint = script.indexOf("set _mbc to item 2 of (mailboxes)");
    const guard = script.indexOf("if theMailbox is missing value then", hint);
    const walk = script.indexOf("repeat with _mbc in (mailboxes)", guard);
    expect(hint).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(hint);
    expect(walk).toBeGreaterThan(guard);
  });

  it("the hint still verifies the path before it is trusted", () => {
    new AppleMailManager().listMessages("INBOX", ACCOUNT, 10);
    const script = lastScript("set outputText to");
    const hint = script.slice(script.indexOf("set _mbc to item 2 of (mailboxes)"));
    expect(hint.indexOf('if _mbcPath is "INBOX" then set theMailbox to _mbc')).toBeGreaterThan(-1);
  });

  it("search-messages uses the position too", () => {
    new AppleMailManager().searchMessages(undefined, "Sent", ACCOUNT, 10);
    expect(lastScript("set outputText to")).toContain("set _mbc to item 3 of (mailboxes)");
  });

  it("get-unread-count uses the position too", () => {
    new AppleMailManager().getUnreadCount("Drafts", ACCOUNT);
    expect(lastScript("unread count of theMailbox")).toContain("set _mbc to item 4 of (mailboxes)");
  });

  it("a mailbox that is not in the cached list gets no hint, only the full walk", () => {
    new AppleMailManager().listMessages("Nowhere", ACCOUNT, 10);
    const script = lastScript("set outputText to");
    expect(script).not.toMatch(/set _mbc to item \d+ of/);
    expect(script).toContain("repeat with _mbc in (mailboxes)");
  });
});
