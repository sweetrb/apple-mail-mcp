/**
 * AppleScript Execution Utilities
 *
 * This module provides a safe interface for executing AppleScript commands
 * on macOS. It handles script execution, error capture, and result parsing.
 *
 * @module utils/applescript
 */

import { execSync, spawnSync } from "child_process";
import type { AppleScriptResult, AppleScriptOptions } from "@/types.js";

/**
 * Default execution timeout for AppleScript commands in milliseconds.
 * 30 seconds is sufficient for most operations, including complex
 * searches on large mailboxes. Can be overridden per-call.
 */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Maximum stdout/stderr buffer (bytes) for an osascript invocation.
 *
 * Node's `execSync` defaults to a 1 MB `maxBuffer`; exceeding it throws
 * `ENOBUFS`, which we surface as a failure and callers convert to `null`. Mail
 * operations routinely exceed 1 MB — `getRawSource` reads the entire raw MIME
 * (a 20 MB attachment is explicitly anticipated), `getMessageContent` returns
 * the full source, and large `search`/`list` result sets accumulate — so the
 * default silently breaks exactly the large / attachment-bearing messages where
 * it matters most (issue #27). Default to 64 MB; override with
 * `APPLE_MAIL_MCP_MAX_BUFFER` (bytes).
 */
const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Resolve the osascript output buffer size, honoring the
 * `APPLE_MAIL_MCP_MAX_BUFFER` environment override (bytes).
 */
function getMaxBuffer(): number {
  const raw = process.env.APPLE_MAIL_MCP_MAX_BUFFER;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_BUFFER_BYTES;
}

/**
 * Default retry configuration.
 * - 1 attempt means no retries (default behavior)
 * - Use maxRetries: 3 for exponential backoff with 1s/2s delays
 */
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 1000;

/**
 * Check if debug/verbose logging is enabled.
 * Set DEBUG=1 or DEBUG=true or VERBOSE=1 to enable.
 */
const isDebugEnabled = (): boolean => {
  const debug = process.env.DEBUG;
  const verbose = process.env.VERBOSE;
  return debug === "1" || debug === "true" || verbose === "1" || verbose === "true";
};

/**
 * Log a debug message if debug mode is enabled.
 *
 * @param message - The message to log
 * @param data - Optional additional data to log
 */
function debugLog(message: string, data?: unknown): void {
  if (!isDebugEnabled()) return;

  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.error(`[DEBUG ${timestamp}] ${message}`, data);
  } else {
    console.error(`[DEBUG ${timestamp}] ${message}`);
  }
}

/**
 * Escapes a string for safe inclusion in a shell command.
 *
 * When passing AppleScript to osascript via shell, we need to handle
 * the interaction between shell quoting and AppleScript string literals.
 * This function escapes single quotes since we wrap the script in single quotes.
 *
 * @param script - The raw AppleScript code
 * @returns Shell-safe version of the script
 *
 * @example
 * // Input: tell app "Notes" to get note "Rob's Note"
 * // Output: tell app "Notes" to get note "Rob'\''s Note"
 */
function escapeForShell(script: string): string {
  // Replace single quotes with: end quote, escaped quote, start quote
  // This is the standard shell escaping pattern for single-quoted strings
  return script.replace(/'/g, "'\\''");
}

/**
 * Headroom (ms) between the in-AppleScript `with timeout` and the outer
 * osascript process timeout. The script-level timeout must fire *first* so
 * Mail.app aborts the operation from inside its own AppleScript dispatch —
 * cleanly releasing the event queue — before Node SIGKILLs the osascript
 * process. Killing osascript alone does not stop work already dispatched into
 * Mail.app, which is what wedges Mail.app for subsequent calls (issue #11).
 */
const SCRIPT_TIMEOUT_HEADROOM_MS = 5000;

/**
 * Wraps a script body in an AppleScript `with timeout` block so any Apple
 * Event that honors timeouts (most Mail.app operations do) aborts cleanly
 * rather than holding Mail.app's single-threaded AppleScript dispatch queue
 * open indefinitely.
 *
 * The timeout is set a few seconds below the osascript process timeout so the
 * in-Mail abort wins the race against the outer process kill.
 *
 * @param script - The AppleScript body
 * @param processTimeoutMs - The outer osascript process timeout
 * @returns The script wrapped in `with timeout … end timeout`
 */
function wrapWithTimeout(script: string, processTimeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil((processTimeoutMs - SCRIPT_TIMEOUT_HEADROOM_MS) / 1000));
  return `with timeout of ${seconds} seconds\n${script}\nend timeout`;
}

