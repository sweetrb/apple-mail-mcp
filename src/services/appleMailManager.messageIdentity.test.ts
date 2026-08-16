/**
 * Regression guards for by-id message identity.
 *
 * A numeric Mail.app id can appear in more than one mailbox (for example, a
 * Gmail label and All Mail). Message reads and reply/forward mutations must
 * use the same location-aware resolver as the other by-id mutations instead
 * of silently taking the first mailbox encountered.
 *
 * executeAppleScript is mocked, so these tests inspect generated AppleScript
 * without requiring a running Mail.app instance.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as string[], output: "" }));

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

describe("by-id message identity", () => {
  let mgr: AppleMailManager;

  beforeEach(() => {
    h.calls.length = 0;
    h.output = "";
    mgr = new AppleMailManager();
  });

  it("uses the recorded mailbox resolver for replies and forwards", () => {
    h.output = "ok";
    mgr.noteMessageLocation("42", "work@example.com", "INBOX");

    expect(mgr.replyToMessage("42", "Reply body", false, false)).toMatchObject({ success: true });
    let script = lastScript();
    expect(script).toContain('if (name of _a) is "work@example.com"');
    expect(script).toContain('if (name of _m) is "INBOX"');
    expect(script).toContain("messages of _tmb whose id is 42");
    expect(script).toContain("reply msg without opening window");
    expect(script).not.toContain("messages of mb whose id is 42");

    h.calls.length = 0;
    expect(mgr.forwardMessage("42", ["recipient@example.com"], undefined, false)).toMatchObject({
      success: true,
    });
    script = lastScript();
    expect(script).toContain("messages of _tmb whose id is 42");
    expect(script).toContain("forward msg without opening window");
    expect(script).not.toContain("messages of mb whose id is 42");
  });

  it("uses the recorded mailbox resolver for message reads", () => {
    mgr.noteMessageLocation("42", "work@example.com", "INBOX");

    h.output = "Subject\x1dMSGID\x1d<id@example.com>\x1dCONTENT\x1dbody\x1dHTML\x1d";
    expect(mgr.getMessageContent("42")).toMatchObject({
      id: "42",
      subject: "Subject",
      plainText: "body",
      rfcMessageId: "id@example.com",
    });
    let script = lastScript();
    expect(script).toContain('first account whose name is "work@example.com"');
    expect(script).toContain('if (name of mb) is "INBOX" then');
    expect(script).toContain("messages of targetMb whose id is 42");
    expect(script).not.toContain("messages of mb whose id is 42");

    h.calls.length = 0;
    h.output = "raw MIME source";
    expect(mgr.getRawSource("42")).toBe("raw MIME source");
    script = lastScript();
    expect(script).toContain('first account whose name is "work@example.com"');
    expect(script).toContain('if (name of mb) is "INBOX" then');
    expect(script).toContain("messages of targetMb whose id is 42");
    expect(script).not.toContain("messages of mb whose id is 42");
  });

  it("does not read an arbitrary first match when an id has no recorded location", () => {
    h.output =
      "\x1dERR\x1dMessage id 42 is present in more than one mailbox (Work/INBOX, Work/All Mail); list or search that mailbox first so the read targets the right copy";
    expect(mgr.getRawSource("42")).toBeNull();
    let script = lastScript();
    expect(script).toContain("set _hits to {}");
    expect(script).toContain('set _names to ""');
    expect(script).toContain("if (count of _hits) > 1 then");
    expect(script).toContain("if (count of _hits) is 1 then");
    expect(script.indexOf("return source of msg")).toBeGreaterThan(
      script.indexOf("if (count of _hits) is 1 then")
    );
    expect(mgr.consumeLastMessageLookupError()).toMatch(
      /^Message id 42 is present in more than one mailbox/
    );

    h.calls.length = 0;
    h.output =
      "\x1dERR\x1dMessage id 42 is present in more than one mailbox (Work/INBOX, Work/All Mail); list or search that mailbox first so the read targets the right copy";
    expect(mgr.getMessageContent("42")).toBeNull();
    script = lastScript();
    expect(script).toContain("set _hits to {}");
    expect(script).toContain("if (count of _hits) > 1 then");
    expect(script).toContain("if (count of _hits) is 1 then");
    expect(mgr.consumeLastMessageLookupError()).toMatch(
      /^Message id 42 is present in more than one mailbox/
    );
  });
  it("does not mistake a sender-controlled subject for a lookup failure", () => {
    // The success payload of the read script leads with `subject`, which is
    // whatever the sender wrote. A bare `error:` text prefix as the failure
    // signal therefore collides with legitimate mail: any message whose subject
    // starts with `error:` became permanently unreadable via get-message, and
    // the remainder of its own payload was reported as the lookup error.
    mgr.noteMessageLocation("42", "work@example.com", "INBOX");
    h.output =
      "error:Message not found\x1dMSGID\x1d<hostile@example.com>\x1dCONTENT\x1dbody text\x1dHTML\x1d";

    expect(mgr.getMessageContent("42")).toMatchObject({
      id: "42",
      subject: "error:Message not found",
      plainText: "body text",
      rfcMessageId: "hostile@example.com",
    });
    expect(mgr.consumeLastMessageLookupError()).toBeUndefined();
  });

  it("does not mistake raw source that opens with error: for a lookup failure", () => {
    mgr.noteMessageLocation("42", "work@example.com", "INBOX");
    h.output = "error:Message not found\r\nFrom: sender@example.com\r\n\r\nbody";

    expect(mgr.getRawSource("42")).toBe(
      "error:Message not found\r\nFrom: sender@example.com\r\n\r\nbody"
    );
    expect(mgr.consumeLastMessageLookupError()).toBeUndefined();
  });
});

describe("reply/forward draft safety", () => {
  let mgr: AppleMailManager;

  beforeEach(() => {
    h.calls.length = 0;
    h.output = "ok";
    mgr = new AppleMailManager();
    mgr.noteMessageLocation("42", "work@example.com", "INBOX");
  });

  // Found by an end-to-end regression run: `send: false` is documented as
  // "save as draft", but the generated script only created the outgoing
  // message and set its content — it never saved. Mail.app was left holding an
  // unsaved compose window, pre-addressed and pre-filled, one click from
  // sending, while the tool reported ok. During the run that window was
  // addressed to a THIRD PARTY, which is why this is a safety fix and not a
  // tidiness one.
  it("SAVES the draft when send is false, for replies", () => {
    mgr.replyToMessage("42", "body", false, false);
    const script = lastScript();
    expect(script).toContain("save theReply");
    expect(script).not.toContain("send theReply");
  });

  it("SAVES the draft when send is false, for forwards", () => {
    mgr.forwardMessage("42", ["someone@example.com"], "body", false);
    const script = lastScript();
    expect(script).toContain("save theForward");
    expect(script).not.toContain("send theForward");
  });

  it("still sends, and does not save, when send is true", () => {
    mgr.replyToMessage("42", "body", false, true);
    let script = lastScript();
    expect(script).toContain("send theReply");
    expect(script).not.toContain("save theReply");

    h.calls.length = 0;
    mgr.forwardMessage("42", ["someone@example.com"], "body", true);
    script = lastScript();
    expect(script).toContain("send theForward");
    expect(script).not.toContain("save theForward");
  });

  // The failure this hid: Mail's real reason ("present in more than one
  // mailbox…", "Message not found") was logged to stderr and replaced with a
  // bare "Failed to reply to message X", so a caller could not tell an
  // ambiguous id from a missing one from a transport error.
  it("returns Mail's actual error text instead of swallowing it", () => {
    h.output =
      "error:This message id is present in more than one mailbox (a/INBOX, a/All Mail); list or search that mailbox first";
    const r = mgr.replyToMessage("42", "body", false, true);
    expect(r.success).toBe(false);
    expect(r.error).toContain("present in more than one mailbox");

    const f = mgr.forwardMessage("42", ["x@example.com"], "body", true);
    expect(f.success).toBe(false);
    expect(f.error).toContain("present in more than one mailbox");
  });

  it("reports success as a structured result", () => {
    h.output = "ok";
    expect(mgr.replyToMessage("42", "body", false, false)).toMatchObject({ success: true });
    expect(mgr.forwardMessage("42", ["x@example.com"], "body", false)).toMatchObject({
      success: true,
    });
  });
});
