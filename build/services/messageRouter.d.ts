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
}): Promise<ToolResponse>;
//# sourceMappingURL=messageRouter.d.ts.map