/**
 * Regression tests for #130 — a failed AppleScript transport must never be
 * reported as a legitimate zero/empty answer.
 *
 * Before this fix, `getUnreadCount` returned `0` and `fetchAccounts` returned
 * `[]` when the AppleScript call failed (timeout, wedged Mail, missing Automation
 * grant). The failure went to stderr only, so the MCP payload was a clean
 * success: an agent saw "inbox zero" / "no accounts configured" while Mail
 * actually held thousands of unread messages.
 *
 * Two distinct guarantees are asserted here:
 *   1) a transport failure is DISTINGUISHABLE from a genuine empty result; and
 *   2) a failed account fetch is NOT cached — caching it poisoned every later
 *      call for the full TTL, so one timeout made Mail look account-less long
 *      after it had recovered.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  result: { success: true, output: "" } as { success: boolean; output: string; error?: string },
}));

vi.mock("@/utils/applescript.js", () => ({
  executeAppleScript: vi.fn(() => h.result),
  executeMutationAppleScript: vi.fn(() => h.result),
  AppleScriptError: class extends Error {},
}));

const { AppleMailManager } = await import("./appleMailManager.js");

const FIELD = "\x1f"; // US — matches FIELD_SEP in appleMailManager.ts
const RECORD = "\x1e"; // RS — matches RECORD_SEP

describe("#130 — transport failure is not a real answer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.result = { success: true, output: "" };
  });

  describe("listAccountsChecked", () => {
    it("reports failed=true with the error when the AppleScript call fails", () => {
      const mgr = new AppleMailManager();
      h.result = { success: false, output: "", error: "AppleEvent timed out" };

      const r = mgr.listAccountsChecked();

      expect(r.failed).toBe(true);
      expect(r.error).toContain("timed out");
    });

    it("reports failed=false for a genuinely empty account list", () => {
      const mgr = new AppleMailManager();
      h.result = { success: true, output: "" };

      const r = mgr.listAccountsChecked();

      // Mail answered; there really are no accounts. This must stay
      // distinguishable from the timeout case above.
      expect(r.failed).toBe(false);
      expect(r.accounts).toEqual([]);
    });

    it("does not cache a failed fetch — a later success is not masked by it", () => {
      const mgr = new AppleMailManager();

      h.result = { success: false, output: "", error: "AppleEvent timed out" };
      expect(mgr.listAccountsChecked().failed).toBe(true);

      // Mail recovers within the cache TTL.
      h.result = {
        success: true,
        output: ["iCloud", "rob@example.com", "true"].join(FIELD),
      };
      const r = mgr.listAccountsChecked();

      expect(r.failed).toBe(false);
      expect(r.accounts.map((a) => a.name)).toEqual(["iCloud"]);
    });

    it("still caches a successful fetch", () => {
      const mgr = new AppleMailManager();
      h.result = {
        success: true,
        output: ["iCloud", "rob@example.com", "true"].join(FIELD),
      };
      expect(mgr.listAccountsChecked().accounts).toHaveLength(1);

      // A subsequent transport failure must be served from the good cache
      // rather than re-running the script and reporting empty.
      h.result = { success: false, output: "", error: "AppleEvent timed out" };
      const r = mgr.listAccountsChecked();
      expect(r.accounts.map((a) => a.name)).toEqual(["iCloud"]);
    });
  });

  describe("getUnreadCountChecked", () => {
    it("returns count=null and failed=true when the AppleScript call fails", () => {
      const mgr = new AppleMailManager();
      h.result = { success: false, output: "", error: "AppleEvent timed out" };

      const r = mgr.getUnreadCountChecked("INBOX", "iCloud");

      // The critical assertion: NOT 0.
      expect(r.count).toBeNull();
      expect(r.failed).toBe(true);
      expect(r.error).toContain("timed out");
    });

    it("returns a real zero as failed=false", () => {
      const mgr = new AppleMailManager();
      h.result = { success: true, output: "0" };

      const r = mgr.getUnreadCountChecked("INBOX", "iCloud");

      expect(r.count).toBe(0);
      expect(r.failed).toBe(false);
    });

    it("returns a real non-zero count unchanged", () => {
      const mgr = new AppleMailManager();
      h.result = { success: true, output: "42" };

      const r = mgr.getUnreadCountChecked("INBOX", "iCloud");

      expect(r.count).toBe(42);
      expect(r.failed).toBe(false);
    });
  });

  it("keeps a multi-record account list parsing correctly", () => {
    const mgr = new AppleMailManager();
    h.result = {
      success: true,
      output: [
        ["iCloud", "rob@example.com", "true"].join(FIELD),
        ["Gmail", "rob@gmail.com", "true"].join(FIELD),
      ].join(RECORD),
    };

    const r = mgr.listAccountsChecked();

    expect(r.failed).toBe(false);
    expect(r.accounts.map((a) => a.name)).toEqual(["iCloud", "Gmail"]);
  });
});
