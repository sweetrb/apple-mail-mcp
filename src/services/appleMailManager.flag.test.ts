/**
 * Unit tests for flag-color support. They assert the AppleScript that
 * flagMessage / batchFlagMessages generate — `set flagged status` plus, when a
 * color is given, `set flag index` (Apple's 0-6 palette) — and that unflagging
 * removes the flag (which also clears any color). executeAppleScript is fully
 * mocked, so no running Mail.app is needed.
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

const lastScript = () => h.calls[h.calls.length - 1] ?? "";

describe("flag color (AppleScript flag index)", () => {
  let mgr: AppleMailManager;
  beforeEach(() => {
    h.calls.length = 0;
    mgr = new AppleMailManager();
  });

  it("flagMessage without a color sets flagged status only (no flag index)", () => {
    mgr.flagMessage("123");
    const s = lastScript();
    expect(s).toContain("set flagged status of msg to true");
    expect(s).not.toContain("flag index");
  });

  it("flagMessage with a color sets flagged status AND the flag index", () => {
    mgr.flagMessage("123", 6); // gray
    const s = lastScript();
    expect(s).toContain("set flagged status of msg to true");
    expect(s).toContain("set flag index of msg to 6");
  });

  it("batchFlagMessages threads the color into the per-message op", () => {
    mgr.batchFlagMessages(["1", "2"], 4); // blue
    const s = lastScript();
    expect(s).toContain("set flagged status of _msg to true");
    expect(s).toContain("set flag index of _msg to 4");
  });

  it("batchFlagMessages without a color omits the flag index", () => {
    mgr.batchFlagMessages(["1", "2"]);
    const s = lastScript();
    expect(s).toContain("set flagged status of _msg to true");
    expect(s).not.toContain("flag index");
  });

  it("unflagMessage removes the flag (which also clears the color)", () => {
    mgr.unflagMessage("123");
    const s = lastScript();
    expect(s).toContain("set flagged status of msg to false");
    expect(s).not.toContain("flag index");
  });
});
