/**
 * #267 — the AppleScript reply/forward scripts attach files AFTER setting the
 * content and BEFORE save/send, inline base64 items exist as 0600 temp files
 * only for the duration of the script, and both compose verbs are
 * single-attempt (a retried `send` could deliver twice).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ script: string; options: Record<string, unknown> | undefined }>,
  /** Per-call snapshot of every `POSIX file "..."` path: [path, exists, mode]. */
  seen: [] as Array<[string, boolean, number]>,
}));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  const fs = await import("node:fs");
  return {
    ...actual,
    executeAppleScript: (script: string, options?: Record<string, unknown>) => {
      h.calls.push({ script, options });
      for (const m of script.matchAll(/POSIX file "([^"]+)"/g)) {
        const p = m[1];
        const exists = fs.existsSync(p);
        h.seen.push([p, exists, exists ? fs.statSync(p).mode & 0o777 : 0]);
      }
      return { success: true, output: "ok" };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

let dir: string;
let filePath: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "amcp-267-as-"));
  filePath = join(dir, "report.pdf");
  writeFileSync(filePath, "%PDF-1.4\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  h.calls.length = 0;
  h.seen.length = 0;
});

const inline = { filename: "notes.txt", contentBase64: Buffer.from("hi\n").toString("base64") };

function order(script: string, ...needles: string[]): number[] {
  return needles.map((n) => {
    const i = script.indexOf(n);
    expect(i, `script is missing "${n}"`).toBeGreaterThanOrEqual(0);
    return i;
  });
}

describe("AppleScript reply/forward with attachments (#267)", () => {
  it("reply draft: content, then attachments, then save — single attempt", () => {
    const mgr = new AppleMailManager();
    const r = mgr.replyToMessage("42", "PDF attached.", true, false, [filePath, inline]);
    expect(r.success).toBe(true);
    expect(h.calls).toHaveLength(1);
    const { script, options } = h.calls[0];
    expect(options).toMatchObject({ maxRetries: 1 });
    expect(script).toContain("with reply to all");
    const [content, tell, attach, save] = order(
      script,
      'set content of theReply to "PDF attached."',
      "tell theReply",
      "make new attachment with properties {file name:POSIX file",
      "save theReply"
    );
    expect(content).toBeLessThan(tell);
    expect(tell).toBeLessThan(attach);
    expect(attach).toBeLessThan(save);
    expect(script.match(/make new attachment/g)).toHaveLength(2);
  });

  it("materializes inline items as 0600 temp files that are gone afterwards", () => {
    const mgr = new AppleMailManager();
    mgr.replyToMessage("42", "body", false, true, [filePath, inline]);
    expect(h.seen).toHaveLength(2);
    const [pathItem, inlineItem] = h.seen;
    expect(pathItem[0]).toBe(realpathSync.native(filePath));
    expect(inlineItem[0].endsWith("/notes.txt")).toBe(true);
    expect(inlineItem[1]).toBe(true);
    expect(inlineItem[2]).toBe(0o600);
    expect(existsSync(inlineItem[0])).toBe(false);
    expect(existsSync(filePath)).toBe(true);
    expect(statSync(filePath).isFile()).toBe(true);
    expect(h.calls[0].script).toContain("send theReply");
  });

  it("forward: recipients and content first, attachments before send", () => {
    const mgr = new AppleMailManager();
    mgr.forwardMessage("42", ["colleague@example.com"], "FYI", true, [filePath]);
    const { script, options } = h.calls[0];
    expect(options).toMatchObject({ maxRetries: 1 });
    const [rcpt, content, attach, send] = order(
      script,
      "make new to recipient",
      'set content of theForward to "FYI"',
      "tell theForward",
      "send theForward"
    );
    expect(rcpt).toBeLessThan(content);
    expect(content).toBeLessThan(attach);
    expect(attach).toBeLessThan(send);
  });

  it("emits no attachment block when there are no attachments", () => {
    const mgr = new AppleMailManager();
    mgr.replyToMessage("42", "body", false, false);
    expect(h.calls[0].script).not.toContain("make new attachment");
    expect(h.calls[0].script).not.toContain("tell theReply");
    expect(h.calls[0].options).toMatchObject({ maxRetries: 1 });
  });

  it("rejects an out-of-roots path before any AppleScript runs", () => {
    const mgr = new AppleMailManager();
    expect(() => mgr.replyToMessage("42", "body", false, false, ["/etc/hosts"])).toThrow(
      /outside the allowed read roots|protected location/
    );
    expect(h.calls).toHaveLength(0);
  });
});
