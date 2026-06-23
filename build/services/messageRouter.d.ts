import type { ImapOpResult } from "../services/imapClient.js";
import { type ToolResponse } from "../tools/respond.js";
/** True when the id is an IMAP composite token (routes to IMAP). */
export declare function isImapId(id: string): boolean;
/**
 * Route a single-message operation to IMAP (when the id is an `imap:` token) or
 * to the AppleScript handler. Maps an IMAP `ImapOpResult` to a tool response,
 * preferring its `info` text on success and `error` on failure.
 */
export declare function routeMessage(id: string, opts: {
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
}): Promise<ToolResponse>;
//# sourceMappingURL=messageRouter.d.ts.map