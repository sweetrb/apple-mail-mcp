import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

const h = vi.hoisted(() => ({ calls: 0, success: false, output: "", savePath: "" }));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string) => {
      h.calls += 1;
      if (h.success && h.output === "ok") {
        const match = script.match(/set savePath to POSIX file "([^"]+)"/);
        if (!match) throw new Error("test AppleScript did not contain a staging path");
        h.savePath = match[1];
        writeFileSync(match[1], "payload", { flag: "wx", mode: 0o600 });
        return { success: true, output: "ok" };
      }
      return { success: false, output: "", error: "unexpected call" };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  h.calls = 0;
  h.success = false;
  h.output = "";
  h.savePath = "";
});

describe("saveAttachment path boundary", () => {
  it("rejects an allowed-root symlink that resolves outside the allowed roots", () => {
    const root = mkdtempSync(join(homedir(), ".apple-mail-mcp-test-"));
    cleanup.push(root);
    const link = join(root, "outside");
    symlinkSync("/etc", link, "dir");

    const mgr = new AppleMailManager();
    expect(mgr.saveAttachment("1", "hosts", link)).toBe(false);
    expect(h.calls).toBe(0);
  });

  it("rejects an existing symbolic-link destination", () => {
    const root = mkdtempSync(join(homedir(), ".apple-mail-mcp-test-"));
    cleanup.push(root);
    symlinkSync("/etc/hosts", join(root, "hosts"));

    const mgr = new AppleMailManager();
    expect(mgr.saveAttachment("1", "hosts", root)).toBe(false);
    expect(h.calls).toBe(0);
  });

  it("rejects an existing regular-file destination", () => {
    const root = mkdtempSync(join(homedir(), ".apple-mail-mcp-test-"));
    cleanup.push(root);
    writeFileSync(join(root, "hosts"), "keep me");

    const mgr = new AppleMailManager();
    expect(mgr.saveAttachment("1", "hosts", root)).toBe(false);
    expect(h.calls).toBe(0);
  });

  it("uses a temporary directory when fetching attachment bytes", () => {
    const mgr = new AppleMailManager();
    const save = vi.spyOn(mgr, "saveAttachment").mockImplementation((_id, name, directory) => {
      writeFileSync(join(directory, name), "payload");
      return true;
    });

    const result = mgr.getAttachmentBase64("1", "report.txt");

    expect(result.success).toBe(true);
    expect(Buffer.from(result.base64 as string, "base64").toString()).toBe("payload");
    expect(save.mock.calls[0][2]).not.toMatch(/report\.txt$/);
  });

  it("creates MIME fallback files with owner-only permissions", () => {
    const root = mkdtempSync(join(homedir(), ".apple-mail-mcp-test-"));
    cleanup.push(root);
    const mgr = new AppleMailManager();
    vi.spyOn(mgr, "getRawSource").mockReturnValue(`Content-Type: multipart/mixed; boundary="b"

--b
Content-Type: text/plain
Content-Disposition: attachment; filename="report.txt"
Content-Transfer-Encoding: base64

cGF5bG9hZA==
--b--`);

    expect(mgr.saveAttachment("1", "report.txt", root)).toBe(true);
    expect(statSync(join(root, "report.txt")).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual(["report.txt"]);
  });

  it("stages AppleScript files privately and normalizes the final mode", () => {
    const root = mkdtempSync(join(homedir(), ".apple-mail-mcp-test-"));
    cleanup.push(root);
    h.success = true;
    h.output = "ok";

    const mgr = new AppleMailManager();

    expect(mgr.saveAttachment("1", "report.txt", root)).toBe(true);
    expect(statSync(join(root, "report.txt")).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual(["report.txt"]);

    // Mail.app must never be handed the caller's destination path: the file may
    // only appear there via the COPYFILE_EXCL commit out of a private mkdtemp
    // staging directory. Without this, dropping the staging step and letting Mail
    // write straight to the destination leaves every other assertion green.
    expect(h.savePath).not.toBe(join(root, "report.txt"));
    expect(h.savePath).toContain(".apple-mail-mcp-");
    expect(dirname(h.savePath)).not.toBe(root);
  });
});
