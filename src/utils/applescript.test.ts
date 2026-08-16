/**
 * Tests for AppleScript execution utilities
 *
 * These tests mock the child_process.execSync function to avoid
 * requiring actual AppleScript execution during testing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { execSync } from "child_process";
import {
  executeAppleScript,
  isPermissionDenied,
  PERMISSION_DENIED_MESSAGE,
} from "./applescript.js";

// Mock the child_process module
vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(() => ({ error: null })), // Mock sleep to return immediately
}));

const mockExecSync = vi.mocked(execSync);

describe("executeAppleScript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("successful execution", () => {
    it("returns success result with trimmed output", () => {
      // Arrange: Mock a successful AppleScript execution
      mockExecSync.mockReturnValue("  Message Subject  \n");

      // Act: Execute a simple script
      const result = executeAppleScript('tell app "Mail" to get subject of message 1');

      // Assert: Output should be trimmed
      expect(result.success).toBe(true);
      expect(result.output).toBe("Message Subject");
      expect(result.error).toBeUndefined();
    });

    it("preserves newlines within the script for AppleScript syntax", () => {
      mockExecSync.mockReturnValue("success");

      // Multi-line AppleScript with tell blocks
      const script = `
        tell application "Mail"
          tell account "iCloud"
            get messages of mailbox "INBOX"
          end tell
        end tell
      `;

      executeAppleScript(script);

      // Verify the script was passed with newlines preserved
      const calledCommand = mockExecSync.mock.calls[0][0] as string;
      expect(calledCommand).toContain("tell application");
      expect(calledCommand).toContain("end tell");
    });

    it("escapes single quotes in the script for shell safety", () => {
      mockExecSync.mockReturnValue("content");

      // Script containing a single quote (e.g., in a search query)
      executeAppleScript('search messages for "Rob\'s Messages"');

      // Verify the quote was escaped for shell
      const calledCommand = mockExecSync.mock.calls[0][0] as string;
      expect(calledCommand).toContain("Rob'\\''s");
    });

    it("passes a maxBuffer well above Node's 1MB default (#27)", () => {
      mockExecSync.mockReturnValue("ok");
      executeAppleScript('tell app "Mail" to return "ok"');
      const opts = mockExecSync.mock.calls[0][1] as { maxBuffer?: number };
      // Default is 64 MB; the only hard requirement is that it exceeds the 1 MB
      // Node default that truncated large message sources (#27).
      expect(opts.maxBuffer).toBeGreaterThan(1024 * 1024);
    });

    it("honors the APPLE_MAIL_MCP_MAX_BUFFER override (#27)", () => {
      mockExecSync.mockReturnValue("ok");
      const prev = process.env.APPLE_MAIL_MCP_MAX_BUFFER;
      process.env.APPLE_MAIL_MCP_MAX_BUFFER = "12345";
      try {
        executeAppleScript('tell app "Mail" to return "ok"');
        const opts = mockExecSync.mock.calls[0][1] as { maxBuffer?: number };
        expect(opts.maxBuffer).toBe(12345);
      } finally {
        if (prev === undefined) delete process.env.APPLE_MAIL_MCP_MAX_BUFFER;
        else process.env.APPLE_MAIL_MCP_MAX_BUFFER = prev;
      }
    });
  });

  describe("error handling", () => {
    it("returns error result when execution fails", () => {
      // Arrange: Mock an AppleScript execution failure
      mockExecSync.mockImplementation(() => {
        throw new Error("execution error: Can't get message. (-1728)");
      });

      // Act: Try to execute a script that will fail
      const result = executeAppleScript('get message "Nonexistent"');

      // Assert: Should return structured error
      expect(result.success).toBe(false);
      expect(result.output).toBe("");
      expect(result.error).toBeDefined();
    });

    it("parses execution error messages cleanly", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("execution error: Message not found (-1728)");
      });

      const result = executeAppleScript("get message 1");

      // Should extract the meaningful part of the error
      expect(result.error).toBe("Message not found");
    });

    it("handles 'message not found' error patterns with user-friendly message", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("Can't get message.");
      });

      const result = executeAppleScript('get message "Missing"');

      expect(result.error).toContain("Message not found");
    });

    it("provides helpful message for permission errors", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("execution error: Not authorized to send Apple events (-1743)");
      });

      const result = executeAppleScript("test");

      expect(result.error).toContain("Permission denied");
      expect(result.error).toContain("System Settings");
    });

    it("provides helpful message for mailbox not found", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('Can\'t get mailbox "Work".');
      });

      const result = executeAppleScript("test");

      expect(result.error).toContain("Work");
      expect(result.error).toContain("not found");
      expect(result.error).toContain("list-mailboxes");
    });

    it("provides helpful message for account not found", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('Can\'t get account "Gmail".');
      });

      const result = executeAppleScript("test");

      expect(result.error).toContain("Gmail");
      expect(result.error).toContain("not found");
      expect(result.error).toContain("list-accounts");
    });

    it("handles non-Error exceptions gracefully", () => {
      mockExecSync.mockImplementation(() => {
        throw "string error"; // Some code throws strings
      });

      const result = executeAppleScript("some script");

      expect(result.success).toBe(false);
      expect(result.error).toBe("string error");
    });

    it("handles unknown error types", () => {
      mockExecSync.mockImplementation(() => {
        throw { weird: "object" }; // Unusual but possible
      });

      const result = executeAppleScript("some script");

      expect(result.success).toBe(false);
      expect(result.error).toBe("AppleScript execution failed with unknown error");
    });
  });

  describe("input validation", () => {
    it("returns error for empty script", () => {
      const result = executeAppleScript("");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Cannot execute empty AppleScript");
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it("returns error for whitespace-only script", () => {
      const result = executeAppleScript("   \n\t  ");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Cannot execute empty AppleScript");
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  describe("execution options", () => {
    it("uses default 30 second timeout", () => {
      mockExecSync.mockReturnValue("ok");

      executeAppleScript("test");

      const options = mockExecSync.mock.calls[0][1] as { timeout: number };
      expect(options.timeout).toBe(30000); // 30 second default timeout
    });

    it("allows custom timeout via options", () => {
      mockExecSync.mockReturnValue("ok");

      executeAppleScript("test", { timeoutMs: 60000 });

      const options = mockExecSync.mock.calls[0][1] as { timeout: number };
      expect(options.timeout).toBe(60000); // Custom timeout
    });

    it("uses UTF-8 encoding for output", () => {
      mockExecSync.mockReturnValue("日本語テスト");

      const result = executeAppleScript("test");

      expect(result.output).toBe("日本語テスト");
      const options = mockExecSync.mock.calls[0][1] as { encoding: string };
      expect(options.encoding).toBe("utf8");
    });

    it("kills a timed-out osascript with SIGKILL, not SIGTERM (#11)", () => {
      mockExecSync.mockReturnValue("ok");

      executeAppleScript("test");

      const options = mockExecSync.mock.calls[0][1] as { killSignal: string };
      expect(options.killSignal).toBe("SIGKILL");
    });
  });

  describe("with timeout wrapping (#11)", () => {
    it("wraps the script in `with timeout … end timeout`", () => {
      mockExecSync.mockReturnValue("ok");

      executeAppleScript('tell application "Mail" to get name');

      const command = mockExecSync.mock.calls[0][0] as string;
      expect(command).toContain("with timeout of");
      expect(command).toContain("end timeout");
      // Original body is preserved inside the wrapper
      expect(command).toContain('tell application "Mail" to get name');
    });

    it("sets the script timeout below the process timeout so Mail aborts first", () => {
      mockExecSync.mockReturnValue("ok");

      // Default 30s process timeout -> 25s script timeout (5s headroom)
      executeAppleScript("test");
      expect(mockExecSync.mock.calls[0][0] as string).toContain("with timeout of 25 seconds");

      // 60s process timeout -> 55s script timeout
      executeAppleScript("test", { timeoutMs: 60000 });
      expect(mockExecSync.mock.calls[1][0] as string).toContain("with timeout of 55 seconds");
    });

    it("never emits a non-positive timeout for very short process timeouts", () => {
      mockExecSync.mockReturnValue("ok");

      executeAppleScript("test", { timeoutMs: 1000 });

      const command = mockExecSync.mock.calls[0][0] as string;
      expect(command).toContain("with timeout of 1 seconds");
    });
  });

  describe("timeout handling", () => {
    it("returns specific error message on timeout", () => {
      // Simulate a timeout error (Node.js sets killed=true and signal=SIGTERM)
      const timeoutError = new Error("Command failed: SIGTERM") as Error & {
        killed: boolean;
        signal: string;
      };
      timeoutError.killed = true;
      timeoutError.signal = "SIGTERM";

      mockExecSync.mockImplementation(() => {
        throw timeoutError;
      });

      const result = executeAppleScript("test");

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out after 30 seconds");
      expect(result.error).toContain("Mail.app may be unresponsive");
    });

    it("includes custom timeout value in error message", () => {
      const timeoutError = new Error("Command failed: SIGTERM") as Error & {
        killed: boolean;
        signal: string;
      };
      timeoutError.killed = true;
      timeoutError.signal = "SIGTERM";

      mockExecSync.mockImplementation(() => {
        throw timeoutError;
      });

      const result = executeAppleScript("test", { timeoutMs: 60000 });

      expect(result.error).toContain("timed out after 60 seconds");
    });

    it("classifies a SIGKILL-killed osascript as a timeout", () => {
      const err = new Error("Command failed: osascript ...") as Error & {
        killed?: boolean;
        signal?: string;
      };
      err.signal = "SIGKILL"; // externally/OOM-killed osascript
      mockExecSync.mockImplementation(() => {
        throw err;
      });

      const result = executeAppleScript("test");

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
    });

    it("never leaks the raw osascript command/script on an abnormal failure", () => {
      // osascript exits non-zero with no parseable AppleScript error and no
      // timeout signal — must NOT dump the full "Command failed: osascript -e '<script>'".
      const err = new Error(
        "Command failed: osascript -e 'tell application \"Mail\" to get every mailbox'"
      );
      mockExecSync.mockImplementation(() => {
        throw err;
      });

      const result = executeAppleScript("test");

      expect(result.success).toBe(false);
      expect(result.error).not.toContain("osascript -e"); // no script dump
      expect(result.error).toContain("osascript exited abnormally");
    });
  });

  describe("retry logic", () => {
    it("does not retry by default (maxRetries=1)", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("Mail.app is not responding");
      });

      executeAppleScript("test");

      // Only one attempt with default settings
      expect(mockExecSync).toHaveBeenCalledTimes(1);
    });

    it("retries on transient errors when maxRetries > 1", () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          throw new Error("Mail.app is not responding");
        }
        return "success";
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(true);
      expect(result.output).toBe("success");
      expect(mockExecSync).toHaveBeenCalledTimes(3);
    });

    it("does not retry on non-transient errors", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("syntax error");
      });

      executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      // Should not retry for syntax errors
      expect(mockExecSync).toHaveBeenCalledTimes(1);
    });

    it("retries on timeout errors", () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          const timeoutError = new Error("SIGTERM") as Error & {
            killed: boolean;
            signal: string;
          };
          timeoutError.killed = true;
          timeoutError.signal = "SIGTERM";
          throw timeoutError;
        }
        return "success after retry";
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(true);
      expect(result.output).toBe("success after retry");
      expect(mockExecSync).toHaveBeenCalledTimes(2);
    });

    it("retries on 'connection invalid' errors", () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          throw new Error("connection is invalid");
        }
        return "recovered";
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(true);
      expect(mockExecSync).toHaveBeenCalledTimes(2);
    });

    it("returns last error after all retries exhausted", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("Mail.app is not responding");
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not responding");
      expect(mockExecSync).toHaveBeenCalledTimes(3);
    });

    it("retries on 'timed out' errors", () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          throw new Error("operation timed out");
        }
        return "recovered";
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(true);
      expect(mockExecSync).toHaveBeenCalledTimes(2);
    });

    it("retries on 'lost connection' errors", () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          throw new Error("lost connection to Mail.app");
        }
        return "recovered";
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(true);
      expect(mockExecSync).toHaveBeenCalledTimes(2);
    });

    it("retries on 'busy' errors", () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          throw new Error("Mail.app is busy");
        }
        return "recovered";
      });

      const result = executeAppleScript("test", { maxRetries: 3, retryDelayMs: 1 });

      expect(result.success).toBe(true);
      expect(mockExecSync).toHaveBeenCalledTimes(2);
    });

    it("uses exponential backoff between retries", () => {
      let execCallCount = 0;

      // Fails first 3 times, succeeds on 4th attempt
      mockExecSync.mockImplementation(() => {
        execCallCount++;
        if (execCallCount <= 3) {
          throw new Error("Mail.app is not responding");
        }
        return "success";
      });

      // With retryDelayMs=100, delays should be: 100ms, 200ms, 400ms
      const result = executeAppleScript("test", { maxRetries: 4, retryDelayMs: 100 });

      expect(result.success).toBe(true);
      expect(mockExecSync).toHaveBeenCalledTimes(4);
    });
  });
});

describe("permission-denied classification", () => {
  // The bug this pins: ERROR_MAPPINGS REPLACES the raw AppleScript text with a
  // friendly message, and healthCheck then re-tested for the raw substrings the
  // mapping had just deleted. `isPermError` was therefore never true for a real
  // TCC denial — `doctor` reported `permissions: ok` while its own detail line
  // read "Permission denied", and the early `healthy: false` return never ran.
  it("classifies the RAW AppleScript refusals", () => {
    expect(isPermissionDenied("Not authorized to send Apple events to Mail. (-1743)")).toBe(true);
    expect(isPermissionDenied("osascript is not permitted to send keystrokes")).toBe(true);
    expect(isPermissionDenied("access for assistive devices is denied")).toBe(true);
  });

  it("classifies the NORMALISED message the mapping produces", () => {
    // This is what a caller actually receives, and it contains none of the raw
    // substrings — which is exactly why the old string test could never match.
    expect(PERMISSION_DENIED_MESSAGE).not.toMatch(/not authorized|not permitted/i);
    expect(isPermissionDenied(PERMISSION_DENIED_MESSAGE)).toBe(true);
    expect(isPermissionDenied(`Permission check returned: ${PERMISSION_DENIED_MESSAGE}`)).toBe(
      true
    );
  });

  it("does not fire on unrelated errors", () => {
    expect(isPermissionDenied(undefined)).toBe(false);
    expect(isPermissionDenied("")).toBe(false);
    expect(isPermissionDenied("Mail.app is not responding.")).toBe(false);
    expect(isPermissionDenied("Message not found")).toBe(false);
  });
});
