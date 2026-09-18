import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { executeAppleScript } from "@/utils/applescript.js";
import { buildSavedDraftSendScript, sendSavedDraft, DRAFT_TEXT_NORMALIZER } from "./draftSend.js";
vi.mock("@/utils/applescript.js", () => ({ executeAppleScript: vi.fn() }));
const input = {
  account: "Work",
  draftId: "123",
  composeId: "45",
  sender: "me@example.com",
  recipient: "you@example.com",
  subject: 'A "topic"',
  signature: "Work",
  body: "Approved body",
  dryRun: true,
};
describe("existing draft send", () => {
  it("validates saved and composed identities without recreating or sending during preview", () => {
    const script = buildSavedDraftSendScript(input);
    expect(script).toContain("whose id is 123");
    expect(script).toContain("whose id is 45");
    expect(script).toContain('A \\"topic\\"');
    expect(script).toContain("Stored draft recipient mismatch");
    expect(script).toContain("Composer sender mismatch");
    expect(script).toContain("Signature mismatch");
    expect(script).toContain("Unexpected CC/BCC");
    expect(script).toContain("Unexpected attachment");
    expect(script).toContain("Stored body differs");
    expect(script).not.toContain("send targetMessage");
    expect(script).not.toContain("make new");
  });
  it("only sends after validation and never retries an uncertain submission", () => {
    const script = buildSavedDraftSendScript({ ...input, dryRun: false });
    expect(script.indexOf("Stored body differs")).toBeLessThan(
      script.indexOf("send targetMessage")
    );
    vi.mocked(executeAppleScript).mockReturnValue({ success: false, output: "", error: "timeout" });
    expect(() => sendSavedDraft({ ...input, dryRun: false })).toThrow("timeout");
    expect(executeAppleScript).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      timeoutMs: 60000,
      maxRetries: 1,
    });
  });
  it("rejects invalid IDs and unexpected receipts", () => {
    expect(() => buildSavedDraftSendScript({ ...input, composeId: "45; send" })).toThrow("Invalid");
    vi.mocked(executeAppleScript).mockReturnValue({ success: true, output: "true" });
    expect(() => sendSavedDraft(input)).toThrow("Unknown send outcome");
    vi.mocked(executeAppleScript).mockReturnValue({ success: true, output: "submitted" });
    expect(sendSavedDraft({ ...input, dryRun: false })).toEqual({ status: "submitted" });
  });
});

describe.skipIf(process.platform !== "darwin")("draft text comparison (no Mail access)", () => {
  it("compiles both preview and send scripts without executing Mail commands", () => {
    const directory = mkdtempSync(join(tmpdir(), "mail-draft-compile-"));
    try {
      for (const dryRun of [true, false]) {
        execFileSync("osacompile", [
          "-o",
          join(directory, "draft.scpt"),
          "-e",
          buildSavedDraftSendScript({ ...input, dryRun }),
        ]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("ignores line spacing while retaining punctuation, decimals, and case", () => {
    const script =
      DRAFT_TEXT_NORMALIZER +
      `
      set spaced to my compactDraftText("A 1.5" & return & "mg")
      considering case, diacriticals, punctuation
        if spaced is not "A1.5mg" then error "Whitespace normalization failed"
        if spaced is my compactDraftText("A 15 mg") then error "Decimal punctuation lost"
        if spaced is my compactDraftText("a 1.5 mg") then error "Case ignored"
      end considering
      return "ok"
    `;
    expect(execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim()).toBe("ok");
  });
});
