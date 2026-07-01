/**
 * Unit tests for findNumericIdByMessageId — the AppleScript half of the
 * imap:→numeric bridge. Assert the generated script (matches the Message-ID
 * both bracketless and <bracketed>, scopes to the account, checks INBOX first)
 * and that the numeric output is parsed / rejected correctly.
 * executeAppleScript is fully mocked, so no running Mail.app is needed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as string[], output: "ok" }));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string) => {
      h.calls.push(script);
      return { success: true, output: h.output, error: undefined as string | undefined };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

const lastScript = () => h.calls[h.calls.length - 1] ?? "";

describe("findNumericIdByMessageId (imap→numeric bridge)", () => {
  let mgr: AppleMailManager;
  beforeEach(() => {
    h.calls.length = 0;
    h.output = "ok";
    mgr = new AppleMailManager();
  });

  it("returns the numeric id and matches both bracketless and bracketed Message-ID", () => {
    h.output = "204236";
    const n = mgr.findNumericIdByMessageId("<abc@ex.com>", "rob@superiortech.io");
    const s = lastScript();
    expect(s).toContain('whose message id is "abc@ex.com"');
    expect(s).toContain('message id is "<abc@ex.com>"');
    expect(s).toContain('every account whose name is "rob@superiortech.io"');
    expect(s).toContain('mailbox "INBOX" of acct'); // INBOX-first fast path
    expect(n).toBe("204236");
  });

  it("scopes to all accounts when no account name is given", () => {
    h.output = "5";
    mgr.findNumericIdByMessageId("abc@ex.com");
    expect(lastScript()).toContain("set acctList to accounts");
  });

  it("returns null when Mail reports the message is not found", () => {
    h.output = "error:Message not found";
    expect(mgr.findNumericIdByMessageId("abc@ex.com")).toBeNull();
  });

  it("returns null when the output is not a bare numeric id", () => {
    h.output = "ok";
    expect(mgr.findNumericIdByMessageId("abc@ex.com")).toBeNull();
  });

  it("returns null for an empty/blank Message-ID without invoking AppleScript", () => {
    expect(mgr.findNumericIdByMessageId("   ")).toBeNull();
    expect(h.calls.length).toBe(0);
  });

  it("escapes embedded quotes/backslashes in the Message-ID literal", () => {
    h.output = "1";
    mgr.findNumericIdByMessageId('a"b\\c@ex.com');
    const s = lastScript();
    expect(s).toContain('a\\"b\\\\c@ex.com');
  });
});
