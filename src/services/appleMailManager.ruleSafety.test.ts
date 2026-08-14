/**
 * Regression guards for rule creation safety.
 *
 * Mail rules can act on future messages without another MCP call. Creating
 * them disabled by default gives the user a review point before automation
 * starts. executeAppleScript is mocked, so this test only inspects the rule
 * properties sent to Mail.app.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string) => {
      h.calls.push(script);
      return { success: true, output: "ok", error: undefined as string | undefined };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

const spec = {
  name: "Review before automation",
  conditions: [{ field: "subject" as const, operator: "contains" as const, value: "invoice" }],
  actions: { delete: true },
};

describe("mail rule creation safety", () => {
  let mgr: AppleMailManager;

  beforeEach(() => {
    h.calls.length = 0;
    mgr = new AppleMailManager();
  });

  it("creates a new rule disabled when enabled is omitted", () => {
    expect(mgr.createRule(spec)).toEqual({ success: true });
    expect(h.calls.at(-1)).toContain("enabled:false");
  });

  it("allows an explicit review-approved enabled rule", () => {
    expect(mgr.createRule({ ...spec, enabled: true })).toEqual({ success: true });
    expect(h.calls.at(-1)).toContain("enabled:true");
  });
});
