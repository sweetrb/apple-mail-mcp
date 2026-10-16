/**
 * An explicit `account` pins the sender to ONE resolved address and the compose
 * script reads `sender` back before it sends or saves; an account that matches
 * nothing never reaches a `send`, and a refusing guard answer is a failure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  scripts: [] as string[],
  composeOutput: "sent:Cory <mrcoryzhao@gmail.com>",
}));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string) => {
      h.scripts.push(script);
      if (script.includes("make new outgoing message")) {
        return { success: true, output: h.composeOutput };
      }
      // fetchAccounts: name US addresses (FS-joined) US enabled, RS between accounts
      return {
        success: true,
        output:
          "mrcoryzhao@gmail\x1fmrcoryzhao@gmail.com\x1ftrue\x1ecoryzhao@icloud\x1fcoryzhao@icloud.com\x1cCory@Me.com\x1ftrue",
      };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

afterEach(() => {
  h.scripts.length = 0;
  h.composeOutput = "sent:Cory <mrcoryzhao@gmail.com>";
});

const compose = () => h.scripts.filter((s) => s.includes("make new outgoing message"));

describe("sender guard on AppleScript compose", () => {
  it("account name → set sender to the resolved address, guard before send, actual sender reported", () => {
    const r = new AppleMailManager().sendEmail(
      ["to@example.com"],
      "s",
      "b",
      undefined,
      undefined,
      "mrcoryzhao@gmail"
    );
    expect(r).toEqual({ success: true, from: "Cory <mrcoryzhao@gmail.com>" });
    const [script] = compose();
    expect(script).toContain('set sender to "mrcoryzhao@gmail.com"');
    expect(script).toContain("delete newMessage");
    const guardAt = script.indexOf("error:Mail.app would send as");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(script.indexOf("send newMessage"));
  });

  it("every address of an account resolves, not just the first (alias as sender)", () => {
    new AppleMailManager().createDraft(
      ["to@example.com"],
      "s",
      "b",
      undefined,
      undefined,
      "cory@me.com"
    );
    expect(compose()[0]).toContain('set sender to "Cory@Me.com"');
  });

  it("serial send with an unresolvable account fails every recipient once, without composing", () => {
    const rs = new AppleMailManager().sendSerialEmail(
      [
        { email: "a@example.com", variables: {} },
        { email: "b@example.com", variables: {} },
      ],
      "s",
      "b",
      "nobody@example.invalid",
      0
    );
    expect(rs.map((r) => r.success)).toEqual([false, false]);
    expect(compose()).toHaveLength(0);
  });

  it("unmatched account → error, no compose script ran at all", () => {
    const r = new AppleMailManager().sendEmail(
      ["to@example.com"],
      "s",
      "b",
      undefined,
      undefined,
      "nobody@example.invalid"
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/nothing was sent/);
    expect(compose()).toHaveLength(0);
  });

  it("guard reports a mismatch → failure with the actual sender, for send and for draft", () => {
    h.composeOutput =
      "error:Mail.app would send as Cory <coryzhao@icloud.com> instead of mrcoryzhao@gmail.com, so nothing was sent or saved.";
    const m = new AppleMailManager();
    for (const r of [
      m.sendEmail(["to@example.com"], "s", "b", undefined, undefined, "mrcoryzhao@gmail"),
      m.createDraft(["to@example.com"], "s", "b", undefined, undefined, "mrcoryzhao@gmail"),
    ]) {
      expect(r.success).toBe(false);
      expect(r.error).toContain("coryzhao@icloud.com");
    }
  });

  it("no account → no pin, no account lookup, but the sender Mail picked is still read back", () => {
    const r = new AppleMailManager().sendEmail(["to@example.com"], "s", "b");
    expect(r.success).toBe(true);
    expect(h.scripts).toHaveLength(1);
    expect(h.scripts[0]).not.toContain("set sender");
    expect(h.scripts[0]).toContain("sender of newMessage");
  });
});
