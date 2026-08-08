/**
 * Shared MCP tool-response helpers, the AppleScript serial gate, and the
 * error-handling wrapper. Extracted from index.ts (D1) so every tool module
 * shares one consistent response/serialization path.
 *
 * @module tools/respond
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createSerialGate } from "@/utils/serialize.js";
import type { SearchDiagnostics, Message } from "@/types.js";

/**
 * Plain, JSON-friendly summary of a Message for `structuredContent` (A1) — dates
 * as ISO strings, only the fields an agent needs to act (id is the key it passes
 * back to get-message / mutations).
 */
export function messageSummary(m: Message): Record<string, unknown> {
  return {
    id: m.id,
    subject: m.subject,
    sender: m.sender,
    dateReceived: m.dateReceived instanceof Date ? m.dateReceived.toISOString() : m.dateReceived,
    isRead: m.isRead,
    isFlagged: m.isFlagged,
    mailbox: m.mailbox,
    account: m.account,
    hasAttachments: m.hasAttachments,
  };
}

/**
 * Creates a successful MCP tool response. When `structured` is provided it is
 * returned as `structuredContent` so callers can consume typed data instead of
 * re-parsing the human text (A1).
 */
export function successResponse(message: string, structured?: Record<string, unknown>) {
  const res: {
    content: { type: "text"; text: string }[];
    structuredContent?: Record<string, unknown>;
  } = {
    content: [{ type: "text" as const, text: message }],
  };
  if (structured !== undefined) res.structuredContent = structured;
  return res;
}

/** Creates an error MCP tool response. */
export function errorResponse(message: string, structured?: Record<string, unknown>) {
  const res: {
    content: { type: "text"; text: string }[];
    isError: true;
    structuredContent?: Record<string, unknown>;
  } = {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
  if (structured !== undefined) res.structuredContent = structured;
  return res;
}

export type ToolResponse = ReturnType<typeof successResponse> | ReturnType<typeof errorResponse>;

/**
 * Render a partial-coverage warning from search/list diagnostics, so a caller
 * never mistakes an incomplete scan for a confirmed "no matches" (#24/#29).
 * Returns "" when coverage was complete.
 */
export function partialCoverageBlock(diagnostics: SearchDiagnostics): string {
  const notes: string[] = [];
  if (diagnostics.timedOutAccounts.length > 0) {
    notes.push(`timed out (no results) for account(s): ${diagnostics.timedOutAccounts.join(", ")}`);
  }
  if (diagnostics.skippedLargeMailboxes.length > 0) {
    notes.push(
      `skipped mailbox(es) too large to scan via AppleScript: ${diagnostics.skippedLargeMailboxes.join(", ")} — scope with \`mailbox\` (+ a \`dateFrom\`/\`dateTo\` window for search) to reach them`
    );
  }
  if (diagnostics.notSearchedMailboxes.length > 0) {
    notes.push(
      `could not finish scanning mailbox(es): ${diagnostics.notSearchedMailboxes.join(", ")}`
    );
  }
  if (notes.length === 0) return "";
  return `\n\n⚠️  Partial results — this is NOT a confirmed "no such mail":\n${notes
    .map((n) => `  - ${n}`)
    .join("\n")}`;
}

/**
 * Serial execution gate for AppleScript-backed tool calls (issue #11): only one
 * osascript invocation hits Mail.app's single-threaded AppleScript dispatch at a
 * time, with a short settle delay so the queue drains.
 */
export const serializeAppleScript = createSerialGate();

/**
 * Per-call timing, established when the request ARRIVES rather than when its
 * handler starts running (#135, second follow-up).
 *
 * The gate above means concurrent tool calls run strictly one at a time, so a
 * call can sit queued for the length of every call ahead of it. A handler that
 * bounds itself with `Date.now()` at its own first line therefore cannot see any
 * of that wait: it measures only its own execution, while the caller has been
 * waiting since it sent the request. Measured on a 3-account setup, three
 * concurrent `get-mail-stats` calls returned at 5.5s / 10.3s / 15.6s — a clean
 * 1x/2x/3x staircase — and the 15.6s call reported `partial: false` even with the
 * deadline set to 6s, because ~10s of it was queue wait the deadline never saw.
 *
 * This is the same failure shape #140 fixed one level down (bounding each step
 * doesn't bound the call); anchoring at arrival is what makes a deadline bound
 * the call as the CLIENT experiences it, which is the only latency that can trip
 * the client's own request timeout.
 */
export interface CallTiming {
  /** `Date.now()` when the request arrived, before it entered the serial gate. */
  arrivedAt: number;
  /** ms the call spent queued behind other calls before its handler ran. */
  queueWaitMs: number;
}

const callTiming = new AsyncLocalStorage<CallTiming>();

/**
 * Timing for the tool call running on this async stack, or `undefined` outside a
 * `withErrorHandling` handler (direct unit calls, module init).
 */
export function currentCallTiming(): CallTiming | undefined {
  return callTiming.getStore();
}

/**
 * Wraps a tool handler with consistent error handling, serialized through the
 * AppleScript gate so concurrent MCP tool calls don't race into Mail.app (#11).
 * Handlers may be sync or async; the result is awaited inside the gate.
 *
 * Arrival is stamped BEFORE the gate and exposed via `currentCallTiming()`, so a
 * handler working to a wall-clock deadline charges its queue wait against that
 * deadline instead of silently overrunning the client (#135).
 */
export function withErrorHandling<T extends Record<string, unknown>>(
  handler: (params: T) => ToolResponse | Promise<ToolResponse>,
  errorPrefix: string
) {
  return async (params: T) => {
    const arrivedAt = Date.now();
    return serializeAppleScript(async () => {
      const timing: CallTiming = { arrivedAt, queueWaitMs: Date.now() - arrivedAt };
      return callTiming.run(timing, async () => {
        try {
          return await handler(params);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return errorResponse(`${errorPrefix}: ${message}`);
        }
      });
    });
  };
}
