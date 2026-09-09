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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ denyAll: true, denialText: null as string | null }));

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
      // `denialText` lets a test supply the RAW, locale-specific refusal macOS
      // actually emits, instead of the already-normalised message.
      return { success: false, error: h.denialText ?? actual.PERMISSION_DENIED_MESSAGE };
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
/**
 * The locale half of the same failure mode (#218, reported by @jarrah31).
 *
 * macOS emits the TCC refusal in the SYSTEM language. The classifier knew only
 * the American "not authorized", so on an en_GB/en_AU/en_IE Mac `isPermError`
 * was false, `passed: !isPermError` reported the permissions check as PASSED,
 * the early `healthy: false` return never fired, and the run fell through to
 * the accounts probe — telling a user whose Mail is fully configured to go set
 * up an account. Same constant, same silent-pass symptom 2.11.1 was written to
 * fix; only the axis changed, from normalisation to locale.
 *
 * This guard exists so the classifier and the health check cannot drift apart
 * on locale the way they previously drifted on normalisation.
 */
describe("healthCheck under a LOCALISED TCC denial", () => {
  const LOCALISED_REFUSALS: [string, string][] = [
    ["en-GB", "27:44: execution error: Not authorised to send Apple events to Mail. (-1743)"],
    ["en-AU", "27:44: execution error: Not authorised to send Apple events to Mail. (-1743)"],
    [
      "fr (OSStatus only)",
      "27:44: execution error: Non autoris\u00e9 \u00e0 envoyer des \u00e9v\u00e9nements Apple \u00e0 Mail. (-1743)",
    ],
  ];

  beforeEach(() => {
    h.denyAll = true;
  });

  afterEach(() => {
    h.denialText = null;
  });

  it.each(LOCALISED_REFUSALS)(
    "fails the permissions check and returns early: %s",
    (_locale, refusal) => {
      h.denialText = refusal;

      const r = new AppleMailManager().healthCheck();

      const perms = r.checks.find((c) => c.name === "permissions");
      expect(perms).toBeDefined();
      // Pre-fix this was `true` — a genuine denial reporting `permissions: ok`.
      expect(perms!.passed).toBe(false);
      expect(perms!.message).toMatch(/System Settings > Privacy & Security > Automation/);
      expect(r.healthy).toBe(false);

      // The early return has to fire, or the misleading accounts advice returns.
      expect(r.checks.some((c) => c.name === "accounts")).toBe(false);
      expect(JSON.stringify(r)).not.toMatch(/Set up an account in Mail\.app first/);
    }
  );
});
