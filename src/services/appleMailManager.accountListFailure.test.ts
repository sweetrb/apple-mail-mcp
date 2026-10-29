/**
 * Regression tests for #346 — an unscoped search-messages / list-messages whose
 * account-list read fails must come back `partial`, never as a confirmed empty.
 *
 * With a cold account cache and Mail not answering, `listAccounts()` returns `[]`
 * (#130), the per-account loop runs zero times, and the merged diagnostics used to
 * stay `partial: false` — indistinguishable from "no such mail".
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

const { AppleMailManager, noteAccountListFailure } = await import("./appleMailManager.js");

describe("#346 — failed account-list read is partial, not empty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.result = { success: false, output: "", error: "Mail got an error: AppleEvent timed out." };
  });

  it("searchMessagesWithDiagnostics (no account) reports partial and names the failure", () => {
    const mgr = new AppleMailManager();

    const { messages, diagnostics } = mgr.searchMessagesWithDiagnostics("invoice");

    expect(messages).toEqual([]);
    expect(diagnostics.partial).toBe(true);
    expect(diagnostics.notSearchedMailboxes).toHaveLength(1);
    expect(diagnostics.notSearchedMailboxes[0]).toContain("could not list accounts");
    expect(diagnostics.notSearchedMailboxes[0]).toContain("timed out");
  });

  it("listMessagesWithDiagnostics (no account) reports partial and names the failure", () => {
    const mgr = new AppleMailManager();

    const { messages, diagnostics } = mgr.listMessagesWithDiagnostics();

    expect(messages).toEqual([]);
    expect(diagnostics.partial).toBe(true);
    expect(diagnostics.notSearchedMailboxes[0]).toContain("could not list accounts");
  });

  it("a genuinely empty account list stays a complete (non-partial) empty result", () => {
    const mgr = new AppleMailManager();
    h.result = { success: true, output: "" };

    const { messages, diagnostics } = mgr.searchMessagesWithDiagnostics("invoice");

    expect(messages).toEqual([]);
    expect(diagnostics.partial).toBe(false);
    expect(diagnostics.notSearchedMailboxes).toEqual([]);
  });

  it("noteAccountListFailure marks partial and tolerates a missing error string", () => {
    const diagnostics = {
      partial: false,
      timedOutAccounts: [],
      skippedLargeMailboxes: [],
      notSearchedMailboxes: [] as string[],
    };

    noteAccountListFailure(diagnostics);

    expect(diagnostics.partial).toBe(true);
    expect(diagnostics.notSearchedMailboxes).toEqual([
      "* / *: could not list accounts (unknown error)",
    ]);
  });
});
