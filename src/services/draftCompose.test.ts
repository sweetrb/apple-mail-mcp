import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeAppleScript } from "@/utils/applescript.js";
import { buildDraftScript, createSavedDraft, listMailSignatures } from "./draftCompose.js";

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return { ...actual, executeAppleScript: vi.fn() };
});
const input = {
  account: "Work",
  sender: "alias@example.com",
  signature: 'Signature "One"',
  safeSubject: "Test",
  safeBody: "First paragraph\\nSecond paragraph",
  recipientCommands: 'make new to recipient with properties {address:"me@example.com"}',
  attachmentCommands: "",
};

beforeEach(() => vi.clearAllMocks());

describe("saved drafts", () => {
  it("preflights account/alias/signature before composing and escapes signature names", () => {
    const script = buildDraftScript(input);
    expect(script).toContain('set requestedSignatureName to "Signature \\"One\\""');
    expect(script.indexOf("Signature missing or ambiguous")).toBeLessThan(
      script.indexOf("make new outgoing message")
    );
    expect(script.indexOf("Account/sender missing")).toBeLessThan(
      script.indexOf("make new outgoing message")
    );
    expect(script).toContain("candidateAddresses contains requestedSender");
    expect(script).toContain("if enabled of candidate then");
    expect(script).toContain("sender:selectedSender");
    expect(script).not.toContain('set sender to "Work"');
  });

  it("saves and checks content and selections before returning a receipt; never sends", () => {
    const script = buildDraftScript(input);
    expect(script).toContain("save newMessage");
    expect(script).toContain("close newMessage saving yes");
    expect(script.indexOf("save newMessage")).toBeLessThan(script.indexOf("set savedBody"));
    expect(script).toContain("Draft body verification failed");
    expect(script).toContain("Draft signature verification failed");
    expect(script).toContain("Draft sender verification failed");
    expect(script).not.toMatch(/\bsend newMessage/);
    expect(script).not.toContain("visible:true");
  });

  it("does not retry on timeout because the first attempt may have created a draft", () => {
    vi.mocked(executeAppleScript).mockReturnValue({ success: false, output: "", error: "timeout" });
    expect(createSavedDraft(input)).toEqual({
      success: false,
      error: expect.stringContaining("inspect Drafts before retrying"),
    });
    expect(executeAppleScript).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      timeoutMs: 60000,
      maxRetries: 1,
    });
  });

  it("only accepts a complete saved receipt and returns actual values", () => {
    vi.mocked(executeAppleScript).mockReturnValue({
      success: true,
      output: "saved\x1f123\x1fAlias <alias@example.com>\x1fSignature One",
    });
    expect(createSavedDraft(input)).toEqual({
      success: true,
      composeId: "123",
      sender: "Alias <alias@example.com>",
      signature: "Signature One",
    });
    vi.mocked(executeAppleScript).mockReturnValue({ success: true, output: "draft created" });
    expect(createSavedDraft(input).success).toBe(false);
  });

  it("distinguishes failed signature reads from a genuinely empty list", () => {
    vi.mocked(executeAppleScript).mockReturnValue({ success: false, output: "", error: "denied" });
    expect(() => listMailSignatures()).toThrow("denied");
    vi.mocked(executeAppleScript).mockReturnValue({ success: true, output: "" });
    expect(listMailSignatures()).toEqual([]);
    vi.mocked(executeAppleScript).mockReturnValue({ success: true, output: "First\x1fSecond" });
    expect(listMailSignatures()).toEqual(["First", "Second"]);
  });
});

describe.skipIf(process.platform !== "darwin")("draft AppleScript compilation", () => {
  it("resolves Mail terminology without executing draft creation", () => {
    const directory = mkdtempSync(join(tmpdir(), "mail-draft-compile-"));
    try {
      execFileSync("osacompile", [
        "-o",
        join(directory, "draft.scpt"),
        "-e",
        buildDraftScript(input),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
