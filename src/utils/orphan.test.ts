import { describe, it, expect } from "vitest";
import { isOrphaned } from "@/utils/orphan.js";

describe("isOrphaned", () => {
  it("is true when ppid is 1 (reparented to launchd/init → parent died)", () => {
    expect(isOrphaned(1)).toBe(true);
  });

  it("is false for a normal (non-1) parent pid", () => {
    expect(isOrphaned(4242)).toBe(false);
    expect(isOrphaned(2)).toBe(false);
  });

  it("defaults to the live process.ppid, which is never 1 under the test runner", () => {
    // The test process has a real parent (the test runner), so the no-arg call
    // must report not-orphaned — proving the watchdog can't misfire at startup.
    expect(process.ppid).not.toBe(1);
    expect(isOrphaned()).toBe(false);
  });
});
