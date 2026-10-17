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
    expect(script).toContain("if (address of _rsR) is (_rsA as text)");
  });

  it("fails inside the script when the account has no address, not by falling back", () => {
    mgr.replyToMessage("42", "Reply body", false, true);
    expect(lastScript()).toContain("if (count of _rsAddrs) is 0 then error");
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
