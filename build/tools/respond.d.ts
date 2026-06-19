import type { SearchDiagnostics, Message } from "../types.js";
/**
 * Plain, JSON-friendly summary of a Message for `structuredContent` (A1) — dates
 * as ISO strings, only the fields an agent needs to act (id is the key it passes
 * back to get-message / mutations).
 */
export declare function messageSummary(m: Message): Record<string, unknown>;
/**
 * Creates a successful MCP tool response. When `structured` is provided it is
 * returned as `structuredContent` so callers can consume typed data instead of
 * re-parsing the human text (A1).
 */
export declare function successResponse(message: string, structured?: Record<string, unknown>): {
    content: {
        type: "text";
        text: string;
    }[];
    structuredContent?: Record<string, unknown>;
};
/** Creates an error MCP tool response. */
export declare function errorResponse(message: string, structured?: Record<string, unknown>): {
    content: {
        type: "text";
        text: string;
    }[];
    isError: true;
    structuredContent?: Record<string, unknown>;
};
export type ToolResponse = ReturnType<typeof successResponse> | ReturnType<typeof errorResponse>;
/**
 * Render a partial-coverage warning from search/list diagnostics, so a caller
 * never mistakes an incomplete scan for a confirmed "no matches" (#24/#29).
 * Returns "" when coverage was complete.
 */
export declare function partialCoverageBlock(diagnostics: SearchDiagnostics): string;
/**
 * Serial execution gate for AppleScript-backed tool calls (issue #11): only one
 * osascript invocation hits Mail.app's single-threaded AppleScript dispatch at a
 * time, with a short settle delay so the queue drains.
 */
export declare const serializeAppleScript: import("../utils/serialize.js").SerialGate;
/**
 * Wraps a tool handler with consistent error handling, serialized through the
 * AppleScript gate so concurrent MCP tool calls don't race into Mail.app (#11).
 * Handlers may be sync or async; the result is awaited inside the gate.
 */
export declare function withErrorHandling<T extends Record<string, unknown>>(handler: (params: T) => ToolResponse | Promise<ToolResponse>, errorPrefix: string): (params: T) => Promise<ToolResponse>;
//# sourceMappingURL=respond.d.ts.map