/**
 * Checks if an error is a timeout error from execSync.
 *
 * Node.js throws errors with specific properties when a child process
 * is killed due to timeout.
 *
 * @param error - The caught error object
 * @returns True if this was a timeout error
 */
function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error) {
    const execError = error as Error & { killed?: boolean; signal?: string };
    // executeAppleScript kills a timed-out osascript with SIGKILL; execSync also
    // sets killed=true on its own timeout. Treat any killed osascript
    // (SIGTERM/SIGKILL) as a timeout/abnormal exit rather than leaking the raw
    // "Command failed" string downstream.
    return (
      execError.killed === true || execError.signal === "SIGTERM" || execError.signal === "SIGKILL"
    );
  }
  return false;
}

/**
 * Error patterns that indicate transient failures worth retrying.
 * These typically occur when Mail.app is busy or temporarily unresponsive.
 */
const RETRYABLE_ERROR_PATTERNS = [
  /timed? out/i,
  /not responding/i,
  /connection.*invalid/i,
  /lost connection/i,
  /busy/i,
];

/**
 * Checks if an error message indicates a transient failure that should be retried.
 *
 * @param errorMessage - The error message to check
 * @returns True if this error is worth retrying
 */
function isRetryableError(errorMessage: string): boolean {
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/**
 * Synchronous sleep using the system's sleep command.
 * Used between retry attempts for exponential backoff.
 *
 * This is more efficient than a busy-wait loop as it doesn't
 * consume CPU cycles during the delay.
 *
 * Uses spawnSync instead of execSync to avoid interference with
 * execSync mocks in tests.
 *
 * @param ms - Milliseconds to sleep
 */
function sleep(ms: number): void {
  // Use system sleep command with fractional seconds support
  // This avoids CPU-spinning busy wait while keeping the code synchronous
  const seconds = ms / 1000;
  const result = spawnSync("sleep", [seconds.toString()], { stdio: "ignore" });
  if (result.error) {
    // Fallback to busy-wait if sleep command fails (shouldn't happen on macOS)
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Busy wait fallback
    }
  }
}

/**
 * User-friendly error messages mapped from common AppleScript errors.
 * Each entry maps a pattern (regex or string) to a user-friendly message.
 */
/**
 * What a raw AppleScript TCC refusal looks like before normalisation.
 *
 * Exported with the message below because the two MUST stay derived from one
 * source. They did not: `healthCheck` classified a denial by re-testing for
 * "not authorized"/"not permitted" — substrings this mapping had already
 * REPLACED — so `isPermError` was unreachable, a genuine denial reported
 * `passed: true`, and the early `healthy: false` return never fired. The check
 * shared a NAME with the real thing but not a code path.
 */
export const PERMISSION_DENIED_PATTERN = /not authorized|not permitted|access.*denied/i;

/** The normalised text a permission failure is reported to callers as. */
export const PERMISSION_DENIED_MESSAGE =
  "Permission denied. Grant automation access in System Settings > Privacy & Security > Automation.";

/**
 * Is this error a TCC/Automation refusal?
 *
 * Accepts BOTH forms deliberately — the raw text AppleScript emits and the
 * normalised text callers actually receive — so a caller cannot be caught out
 * by which side of `mapError` it happens to be reading.
 */
export function isPermissionDenied(error?: string | null): boolean {
  if (!error) return false;
  return PERMISSION_DENIED_PATTERN.test(error) || error.includes(PERMISSION_DENIED_MESSAGE);
}

