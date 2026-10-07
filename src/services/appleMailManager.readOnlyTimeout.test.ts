/**
 * Regression tests for #270 — a numeric id whose AppleScript resolution is
 * wedged (observed after a reply draft was created from it via
 * reply-to-message and the original was then moved to Deleted Messages) hung
 * every subsequent read for the full 60-120s mutation/compose timeout, with
 * no diagnostic beyond a bare "Operation timed out" message.
 *
 * Asserts two things, with executeAppleScript fully mocked (no running
 * Mail.app needed):
 *   1) the READ-ONLY by-id lookups (getMessageById, getMessageContent,
 *      getMessageHeaders, getRawSource) now pass a much shorter
 *      `READ_ONLY_BYID_TIMEOUT_MS` (15s) to executeAppleScript, and surface a
 *      specific, actionable error (naming the id, pointing at health-check)
 *      when that timeout fires; and
 *   2) a MUTATION path (markAsRead, via findMessageScript) is untouched —
 *      still passes the original 60s — since a retried mutation could
 *      duplicate work Mail.app already accepted.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type ScriptResult = {
  success: boolean;
  output: string;
  error?: string;
  timedOut?: boolean;
};

const h = vi.hoisted(() => ({
  calls: [] as Array<{ script: string; options: Record<string, unknown> | undefined }>,
  router: {
    fn: (_script: string, _options?: Record<string, unknown>): ScriptResult => ({
      success: true,
      output: "",
      error: undefined,
    }),
  },
}));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string, options?: Record<string, unknown>) => {
      h.calls.push({ script, options });
      return h.router.fn(script, options);
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

const READ_ONLY_BYID_TIMEOUT_MS = 15000;
const MUTATION_TIMEOUT_MS = 60000;

describe("#270 — read-only by-id lookups use a short, fail-fast timeout", () => {
  let mgr: AppleMailManager;

  beforeEach(() => {
    h.calls.length = 0;
    h.router.fn = () => ({ success: true, output: "", error: undefined });
    mgr = new AppleMailManager();
  });

  it("getMessageById passes the short read-only timeout", () => {
    h.router.fn = () => ({ success: true, output: "", error: undefined });
    mgr.getMessageById("42");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].options).toEqual({ timeoutMs: READ_ONLY_BYID_TIMEOUT_MS });
  });

  it("getMessageContent (unscoped, no hint) passes the short read-only timeout", () => {
    h.router.fn = () => ({ success: true, output: "", error: undefined });
    mgr.getMessageContent("42");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].options).toEqual({ timeoutMs: READ_ONLY_BYID_TIMEOUT_MS });
  });

  it("getMessageHeaders (unscoped, no hint) passes the short read-only timeout", () => {
    h.router.fn = () => ({ success: true, output: "", error: undefined });
    mgr.getMessageHeaders("42");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].options).toEqual({ timeoutMs: READ_ONLY_BYID_TIMEOUT_MS });
  });

  it("getRawSource (unscoped, no hint) passes the short read-only timeout", () => {
    h.router.fn = () => ({ success: true, output: "", error: undefined });
    mgr.getRawSource("42");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].options).toEqual({ timeoutMs: READ_ONLY_BYID_TIMEOUT_MS });
  });

  it("surfaces a specific, actionable error when the lookup times out (getMessageContent)", () => {
    h.router.fn = () => ({
      success: false,
      output: "",
      error: "Operation timed out after 15 seconds. Mail.app may be unresponsive.",
      timedOut: true,
    });
    const content = mgr.getMessageContent("270");
    expect(content).toBeNull();
    expect(mgr.consumeLastMessageLookupError()).toBe(
      "AppleScript timed out resolving id 270 — Mail.app's scripting bridge may be wedged; try health-check."
    );
    // consumeLastMessageLookupError() clears it.
    expect(mgr.consumeLastMessageLookupError()).toBeUndefined();
  });

  it("surfaces the same actionable error on timeout for getMessageById", () => {
    h.router.fn = () => ({
      success: false,
      output: "",
      error: "Operation timed out after 15 seconds. Mail.app may be unresponsive.",
      timedOut: true,
    });
    const msg = mgr.getMessageById("270");
    expect(msg).toBeNull();
    expect(mgr.consumeLastMessageLookupError()).toBe(
      "AppleScript timed out resolving id 270 — Mail.app's scripting bridge may be wedged; try health-check."
    );
  });

  it("surfaces the same actionable error on timeout for getMessageHeaders", () => {
    h.router.fn = () => ({
      success: false,
      output: "",
      error: "Operation timed out after 15 seconds. Mail.app may be unresponsive.",
      timedOut: true,
    });
    const headers = mgr.getMessageHeaders("270");
    expect(headers).toBeNull();
    expect(mgr.consumeLastMessageLookupError()).toBe(
      "AppleScript timed out resolving id 270 — Mail.app's scripting bridge may be wedged; try health-check."
    );
  });

  it("surfaces the same actionable error on timeout for getRawSource", () => {
    h.router.fn = () => ({
      success: false,
      output: "",
      error: "Operation timed out after 15 seconds. Mail.app may be unresponsive.",
      timedOut: true,
    });
    const raw = mgr.getRawSource("270");
    expect(raw).toBeNull();
    expect(mgr.consumeLastMessageLookupError()).toBe(
      "AppleScript timed out resolving id 270 — Mail.app's scripting bridge may be wedged; try health-check."
    );
  });

  it("does NOT set the actionable timeout error for an ordinary (non-timeout) AppleScript failure", () => {
    h.router.fn = () => ({
      success: false,
      output: "",
      error: "execution error: Some other AppleScript problem (-1234)",
      // timedOut deliberately omitted/false
    });
    const content = mgr.getMessageContent("42");
    expect(content).toBeNull();
    expect(mgr.consumeLastMessageLookupError()).toBeUndefined();
  });

  it("does NOT shorten a mutation path (markAsRead) — stays at the original 60s", () => {
    h.router.fn = () => ({ success: true, output: "ok", error: undefined });
    mgr.markAsRead("42");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].options).toEqual({ timeoutMs: MUTATION_TIMEOUT_MS });
  });
});
