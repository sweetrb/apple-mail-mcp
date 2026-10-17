/**
 * A reply or forward leaves from the account the message arrived in.
 *
 * `reply msg without opening window` does not set a sender, so Mail answered
 * from its default sending account: a mail received in one account was answered
 * from another (2026-10-11). `forward msg` has the same default. The script must
 * fix the sender to the address the original was sent to, before the content is
 * set, and must not fall back silently.
 *
 * executeAppleScript is mocked, so these tests inspect the generated AppleScript.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("reply sender", () => {
  let mgr: AppleMailManager;

  beforeEach(() => {
    h.calls.length = 0;
    mgr = new AppleMailManager();
    mgr.noteMessageLocation("42", "Nopuedomas", "INBOX");
  });

  it("sets the sender from the account of the original, before the content", () => {
    expect(mgr.replyToMessage("42", "Reply body", false, false)).toMatchObject({ success: true });
    const script = lastScript();
    expect(script).toContain("email addresses of (account of (mailbox of msg))");
    expect(script).toContain("set sender of theReply to _rsFrom");
    expect(script.indexOf("set sender of theReply")).toBeLessThan(
      script.indexOf("set content of theReply")
    );
  });

  it("prefers the recipient address that belongs to the account", () => {
    mgr.replyToMessage("42", "Reply body", true, false);
    const script = lastScript();
    expect(script).toContain("(to recipients of msg) & (cc recipients of msg)");
    expect(script).toContain("if (_rsC as text) is (_rsA as text)");
  });

  it("a reply to the user's own sent message keeps its From address", () => {
    mgr.replyToMessage("42", "Reply body", false, false);
    const script = lastScript();
    // Recipients first (received mail), then the original's sender (sent mail).
    const rcpt = script.indexOf("(to recipients of msg) & (cc recipients of msg)");
    const from = script.indexOf("extract address from (sender of msg)");
    expect(rcpt).toBeGreaterThanOrEqual(0);
    expect(from).toBeGreaterThan(rcpt);
  });

  it("fails inside the script when the account has no address, not by falling back", () => {
    mgr.replyToMessage("42", "Reply body", false, true);
    expect(lastScript()).toContain("if _rsOwn and (count of _rsAddrs) is 0 then error");
  });

  it("an On My Mac message (no account) matches recipients across enabled accounts", () => {
    mgr.replyToMessage("42", "Reply body", false, false);
    const script = lastScript();
    // The account lookup is guarded; its failure path widens to every enabled account
    // and leaves the sender to Mail when nothing matches, instead of hard-failing.
    expect(script).toMatch(
      /try\s+set _rsAddrs to email addresses of \(account of \(mailbox of msg\)\)\s+set _rsN to count of _rsAddrs\s+on error\s+set _rsOwn to false/
    );
    expect(script).toContain("every account whose enabled is true");
    expect(script).toContain('if _rsFrom is not "" then');
  });

  it("reads the sender back and refuses when Mail did not take it", () => {
    mgr.replyToMessage("42", "Reply body", false, true);
    const script = lastScript();
    const set = script.indexOf("set sender of theReply to _rsFrom");
    const read = script.indexOf("set _rsGot to sender of theReply as text");
    expect(set).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(set);
    expect(script).toContain('_rsGot ends with "<" & _rsFrom & ">"');
    expect(script.indexOf("delete theReply")).toBeLessThan(script.indexOf("send theReply"));
  });

  it("sets the sender of a forward from the account of the original, before the content", () => {
    expect(mgr.forwardMessage("42", ["to@example.com"], "Fwd body", false)).toMatchObject({
      success: true,
    });
    const script = lastScript();
    expect(script).toContain("email addresses of (account of (mailbox of msg))");
    expect(script).toContain("set sender of theForward to _rsFrom");
    expect(script).toContain("has no email address to forward from.");
    expect(script.indexOf("set sender of theForward")).toBeLessThan(
      script.indexOf("set content of theForward")
    );
  });
});