const ERROR_MAPPINGS: Array<{ pattern: RegExp; message: string }> = [
  // Permission errors
  {
    pattern: PERMISSION_DENIED_PATTERN,
    message: PERMISSION_DENIED_MESSAGE,
  },
  // Application not running
  {
    pattern: /application isn't running|not running/i,
    message: "Mail.app is not responding. Try opening Mail.app manually.",
  },
  // Connection errors
  {
    pattern: /connection is invalid|lost connection/i,
    message: "Lost connection to Mail.app. The app may have crashed or been restarted.",
  },
  // Message not found
  {
    pattern: /can't get message/i,
    message: "Message not found. The message may have been deleted or moved.",
  },
  // Mailbox not found
  {
    pattern: /can't get mailbox "([^"]+)"/i,
    message: 'Mailbox "$1" not found. Use list-mailboxes to see available mailboxes.',
  },
  // Account not found
  {
    pattern: /can't get account "([^"]+)"/i,
    message: 'Account "$1" not found. Use list-accounts to see available accounts.',
  },
  // Send failed
  {
    pattern: /couldn't send|send failed|cannot send/i,
    message: "Failed to send email. Check your network connection and Mail.app settings.",
  },
  // Offline
  {
    pattern: /offline|no connection/i,
    message: "Mail.app is offline. Check your network connection.",
  },
  // Cannot delete (various reasons)
  {
    pattern: /can't delete|cannot delete/i,
    message: "Cannot delete. The message may be locked or in use.",
  },
  // Syntax/script errors (usually programming bugs)
  {
    pattern: /syntax error|expected/i,
    message: "Internal error. Please report this issue.",
  },
];

/**
 * Parses error output from osascript to extract meaningful error messages.
 *
 * osascript errors typically include execution error numbers and descriptions.
 * This function attempts to extract the human-readable portion and map it
 * to a user-friendly message with helpful suggestions.
 *
 * @param errorOutput - Raw error string from execSync
 * @returns User-friendly error message with suggested action
 */
