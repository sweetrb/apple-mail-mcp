/**
 * #156 item 3 — a batch scoped to a DISABLED account must be refused up front.
 *
 * `disabledAccountGuard` existed and was consulted by the single-message paths,
 * but `runBatchOperation` never called it. A batch pinned to a disabled account
 * therefore went straight to AppleScript, failed server-side with AppleEvent
 * -10000, and could leave a mailbox half-changed — the precise outcome the guard
 * was written to prevent.
 *
 * executeAppleScript is mocked, so the "disabled" verdict is injected rather
 * than requiring a real disabled Mail account.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as string[], accountEnabled: "true" }));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string) => {
      h.calls.push(script);
      // The enabled-probe is the only script that reads `enabled of account`.
      if (script.includes("enabled of account")) {
        return { success: true, output: h.accountEnabled, error: undefined as string | undefined };
      }
      return { success: true, output: "ok", error: undefined as string | undefined };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

describe("#156 item 3 — batch operations refuse a disabled source account", () => {
  let mgr: AppleMailManager;

  beforeEach(() => {
    h.calls.length = 0;
    h.accountEnabled = "true";
    mgr = new AppleMailManager();
  });

  it("refuses every id when the scoped account is disabled, without mutating", () => {
    h.accountEnabled = "false";
    const results = mgr.batchDeleteMessages(["101", "102"], {
      account: "Disabled Acct",
      mailbox: "INBOX",
    });

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/disabled in Mail/);
    }
    // Nothing may have been deleted: no mutation script was ever generated.
    expect(h.calls.some((s) => s.includes("delete _msg"))).toBe(false);
  });

  it("refuses a scoped move to a disabled account the same way", () => {
    h.accountEnabled = "false";
    const results = mgr.batchMoveMessages(["101"], "Archive", undefined, {
      account: "Disabled Acct",
      mailbox: "INBOX",
    });
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/disabled in Mail/);
  });

  it("proceeds normally when the account is enabled", () => {
    h.accountEnabled = "true";
    const results = mgr.batchDeleteMessages(["101"], {
      account: "Live Acct",
      mailbox: "INBOX",
    });
    expect(results[0].error).not.toMatch(/disabled in Mail/);
  });

  it("fails OPEN when Mail will not report the account state", () => {
    // An inconclusive probe must never block an otherwise-valid operation.
    h.accountEnabled = "missing";
    const results = mgr.batchDeleteMessages(["101"], {
      account: "Unknown Acct",
      mailbox: "INBOX",
    });
    expect(results[0].error).not.toMatch(/disabled in Mail/);
  });
});
