import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as { script: string; options: unknown }[],
  preflight: vi.fn(),
  insert: vi.fn(),
  subject: "Re: Original — ç  ",
  creationFailure: false,
  finalFailure: false,
  sendRejected: false,
  draftSaveTimeout: false,
  sender: "sender@example.com",
  recipients: "to:14:to@example.comcc:bcc:",
}));

vi.mock("@/services/nativeMailComposer.js", () => ({
  nativeEditorPreflight: h.preflight,
  insertNativeAuthoredBody: h.insert,
}));
vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string, options: unknown) => {
      h.calls.push({ script, options });
      if (script.includes('return "native-compose:"')) {
        if (h.creationFailure) return { success: true, output: "error:ambiguous sender" };
        const end = script.match(/_nativeSubject & "([^"]+)"/)![1];
        return {
          success: true,
          output: `native-compose:81\n${h.sender}\n${h.recipients}\n${h.subject}${end}`,
        };
      }
      if (script.includes('return "native-finalized"')) {
        if (h.draftSaveTimeout) {
          return {
            success: true,
            output:
              "error:Mail did not confirm the draft in Drafts within 10s; its compose window was left open so the draft is not lost.",
          };
        }
        if (h.sendRejected) {
          return { success: true, output: "error:Mail did not accept the native send" };
        }
        return h.finalFailure
          ? { success: false, output: "", error: "timeout" }
          : { success: true, output: "native-finalized" };
      }
      return { success: true, output: "Work\x1fsender@example.com\x1ftrue" };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

const creation = () => h.calls.find((c) => c.script.includes('return "native-compose:"'))!.script;
const finalization = () =>
  h.calls.find((c) => c.script.includes('return "native-finalized"'))!.script;

