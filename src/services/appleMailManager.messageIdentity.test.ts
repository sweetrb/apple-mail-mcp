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

    expect(mgr.replyToMessage("42", "Reply body", false, false)).toBe(true);
    let script = lastScript();
    expect(script).toContain('if (name of _a) is "work@example.com"');
    expect(script).toContain('if (name of _m) is "INBOX"');
    expect(script).toContain("messages of _tmb whose id is 42");
    expect(script).toContain("reply msg without opening window");
    expect(script).not.toContain("messages of mb whose id is 42");

    h.calls.length = 0;
    expect(mgr.forwardMessage("42", ["recipient@example.com"], undefined, false)).toBe(true);
    script = lastScript();
    expect(script).toContain("messages of _tmb whose id is 42");
    expect(script).toContain("forward msg without opening window");
    expect(script).not.toContain("messages of mb whose id is 42");
  });

  it("does not read an arbitrary first match when an id has no recorded location", () => {
    h.output =
      "error:Message id 42 is present in more than one mailbox (Work/INBOX, Work/All Mail); list or search that mailbox first so the read targets the right copy";
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
      "error:Message id 42 is present in more than one mailbox (Work/INBOX, Work/All Mail); list or search that mailbox first so the read targets the right copy";
    expect(mgr.getMessageContent("42")).toBeNull();
    script = lastScript();
    expect(script).toContain("set _hits to {}");
    expect(script).toContain("if (count of _hits) > 1 then");
    expect(script).toContain("if (count of _hits) is 1 then");
    expect(mgr.consumeLastMessageLookupError()).toMatch(
      /^Message id 42 is present in more than one mailbox/
    );
  });
});
