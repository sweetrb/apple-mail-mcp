/**
 * Per-test isolation for on-disk state the server persists.
 *
 * The by-id scan's learned "stalled mailbox" list (#270 follow-up) lives in a
 * JSON file under ~/Library/Application Support/apple-mail-mcp by default.
 * Unit tests must neither read the developer's real list (it changes the
 * generated AppleScript) nor write to it, and tests must not leak entries into
 * each other — so every test file gets its own throwaway path, emptied before
 * each test (a fresh AppleMailManager used to mean a fresh in-memory list).
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach } from "vitest";

const file = join(mkdtempSync(join(tmpdir(), "amcp-vitest-")), "stalled-mailboxes.json");
process.env.APPLE_MAIL_MCP_STALLED_MAILBOXES_FILE = file;
beforeEach(() => {
  process.env.APPLE_MAIL_MCP_STALLED_MAILBOXES_FILE = file;
  rmSync(file, { force: true });
});
