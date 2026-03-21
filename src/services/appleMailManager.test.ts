/**
 * Tests for AppleMailManager service layer.
 * Focuses on input validation that does not require a live Mail.app.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppleMailManager } from "./appleMailManager.js";
import * as applescript from "@/utils/applescript.js";
import * as os from "os";

// Mock AppleScript execution so tests don't require Mail.app
vi.mock("@/utils/applescript.js", () => ({
  executeAppleScript: vi.fn(),
}));

const mockExecuteAppleScript = vi.mocked(applescript.executeAppleScript);

describe("AppleMailManager.saveAttachment() — path validation", () => {
  let manager: AppleMailManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new AppleMailManager();
  });

  it("rejects a relative savePath", () => {
    const result = manager.saveAttachment("12345", "report.pdf", "relative/path");
    expect(result).toBe(false);
    expect(mockExecuteAppleScript).not.toHaveBeenCalled();
  });

  it("rejects a savePath outside allowed prefixes (e.g. /etc)", () => {
    const result = manager.saveAttachment("12345", "sudoers", "/etc");
    expect(result).toBe(false);
    expect(mockExecuteAppleScript).not.toHaveBeenCalled();
  });

  it("rejects a savePath of /usr/bin", () => {
    const result = manager.saveAttachment("12345", "file.txt", "/usr/bin");
    expect(result).toBe(false);
    expect(mockExecuteAppleScript).not.toHaveBeenCalled();
  });

  it("accepts a savePath within home directory", () => {
    mockExecuteAppleScript.mockReturnValue({ success: true, output: "ok" });
    const homePath = os.homedir() + "/Downloads";
    const result = manager.saveAttachment("12345", "report.pdf", homePath);
    expect(result).toBe(true);
    expect(mockExecuteAppleScript).toHaveBeenCalled();
  });

  it("accepts /tmp as savePath", () => {
    mockExecuteAppleScript.mockReturnValue({ success: true, output: "ok" });
    const result = manager.saveAttachment("12345", "report.pdf", "/tmp");
    expect(result).toBe(true);
    expect(mockExecuteAppleScript).toHaveBeenCalled();
  });

  it("accepts /Volumes/ExternalDrive as savePath", () => {
    mockExecuteAppleScript.mockReturnValue({ success: true, output: "ok" });
    const result = manager.saveAttachment("12345", "report.pdf", "/Volumes/ExternalDrive");
    expect(result).toBe(true);
    expect(mockExecuteAppleScript).toHaveBeenCalled();
  });

  it("rejects an attachmentName with a path separator", () => {
    const result = manager.saveAttachment("12345", "../../../etc/passwd", os.homedir());
    expect(result).toBe(false);
    expect(mockExecuteAppleScript).not.toHaveBeenCalled();
  });

  it("rejects an attachmentName containing a slash", () => {
    const result = manager.saveAttachment("12345", "sub/dir/file.pdf", os.homedir());
    expect(result).toBe(false);
    expect(mockExecuteAppleScript).not.toHaveBeenCalled();
  });

  it("rejects an attachmentName with a null byte", () => {
    const result = manager.saveAttachment("12345", "file\0.pdf", os.homedir());
    expect(result).toBe(false);
    expect(mockExecuteAppleScript).not.toHaveBeenCalled();
  });

  it("accepts a normal attachmentName", () => {
    mockExecuteAppleScript.mockReturnValue({ success: true, output: "ok" });
    const result = manager.saveAttachment("12345", "report.pdf", os.homedir() + "/Downloads");
    expect(result).toBe(true);
    expect(mockExecuteAppleScript).toHaveBeenCalled();
  });
});
