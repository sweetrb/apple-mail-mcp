/**
 * Compose scripts must wait for Mail.app to load attachments before they
 * save or send. `make new attachment` returns before the file is in the
 * compose, so an immediate `save`/`send` could drop some or all of the files
 * while still reporting success. create-draft also never saved explicitly,
 * leaving the draft to Mail's autosave.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ script: string; options: Record<string, unknown> | undefined }>,
}));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string, options?: Record<string, unknown>) => {
      h.calls.push({ script, options });
      if (script.includes("make new outgoing message")) {
        // Compose success is `<prefix><the sender Mail used>` since 2.20.13.
        const output = script.includes('return "sent:"')
          ? "sent:Me <me@example.com>"
          : "draft created:Me <me@example.com>";
        return { success: true, output };
      }
      if (script.includes("reply msg") || script.includes("forward msg")) {
        return { success: true, output: "ok" };
      }
      // fetchAccounts: name US addresses US enabled, RS between accounts
      return { success: true, output: "Exchange\x1fme@example.com\x1ftrue" };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

let dir: string;
let a: string;
let b: string;
let c: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "amcp-settle-"));
  a = join(dir, "a.pdf");
  b = join(dir, "b.pdf");
  c = join(dir, "c.pdf");
  for (const p of [a, b, c]) writeFileSync(p, "%PDF-1.4\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  h.calls.length = 0;
});

/** Index of each needle in order, asserting each is present. */
function positions(script: string, ...needles: string[]): number[] {
  return needles.map((n) => {
    const i = script.indexOf(n);
    expect(i, `script is missing "${n}"`).toBeGreaterThanOrEqual(0);
    return i;
  });
}

/** The compose script (account lookups may run before it). */
function compose(): { script: string } {
  const hit = h.calls.find((c) => c.script.includes("make new outgoing message"));
  expect(hit, "no compose script was run").toBeDefined();
  return { script: hit!.script };
}

function expectAscending(xs: number[]): void {
  for (let i = 1; i < xs.length; i++) expect(xs[i - 1]).toBeLessThan(xs[i]);
}

describe("compose scripts wait for attachments before save/send", () => {
  it("create-draft: attach, wait for all files, then save explicitly", () => {
    const mgr = new AppleMailManager();
    expect(
      mgr.createDraft(["x@example.com"], "s", "b", undefined, undefined, undefined, [a, b, c])
    ).toMatchObject({ success: true });
    const { script } = compose();
    expectAscending(
      positions(
        script,
        "make new attachment",
        "count of attachments of content of newMessage",
        "if attachCount >= 3 then exit repeat",
        "set actualSender to sender of newMessage",
        "save newMessage",
        "close newMessage saving yes"
      )
    );
  });

  it("create-draft with an account: same wait before save", () => {
    const mgr = new AppleMailManager();
    mgr.createDraft(["x@example.com"], "s", "b", undefined, undefined, "Exchange", [a]);
    const { script } = compose();
    expectAscending(
      positions(
        script,
        'set sender to "me@example.com"',
        "if attachCount >= 1 then exit repeat",
        "save newMessage"
      )
    );
  });

  it("create-draft without attachments: no wait, but still saved", () => {
    const mgr = new AppleMailManager();
    mgr.createDraft(["x@example.com"], "s", "b");
    const { script } = compose();
    expect(script).not.toContain("attachDeadline");
    expect(script).toContain("save newMessage");
  });

  it("send-email: waits for attachments before send", () => {
    const mgr = new AppleMailManager();
    expect(
      mgr.sendEmail(["x@example.com"], "s", "b", undefined, undefined, undefined, [a, b])
    ).toMatchObject({ success: true });
    const { script } = compose();
    expectAscending(
      positions(
        script,
        "make new attachment",
        "if attachCount >= 2 then exit repeat",
        "set actualSender to sender of newMessage",
        "send newMessage"
      )
    );
  });

  it("reply draft: waits for attachments before save", () => {
    const mgr = new AppleMailManager();
    mgr.replyToMessage("42", "body", false, false, [a, b]);
    const { script } = h.calls[0];
    expectAscending(
      positions(
        script,
        "make new attachment",
        "count of attachments of content of theReply",
        "if attachCount >= 2 then exit repeat",
        "save theReply"
      )
    );
  });

  it("forward draft: waits for attachments before save", () => {
    const mgr = new AppleMailManager();
    mgr.forwardMessage("42", ["x@example.com"], "fyi", false, [a, b, c]);
    const { script } = h.calls[0];
    expectAscending(
      positions(
        script,
        "make new attachment",
        "if attachCount >= 3 then exit repeat",
        "save theForward"
      )
    );
  });

  it("reply without attachments: script has no wait", () => {
    const mgr = new AppleMailManager();
    mgr.replyToMessage("42", "body", false, false);
    expect(h.calls[0].script).not.toContain("attachDeadline");
  });

  it("the wait is bounded so a stuck compose cannot hang past the script timeout", () => {
    const mgr = new AppleMailManager();
    mgr.createDraft(["x@example.com"], "s", "b", undefined, undefined, undefined, [a]);
    const m = compose().script.match(/set attachDeadline to \(current date\) \+ (\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1]) * 1000).toBeLessThan(60000);
  });
});
