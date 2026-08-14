import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

const h = vi.hoisted(() => ({ calls: 0 }));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: () => {
      h.calls += 1;
      return { success: false, output: "", error: "unexpected call" };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  h.calls = 0;
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
    const root = mkdtempSync(join(tmpdir(), "apple-mail-mcp-test-"));
    cleanup.push(root);
    symlinkSync("/etc/hosts", join(root, "hosts"));

    const mgr = new AppleMailManager();
    expect(mgr.saveAttachment("1", "hosts", root)).toBe(false);
    expect(h.calls).toBe(0);
  });

  it("rejects an existing regular-file destination", () => {
    const root = mkdtempSync(join(tmpdir(), "apple-mail-mcp-test-"));
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
  });
});
