/**
 * Compose mutations are never retried.
 *
 * `executeAppleScript` retries on a timeout (and on Mail's "timed out" /
 * "busy" error strings). For a read that is harmless; for `send newMessage`
 * it is a duplicate-send hazard — Mail may have accepted the message before
 * the Apple Event timed out, and a second attempt composes and submits it
 * again. The same applies to draft creation (a duplicate in Drafts). These
 * tests pin `maxRetries: 1` on both paths so the option cannot drift back to
 * a retrying value (it was 2 until 2.19.8).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ script: string; options: Record<string, unknown> | undefined }>,
}));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string, options?: Record<string, unknown>) => {
      h.calls.push({ script, options });
      return { success: false, output: "", error: "Operation timed out after 60 seconds" };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

afterEach(() => {
  h.calls.length = 0;
});

describe("compose mutations are single-attempt", () => {
  it("sendEmail runs the AppleScript send with maxRetries: 1", () => {
    const mgr = new AppleMailManager();
    expect(mgr.sendEmail(["to@example.com"], "subject", "body")).toBe(false);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].script).toContain("send newMessage");
    expect(h.calls[0].options).toMatchObject({ maxRetries: 1 });
  });

  it("createDraft runs the AppleScript compose with maxRetries: 1", () => {
    const mgr = new AppleMailManager();
    expect(mgr.createDraft(["to@example.com"], "subject", "body")).toBe(false);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].script).toContain("make new outgoing message");
    expect(h.calls[0].options).toMatchObject({ maxRetries: 1 });
  });
});