function parseErrorMessage(errorOutput: string): string {
  // First, extract the core error message from AppleScript format
  let coreError = errorOutput;

  // Check for execution error format: "execution error: Message (-1234)"
  const executionError = errorOutput.match(/execution error: (.+?)(?:\s*\(-?\d+\))?$/m);
  if (executionError) {
    coreError = executionError[1].trim();
  }

  // Try to match against known error patterns for user-friendly messages
  for (const { pattern, message } of ERROR_MAPPINGS) {
    const match = coreError.match(pattern);
    if (match) {
      // Replace $1, $2, etc. with captured groups
      let result = message;
      for (let i = 1; i < match.length; i++) {
        result = result.replace(`$${i}`, match[i] || "");
      }
      return result;
    }
  }

  // Fall back to basic "Can't get X" parsing
  const notFoundError = coreError.match(/Can't get (.+?)\./);
  if (notFoundError) {
    return `Not found: ${notFoundError[1]}`;
  }

  // Never leak Node's raw `Command failed: osascript -e '<entire script>'` to the
  // user — it means osascript exited abnormally with no parseable AppleScript
  // error (killed under load, Mail.app relaunching, or Automation denied).
  if (/^Command failed:\s*osascript/.test(coreError.trim())) {
    return (
      "Mail.app scripting failed (osascript exited abnormally). Mail may be " +
      "unresponsive or relaunching, or Automation permission was denied — check " +
      "System Settings > Privacy & Security > Automation, and try again."
    );
  }

  // Return cleaned version of original error
  return coreError.trim() || "Unknown AppleScript error";
}

/**
 * Executes an AppleScript command and returns a structured result.
 *
 * This function serves as the bridge between TypeScript and macOS AppleScript.
 * It handles the complexity of shell escaping, execution, and error handling
 * so that calling code can work with clean TypeScript interfaces.
 *
 * The script is executed synchronously via the `osascript` command-line tool.
 * Multi-line scripts are supported and preserved (important for AppleScript
 * tell blocks and repeat loops).
 *
 * @param script - The AppleScript code to execute
 * @param options - Optional execution settings (timeout, etc.)
 * @returns A result object with success status and output or error message
 *
 * @example
 * ```typescript
 * // Basic usage with default timeout (30 seconds)
 * const result = executeAppleScript(`
 *   tell application "Notes"
 *     get name of every note
 *   end tell
 * `);
 *
 * // With custom timeout for complex operations
 * const result = executeAppleScript(complexScript, { timeoutMs: 60000 });
 *
 * if (result.success) {
 *   console.log("Notes:", result.output);
 * } else {
 *   console.error("Failed:", result.error);
 * }
 * ```
 */
export function executeAppleScript(
  script: string,
  options: AppleScriptOptions = {}
): AppleScriptResult {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  // Validate input - empty scripts are likely programmer errors
  if (!script || !script.trim()) {
    return {
      success: false,
      output: "",
      error: "Cannot execute empty AppleScript",
    };
  }

  // Prepare the script:
  // 1. Trim leading/trailing whitespace (cosmetic)
  // 2. Preserve internal newlines (required for AppleScript syntax)
  // 3. Wrap in `with timeout` so a stuck Mail.app operation aborts from
  //    inside its own dispatch before the process timeout kills osascript (#11)
  // 4. Escape for shell execution
  const preparedScript = escapeForShell(wrapWithTimeout(script.trim(), timeoutMs));

  // Build the osascript command
  // We use single quotes to wrap the script, which is why we escape
  // single quotes within the script itself
  const command = `osascript -e '${preparedScript}'`;

  // Debug: Log the script being executed
  debugLog("Executing AppleScript", {
    scriptPreview: script.trim().substring(0, 200) + (script.length > 200 ? "..." : ""),
    timeout: timeoutMs,
    maxRetries,
  });

  let lastError: AppleScriptResult | null = null;
  const startTime = Date.now();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const attemptStart = Date.now();
    try {
      // Execute synchronously - MCP tools are inherently synchronous
      // and Apple Notes operations are fast enough that async isn't needed
      const output = execSync(command, {
        encoding: "utf8",
        timeout: timeoutMs,
        // SIGKILL (not the default SIGTERM): a wedged osascript blocked on an
        // unresponsive Mail.app can ignore SIGTERM, leaking processes that pile
        // up and worsen the contention. SIGKILL guarantees the process is reaped
        // when the timeout fires. (#11)
        killSignal: "SIGKILL",
        // Raise the output cap well above Node's 1 MB default so large message
        // sources / attachment payloads aren't truncated into an ENOBUFS
        // failure. (#27)
        maxBuffer: getMaxBuffer(),
        // Capture stderr separately to get error details
        stdio: ["pipe", "pipe", "pipe"],
      });

      const duration = Date.now() - attemptStart;
      debugLog("AppleScript succeeded", {
        attempt,
        duration: `${duration}ms`,
        outputLength: output.length,
        outputPreview: output.substring(0, 100) + (output.length > 100 ? "..." : ""),
      });

      return {
        success: true,
        output: output.trim(),
      };
    } catch (error: unknown) {
      // execSync throws on non-zero exit codes
      // The error object contains stderr output with AppleScript error details
      const attemptDuration = Date.now() - attemptStart;

      let errorMessage: string;
      let isTimeout = false;
      let rawError: string | undefined;

      // Check for timeout first - provide specific message
      if (isTimeoutError(error)) {
        isTimeout = true;
        const timeoutSecs = Math.round(timeoutMs / 1000);
        errorMessage = `Operation timed out after ${timeoutSecs} seconds. Mail.app may be unresponsive or the operation involves too many messages.`;
      } else if (error instanceof Error) {
        rawError = error.message;
        // Node's ExecException includes stderr in the message
        errorMessage = parseErrorMessage(error.message);
      } else if (typeof error === "string") {
        rawError = error;
        errorMessage = parseErrorMessage(error);
      } else {
        errorMessage = "AppleScript execution failed with unknown error";
      }

      // Debug: Log error details
      debugLog("AppleScript failed", {
        attempt,
        duration: `${attemptDuration}ms`,
        totalElapsed: `${Date.now() - startTime}ms`,
        isTimeout,
        errorMessage,
        rawError: rawError?.substring(0, 500),
      });

      lastError = {
        success: false,
        output: "",
        error: errorMessage,
      };

      // Check if we should retry
      const canRetry = isTimeout || isRetryableError(errorMessage);
      const hasAttemptsLeft = attempt < maxRetries;

      if (canRetry && hasAttemptsLeft) {
        const delayMs = retryDelayMs * Math.pow(2, attempt - 1);
        console.error(
          `AppleScript retry: Attempt ${attempt}/${maxRetries} failed with "${errorMessage}". Retrying in ${delayMs}ms...`
        );
        sleep(delayMs);
        // Continue to next attempt
      } else {
        // Log final error and return
        if (isTimeout) {
          console.error(`AppleScript timeout: ${errorMessage}`);
        } else {
          console.error(`AppleScript error: ${errorMessage}`);
        }
        return lastError!;
      }
    }
  }

  // Return the last error (all retries exhausted - shouldn't reach here normally)
  return lastError!;
}
