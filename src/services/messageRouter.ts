/**
 * Central backend router for single-message tools (D1).
 *
 * A single-message id is either an AppleScript numeric id or an `imap:` token.
 * Before this, every message handler (get/mark/flag/move/delete) repeated the
 * same `if (decodeImapId(id)) … else …` branch. `routeMessage` collapses that
 * into one place: run the IMAP op and map its `{success,error,info}` to a tool
 * response, or fall through to the AppleScript handler.
 *
 * @module services/messageRouter
 */
import { decodeImapId } from "@/services/imapClient.js";
import type { ImapOpResult } from "@/services/imapClient.js";
import { successResponse, errorResponse, type ToolResponse } from "@/tools/respond.js";

/** True when the id is an IMAP composite token (routes to IMAP). */
export function isImapId(id: string): boolean {
  return decodeImapId(id) !== null;
}

/**
 * Route a single-message operation to IMAP (when the id is an `imap:` token) or
 * to the AppleScript handler. Maps an IMAP `ImapOpResult` to a tool response,
 * preferring its `info` text on success and `error` on failure.
 */
export async function routeMessage(
  id: string,
  opts: {
    imap: () => Promise<ImapOpResult>;
    apple: () => ToolResponse | Promise<ToolResponse>;
    ok: string;
    fail: string;
    /** Optional ack payload attached as `structuredContent` on the IMAP success
     *  path, so a caller can verify the mutation programmatically regardless of
     *  backend (A1). The AppleScript path supplies its own via `apple`. */
    structured?: Record<string, unknown>;
    /** Derive `structuredContent` from the IMAP result on success (e.g. parse
     *  subject/body from `info`). Takes precedence over `structured`; return
     *  undefined to attach none. */
    structuredFromResult?: (r: ImapOpResult) => Record<string, unknown> | undefined;
  }
): Promise<ToolResponse> {
  if (decodeImapId(id)) {
    const r = await opts.imap();
    return r.success
      ? successResponse(
          r.info ?? opts.ok,
          opts.structuredFromResult ? opts.structuredFromResult(r) : opts.structured
        )
      : errorResponse(r.error ?? opts.fail);
  }
  return opts.apple();
}
