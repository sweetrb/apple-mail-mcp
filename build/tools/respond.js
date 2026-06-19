/**
 * Shared MCP tool-response helpers, the AppleScript serial gate, and the
 * error-handling wrapper. Extracted from index.ts (D1) so every tool module
 * shares one consistent response/serialization path.
 *
 * @module tools/respond
 */
import { createSerialGate } from "../utils/serialize.js";
/**
 * Creates a successful MCP tool response. When `structured` is provided it is
 * returned as `structuredContent` so callers can consume typed data instead of
 * re-parsing the human text (A1).
 */
export function successResponse(message, structured) {
    const res = {
        content: [{ type: "text", text: message }],
    };
    if (structured !== undefined)
        res.structuredContent = structured;
    return res;
}
/** Creates an error MCP tool response. */
export function errorResponse(message, structured) {
    const res = {
        content: [{ type: "text", text: message }],
        isError: true,
    };
    if (structured !== undefined)
        res.structuredContent = structured;
    return res;
}
/**
 * Render a partial-coverage warning from search/list diagnostics, so a caller
 * never mistakes an incomplete scan for a confirmed "no matches" (#24/#29).
 * Returns "" when coverage was complete.
 */
export function partialCoverageBlock(diagnostics) {
    const notes = [];
    if (diagnostics.timedOutAccounts.length > 0) {
        notes.push(`timed out (no results) for account(s): ${diagnostics.timedOutAccounts.join(", ")}`);
    }
    if (diagnostics.skippedLargeMailboxes.length > 0) {
        notes.push(`skipped mailbox(es) too large to scan via AppleScript: ${diagnostics.skippedLargeMailboxes.join(", ")} — scope with \`mailbox\` (+ a \`dateFrom\`/\`dateTo\` window for search) to reach them`);
    }
    if (diagnostics.notSearchedMailboxes.length > 0) {
        notes.push(`could not finish scanning mailbox(es): ${diagnostics.notSearchedMailboxes.join(", ")}`);
    }
    if (notes.length === 0)
        return "";
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
 * Wraps a tool handler with consistent error handling, serialized through the
 * AppleScript gate so concurrent MCP tool calls don't race into Mail.app (#11).
 * Handlers may be sync or async; the result is awaited inside the gate.
 */
export function withErrorHandling(handler, errorPrefix) {
    return async (params) => {
        return serializeAppleScript(async () => {
            try {
                return await handler(params);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : "Unknown error";
                return errorResponse(`${errorPrefix}: ${message}`);
            }
        });
    };
}