describe("native editor compose orchestration", () => {
  let manager: AppleMailManager;
  beforeEach(() => {
    h.calls.length = 0;
    h.preflight.mockReset().mockReturnValue({ success: true });
    h.insert.mockReset().mockReturnValue({ success: true });
    h.creationFailure = false;
    h.finalFailure = false;
    h.sendRejected = false;
    h.draftSaveTimeout = false;
    h.sender = "sender@example.com";
    h.subject = "Re: Original — ç  ";
    manager = new AppleMailManager();
    manager.noteMessageLocation("42", "Work", "INBOX");
  });

  const send = (manager: AppleMailManager) =>
    manager.sendEmail(
      ["to@example.com"],
      "Subject",
      "Authored body\n\nSecond paragraph",
      undefined,
      undefined,
      "Work",
      undefined,
      true
    );

  it("requires an explicit new-message identity without composing", () => {
    expect(
      manager.createDraft(
        ["to@example.com"],
        "Subject",
        "Body",
        undefined,
        undefined,
        undefined,
        undefined,
        true
      ).success
    ).toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it.each(["send", "draft", "reply", "forward"])(
    "preflight failure creates nothing for %s",
    (kind) => {
      h.preflight.mockReturnValue({ success: false, error: "Accessibility unavailable" });
      const result =
        kind === "send"
          ? send(manager)
          : kind === "draft"
            ? manager.createDraft([], "s", "b", undefined, undefined, "Work", undefined, true)
            : kind === "reply"
              ? manager.replyToMessage("42", "b", false, true, undefined, true)
              : manager.forwardMessage("42", ["to@example.com"], "b", true, undefined, true);
      expect(result).toEqual({ success: false, error: "Accessibility unavailable" });
      expect(h.calls).toHaveLength(0);
    }
  );

  it("creates no body, inserts authored text through the bridge, and sends once", () => {
    expect(send(manager)).toEqual({ success: true, from: "sender@example.com" });
    expect(creation()).toContain("make new outgoing message");
    expect(creation()).not.toMatch(/content:|set content/);
    expect(creation()).not.toContain("Authored body");
    expect(h.insert).toHaveBeenCalledWith({
      messageId: 81,
      markerSubject: expect.stringMatching(/^MCP Native /),
      body: "Authored body\n\nSecond paragraph",
      expectedSender: "sender@example.com",
    });
    expect(finalization().match(/send _nativeMessage/g)).toHaveLength(1);
    expect(finalization()).not.toContain("priorDraftIds");
    for (const call of h.calls.filter((c) => c.script.includes('return "native-'))) {
      expect(call.options).toMatchObject({ maxRetries: 1 });
    }
  });

  it("guards exact outgoing ID, marker, sender, and all recipient lists before restoring subject", () => {
    send(manager);
    const script = finalization();
    expect(script).toContain("every outgoing message whose id is 81");
    expect(script).toContain("(count of _nativeMatches) is not 1");
    expect(script).toContain(`is not "${h.insert.mock.calls[0][0].markerSubject}"`);
    expect(script).toContain('is "sender@example.com"');
    expect(script).toContain("to:14:to@example.comcc:bcc:");
    expect(script).toContain('set subject of _nativeMessage to ("Re: Original — ç  ")');
    expect(script.indexOf("recipients changed")).toBeLessThan(script.indexOf("set subject"));
    expect(script).not.toContain("delete ");
  });

  it("bridge failure leaves the compose and never sends, saves, closes, or deletes", () => {
    h.insert.mockReturnValue({ success: false, error: "Editor unavailable" });
    expect(send(manager)).toEqual({ success: false, error: "Editor unavailable" });
    expect(
      h.calls.some((c) =>
        /send _nativeMessage|save _nativeMessage|close _nativeMessage|delete _nativeMessage/.test(
          c.script
        )
      )
    ).toBe(false);
  });

  it("does not retry an uncertain final send", () => {
    h.finalFailure = true;
    expect(send(manager).success).toBe(false);
    expect(h.calls.filter((c) => c.script.includes("send _nativeMessage"))).toHaveLength(1);
  });

  it("requires Mail's send command to return true and never retries a rejected send", () => {
    h.sendRejected = true;
    expect(send(manager).success).toBe(false);
    const script = finalization();
    expect(script).toContain("set _nativeSent to send _nativeMessage");
    expect(script).toContain('if _nativeSent is not true then error "Mail did not accept');
    expect(script.indexOf("if _nativeSent is not true")).toBeLessThan(
      script.indexOf('return "native-finalized"')
    );
    expect(h.calls.filter((c) => c.script.includes("send _nativeMessage"))).toHaveLength(1);
  });

  it("refuses corrupted creation identity before paste or finalization", () => {
    h.sender = "wrong@example.com";
    expect(send(manager).success).toBe(false);
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.calls.some((c) => c.script.includes("send _nativeMessage"))).toBe(false);
  });

  it("uses the exact parent native Reply and preserves Mail's generated subject", () => {
    expect(manager.replyToMessage("42", "Reply body", true, false, undefined, true).success).toBe(
      true
    );
    expect(creation()).toContain("messages of _tmb whose id is 42");
    expect(creation()).toContain("reply msg with opening window with reply to all");
    expect(creation()).toContain("set _nativeSubject to subject of _nativeMessage as text");
    expect(creation()).not.toContain('subject:"Re:');
    expect(creation()).not.toMatch(/content:|set content/);
    expect(finalization()).toContain("save _nativeMessage");
    expect(finalization()).toContain("repeat until draftSaved");
    expect(finalization()).not.toContain("send _nativeMessage");
  });

  it("pins native replies to explicit source scope even when a different location is cached", () => {
    const source = { account: "Proton", mailbox: "Sent", messageId: "parent@example.com" };
    expect(
      manager.replyToMessage("42", "Body", false, false, undefined, true, source).success
    ).toBe(true);
    expect(creation()).toContain('if (name of _a) is "Proton"');
    expect(creation()).toContain('if _mPath is "Sent"');
    expect(creation()).not.toContain('if (name of _a) is "Work"');
    expect(creation()).toContain('set _expectedMessageId to "parent@example.com"');
    expect(creation().indexOf("set _actualMessageId")).toBeLessThan(
      creation().indexOf("reply msg with opening window")
    );
  });

  it("binds an explicitly scoped native reply to a unique local mailbox", () => {
    const source = { account: "On My Mac", mailbox: "Import", messageId: "parent@example.com" };
    expect(
      manager.replyToMessage("42", "Body", false, false, undefined, true, source).success
    ).toBe(true);
    expect(creation()).toContain("account of _m) is missing value");
    expect(creation()).toContain("repeat with _m in _mbs");
    expect(creation()).toContain("if (count of _mbM) is 1 then set _tmb to item 1 of _mbM");
    expect(creation()).not.toContain("repeat with _a in accounts");
  });

  it("resolves ambiguous parent senders before creating the native reply", () => {
    h.creationFailure = true;
    expect(manager.replyToMessage("42", "Body", false, true, undefined, true).success).toBe(false);
    expect(creation().indexOf("Cannot uniquely resolve")).toBeLessThan(
      creation().indexOf("reply msg with opening window")
    );
    expect(creation()).toContain("(count of _nativeMatches) is 1");
    expect(creation()).not.toContain("delete ");
    expect(h.insert).not.toHaveBeenCalled();
  });

  const saveDraft = (manager: AppleMailManager, kind: string) =>
    kind === "new"
      ? manager.createDraft(
          ["to@example.com"],
          "Subject",
          "Body",
          undefined,
          undefined,
          "Work",
          undefined,
          true
        )
      : kind === "reply"
        ? manager.replyToMessage("42", "Body", false, false, undefined, true)
        : manager.forwardMessage("42", ["to@example.com"], "Body", false, undefined, true);

  it.each(["new", "reply", "forward"])(
    "confirms a new stored draft ID before closing a native %s draft",
    (kind) => {
      expect(saveDraft(manager, kind).success).toBe(true);
      const script = finalization();
      expect(script).toContain("id of (messages of drafts mailbox whose subject is draftSubject)");
      expect(script.indexOf("set subject of _nativeMessage")).toBeLessThan(
        script.indexOf("set priorDraftIds")
      );
      expect(script.indexOf("set priorDraftIds")).toBeLessThan(
        script.indexOf("save _nativeMessage")
      );
      expect(script).toContain(
        "if priorDraftIds does not contain (contents of draftId) then set draftSaved to true"
      );
      expect(script.indexOf("repeat until draftSaved")).toBeLessThan(
        script.indexOf("close _nativeMessage saving yes")
      );
      expect(script.indexOf('return "error:Mail did not confirm')).toBeLessThan(
        script.indexOf("close _nativeMessage saving yes")
      );
      expect(script).not.toContain("send _nativeMessage");
    }
  );

  it.each(["new", "reply", "forward"])(
    "reports an unconfirmed native %s draft without retrying",
    (kind) => {
      h.draftSaveTimeout = true;
      const result = saveDraft(manager, kind);
      expect(result.success).toBe(false);
      expect(result.error).toContain("inspect Sent, Outbox, and Drafts before retrying");
      expect(h.calls.filter((c) => c.script.includes('return "native-finalized"'))).toHaveLength(1);
    }
  );

  it("forwards the original natively without rebuilding its history", () => {
    expect(
      manager.forwardMessage("42", ["to@example.com"], "New note", false, undefined, true).success
    ).toBe(true);
    expect(creation()).toContain("forward msg with opening window");
    expect(creation()).not.toContain("New note");
    expect(creation()).not.toMatch(/content:|set content/);
  });

  it("preserves control characters in the original subject during restoration", () => {
    h.subject = "Subject\ncontinued\t  ";
    send(manager);
    expect(finalization()).toContain(
      '("Subject" & (character id 10) & "continued" & (character id 9) & "  ")'
    );
  });

  it("rejects unsafe attachments before creating the compose", () => {
    expect(() =>
      manager.createDraft([], "s", "b", undefined, undefined, "Work", ["/etc/hosts"], true)
    ).toThrow(/outside the allowed read roots/);
    expect(h.calls.some((c) => c.script.includes("make new outgoing message"))).toBe(false);
  });

  it("appends attachments only after paste and checks the original-plus-added count", () => {
    expect(
      manager.createDraft(
        [],
        "s",
        "b",
        undefined,
        undefined,
        "Work",
        [{ filename: "note.txt", contentBase64: "aGVsbG8=" }],
        true
      ).success
    ).toBe(true);
    expect(creation()).not.toContain("make new attachment");
    const script = finalization();
    expect(script).toContain("make new attachment");
    expect(script).toContain("(count of attachments of content of _nativeMessage) + 1");
    expect(script).toContain("attachCount >= _nativeExpectedAttachments");
    expect(script).toContain("if attachCount < _nativeExpectedAttachments then error");
    expect(script).not.toMatch(/content:|set content/);
    expect(script.match(/Native compose recipients changed/g)).toHaveLength(2);
  });
});
