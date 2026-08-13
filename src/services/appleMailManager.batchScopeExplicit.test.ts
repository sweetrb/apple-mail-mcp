/**
 * Follow-up to #152 / #153: an explicit caller-supplied source scope, and per-id
 * failure reasons that actually reach the caller.
 *
 * #153 made batch operations resolve each numeric id against the id→location
 * index that list/search populates. That index is **per-process state**, so a
 * caller which starts a fresh server and replays a saved list of ids has nothing
 * recorded: every id lands on the "unlocated" path and, on a label store where
 * one message is reachable from several mailboxes, is refused as ambiguous.
 * `sourceMailbox`/`sourceAccount` lets the caller name the mailbox directly and
 * stay on the scoped path.
 *
 * executeAppleScript is mocked; nothing here touches a running Mail.app.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

const h = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string) => {
      h.calls.push(script);
      // Report `ok` for every position the batch script asked about, so the
      // parsing path is exercised without pretending to be Mail.
      const positions = [...script.matchAll(/set _gpos to \{([^}]*)\}/g)]
        .flatMap((m) => m[1].split(","))
        .map((p) => p.trim())
        .filter(Boolean);
      const output = positions.map((p) => `${p}${FIELD_SEP}ok`).join(RECORD_SEP) + RECORD_SEP;
      return { success: true, output, error: undefined as string | undefined };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

/** The batch script emits scoped groups (`_gpos`) and/or an unlocated walk (`_uids`). */
const batchScript = () =>
  h.calls.find((s) => s.includes("set _gpos to") || s.includes("set _uids to")) ?? "";

describe("explicit batch source scope", () => {
  let mgr: AppleMailManager;

  beforeEach(() => {
    h.calls.length = 0;
    mgr = new AppleMailManager();
  });

  it("scopes to the caller's mailbox with a COLD id→location index", () => {
    const res = mgr.batchDeleteMessages(["79345"], {
      account: "rob@superiortech.io",
      mailbox: "Sales Spam",
    });

    expect(res).toEqual([{ id: "79345", success: true }]);
    const s = batchScript();
    expect(s).toContain("Sales Spam");
    // The unlocated fallback walk must not be generated at all: with a scope,
    // no id is unlocated, so nothing may probe every account/mailbox.
    expect(s).not.toContain("repeat with acct in accounts");
  });

  it("without a scope and a cold index, falls back to the ambiguity-checked walk", () => {
    mgr.batchDeleteMessages(["79345"]);
    expect(batchScript()).toContain("repeat with acct in accounts");
  });

  it("prefers the caller's scope over a conflicting remembered location", () => {
    mgr.noteMessageLocation("79345", "rob@superiortech.io", "[Gmail]/All Mail");

    mgr.batchDeleteMessages(["79345"], {
      account: "rob@superiortech.io",
      mailbox: "Sales Spam",
    });

    const s = batchScript();
    expect(s).toContain("Sales Spam");
    expect(s).not.toContain("[Gmail]/All Mail");
  });

  it("noteMessageLocation puts an id on the scoped path", () => {
    mgr.noteMessageLocation("79345", "rob@superiortech.io", "Sales Spam");
    mgr.batchDeleteMessages(["79345"]);

    const s = batchScript();
    expect(s).toContain("Sales Spam");
    expect(s).not.toContain("repeat with acct in accounts");
  });

  it("applies the source scope to every batch operation, not just delete", () => {
    const scope = { account: "rob@superiortech.io", mailbox: "Sales Spam" };
    for (const run of [
      () => mgr.batchMarkAsRead(["1"], scope),
      () => mgr.batchMarkAsUnread(["1"], scope),
      () => mgr.batchUnflagMessages(["1"], scope),
      () => mgr.batchFlagMessages(["1"], 6, scope),
      () => mgr.batchMoveMessages(["1"], "Archive", "rob@superiortech.io", scope),
    ]) {
      h.calls.length = 0;
      run();
      expect(batchScript()).not.toContain("repeat with acct in accounts");
    }
  });

  it("keeps the batch to a single osascript invocation (issue #31)", () => {
    mgr.batchDeleteMessages(["1", "2", "3"], {
      account: "rob@superiortech.io",
      mailbox: "Sales Spam",
    });
    expect(h.calls.filter((s) => s.includes("set _gpos to"))).toHaveLength(1);
  });
});
