/**
 * healthCheck's permission classification (#TCC-misreport).
 *
 * `executeAppleScript` normalises a TCC refusal into "Permission denied. Grant
 * automation access…", replacing the raw text. healthCheck then classified the
 * failure by re-testing for "not authorized"/"not permitted" — substrings the
 * normalisation had just removed — so `isPermError` was unreachable and a real
 * denial was reported as `passed: true`, skipping the early `healthy: false`
 * return. The check shared a NAME with the real thing but not a code path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ denyAll: true }));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    // Faithful to what a real TCC-denied host does, verified live: the
    // `return "ok"` probe SUCCEEDS (it sends no Apple Event that needs a
    // grant), while reading an account property is refused. So check 1 passes
    // and the denial surfaces at check 2 — which is precisely why the
    // misclassification mattered rather than being masked by an early return.
    executeAppleScript: (script: string) => {
      if (!h.denyAll) return { success: true, output: script.includes('return "ok"') ? "ok" : "" };
      if (script.includes('return "ok"')) return { success: true, output: "ok" };
      return { success: false, error: actual.PERMISSION_DENIED_MESSAGE };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

describe("healthCheck under a TCC denial", () => {
  beforeEach(() => {
    h.denyAll = true;
  });

  it("reports the permissions check as FAILED, not passed", () => {
    const r = new AppleMailManager().healthCheck();
    const perms = r.checks.find((c) => c.name === "permissions");
    expect(perms).toBeDefined();
    expect(perms!.passed).toBe(false);
    expect(r.healthy).toBe(false);
  });

  it("stops at the permission check instead of reporting a misleading downstream failure", () => {
    // Pre-fix this fell through to the accounts probe and surfaced
    // "No Mail accounts found. Set up an account in Mail.app first." — which
    // sends the user to configure accounts they already have, when the actual
    // problem is one Automation grant.
    const r = new AppleMailManager().healthCheck();
    expect(r.checks.some((c) => c.name === "accounts")).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/Set up an account in Mail\.app first/);
  });
});
