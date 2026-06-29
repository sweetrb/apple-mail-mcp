/**
 * Orphaned-process detection (connection-footprint hardening, v2.6.1).
 *
 * The MCP server tears down its pooled IMAP connections on the normal exit
 * paths — SIGINT/SIGTERM and stdin EOF (parent/MCP-client went away). But a
 * claude-code parent that is *force-quit* or crashes never delivers stdin-EOF,
 * so the server would linger as an orphan holding IMAP sockets against Gmail's
 * ~15-per-account connection cap (and starving Apple Mail of slots).
 *
 * On macOS a process whose parent has died is reparented to launchd (pid 1), so
 * `process.ppid === 1` is a reliable "my parent is gone" signal for a server
 * that was never itself launched directly by launchd (this one is always a child
 * of the host app). index.ts polls this on an interval and self-exits when true.
 *
 * Pulled out as a tiny pure function so the decision is unit-testable without
 * importing index.ts (which connects a transport at import time).
 *
 * @module utils/orphan
 */

/**
 * True when this process appears orphaned (its parent has died and it was
 * reparented to launchd/init). Defaults to the live `process.ppid`.
 */
export function isOrphaned(ppid: number = process.ppid): boolean {
  return ppid === 1;
}
