/**
 * Apple Mail Manager
 *
 * Handles all interactions with Apple Mail via AppleScript.
 * This is the core service layer for the MCP server.
 *
 * Architecture:
 * - Text escaping is handled by dedicated helper functions
 * - AppleScript generation uses template builders for consistency
 * - All public methods return typed results (no raw strings)
 * - Error handling is consistent across all operations
 *
 * @module services/appleMailManager
 */
import type { Message, MessageContent, Mailbox, Account, Attachment, HealthCheckResult, MailStats, BatchOperationResult, SyncStatus, RecentlyReceivedStats, MailRule, RuleSpec, AttachmentInput, Contact, EmailTemplate, SerialEmailRecipient, SerialEmailResult, SearchDiagnostics, SearchResult } from "../types.js";
/**
 * Merge a per-account SearchDiagnostics into an aggregate (all-accounts) one.
 *
 * Exported for unit testing.
 */
export declare function mergeSearchDiagnostics(into: SearchDiagnostics, from: SearchDiagnostics): void;
/**
 * Split a per-account search payload into its message-list portion and parsed
 * diagnostics. The AppleScript appends a trailer of the form (using the
 * control-character separators defined above):
 *
 *   <messages>{DIAG_MARKER}timedOut=true{DIAG_FIELD_SEP}skipped=Foo (9000){DIAG_ITEM_SEP}{DIAG_FIELD_SEP}notSearched=Bar{DIAG_ITEM_SEP}
 *
 * `skipped`/`notSearched` are DIAG_ITEM_SEP-separated mailbox names, each prefixed
 * with the account name on the way out so the aggregate result is unambiguous.
 *
 * Exported (pure, no Mail.app dependency) for unit testing — this is the logic
 * that turns a swallowed timeout into a visible partial result (issue #24).
 */
export declare function splitSearchDiagnostics(output: string, account: string): {
    payload: string;
    diagnostics: SearchDiagnostics;
};
/**
 * True if `resolvedPath` is one of the allowed roots or strictly inside one.
 *
 * Uses a path-segment boundary check rather than a bare `startsWith`, which
 * would let a sibling whose name merely shares the prefix slip through —
 * `/Volumes-evil` startsWith `/Volumes`, `/Users/robother` startsWith
 * `/Users/rob` (audit finding #12). `resolvedPath` must already be absolute
 * (caller passes `resolve(...)` output).
 */
export declare function isPathWithinAllowedRoots(resolvedPath: string): boolean;
/**
 * Turn a raw mailbox delete/rename failure into an actionable, non-retryable
 * message when it's the known server-side-mailbox limitation (#42); otherwise
 * return the raw error unchanged.
 *
 * Exported for unit testing.
 */
export declare function describeMailboxOpError(op: "create" | "delete" | "rename", raw: string): string;
/** Env var to pin the default account (matched by account name or email). */
export declare const DEFAULT_ACCOUNT_ENV = "APPLE_MAIL_MCP_DEFAULT_ACCOUNT";
/**
 * Choose the account to use when a tool call omits `account`.
 *
 * Priority: explicit `override` (by name or email) → Mail's default-send
 * account *if enabled* → first enabled account → first account → null. The key
 * guarantee (issue #47): a **disabled** account is never chosen implicitly — it
 * can only be selected via an explicit override (deliberate user intent) or as
 * a last resort when no account is enabled. This prevents operations silently
 * landing in a configured-but-disabled account (e.g. an unused iCloud account
 * that's still addressable via AppleScript).
 *
 * Pure/exported for unit testing.
 */
export declare function chooseDefaultAccount(accounts: Account[], opts?: {
    override?: string;
    defaultSendEmail?: string;
}): string | null;
export declare function escapeForAppleScript(text: string): string;
/**
 * Emits AppleScript that builds a date into the variable `varName` from numeric
 * components.
 *
 * This is locale-independent, unlike `date "May 30, 2026"` string coercion,
 * which AppleScript parses using the system locale. On a non-English locale
 * (e.g. pt_PT) the English month name throws "Invalid date and time (-30720)";
 * because the comparison happens inside the per-message `try` in searchMessages,
 * that error is swallowed and every message is skipped, so the search returns
 * zero results even when matches exist. See issue #15.
 *
 * `day` is reset to 1 before assigning month/year so an existing day-of-month
 * (e.g. 31) cannot overflow into the next month when the month is changed.
 *
 * Exported for unit testing.
 */
export declare function buildAppleScriptDate(varName: string, d: Date): string;
/**
 * Manager class for Apple Mail operations.
 *
 * Provides methods for:
 * - Reading and searching messages
 * - Sending emails
 * - Managing mailboxes
 * - Listing accounts
 *
 * All operations are synchronous since they rely on AppleScript
 * execution via osascript. Error handling is consistent: methods
 * return null/false/empty-array on failure rather than throwing.
 */
export interface SearchConditionFilters {
    query?: string;
    from?: string;
    subject?: string;
    isRead?: boolean;
    isFlagged?: boolean;
}
/**
 * Build the AppleScript `whose` clause for searchMessages from a filter set.
 *
 * - `query` is a subject-OR-sender substring match, parenthesized so it groups
 *   correctly when ANDed with other filters.
 * - `from` and `subject` are substring matches (`sender`/`subject` contains).
 * - `isRead` / `isFlagged` are boolean status checks.
 * - Returns "" when no filters are set. Every interpolated value is escaped.
 *
 * Exported for unit testing: the bug this addresses (filters declared in the
 * tool schema but silently dropped) lived in this logic, so it gets direct
 * coverage independent of Mail.app.
 */
export declare function buildSearchCondition(filters: SearchConditionFilters): string;
export declare class AppleMailManager {
    /**
     * Default account used when no account is specified.
     */
    private defaultAccount;
    /**
     * TTL cache for expensive AppleScript queries that rarely change.
     * Caches account list and per-account mailbox names to avoid
     * redundant AppleScript roundtrips on every tool call.
     */
    private cache;
    /** Cache TTL in milliseconds (60 seconds). */
    private readonly CACHE_TTL_MS;
    /**
     * Returns cached accounts or fetches fresh data if cache is expired/empty.
     */
    private getCachedAccounts;
    /**
     * Returns cached mailbox names for an account, or fetches fresh.
     * This caches only the name list used by resolveMailbox(), not the
     * full Mailbox objects with counts (which change frequently).
     */
    private getCachedMailboxNames;
    /**
     * Invalidate all caches. Call after operations that change
     * mailbox structure (create/delete/rename mailbox).
     */
    private invalidateCache;
    /**
     * Reads the live `enabled` flag for an account directly from Mail (bypassing
     * the 60 s account cache) so a guard reflects an account that was enabled or
     * disabled out-of-band. Returns true/false when known, or null when the probe
     * is inconclusive — account not found, or the probe itself failed. Callers
     * treat null as "can't tell, don't block".
     */
    private isAccountEnabled;
    /**
     * Guard for AppleScript-backed structural operations (create / delete / rename
     * mailbox). When the target account is disabled in Mail, Mail holds no live
     * server session for it, so the operation fails inside Mail with an opaque
     * AppleEvent -10000 — and a multi-step op like rename can leave half-built
     * state behind (an orphaned destination mailbox). Detect the disabled account
     * up front and refuse with an actionable message instead of attempting the
     * doomed op.
     *
     * Returns an error string when the account is known-disabled, else null —
     * including when the state can't be determined. We fail open: an inconclusive
     * probe never blocks an otherwise-valid operation.
     *
     * Applies only to the AppleScript backend. Direct-IMAP accounts talk to the
     * server independent of Mail's enabled toggle and are routed before reaching
     * the manager.
     */
    private disabledAccountGuard;
    /**
     * Best-effort rollback for a failed rename: delete a just-created destination
     * mailbox, but ONLY if it is empty, so any messages that did move are never
     * destroyed. Returns true if the empty orphan was removed.
     */
    private deleteMailboxIfEmpty;
    /**
     * Resolves the account to use for an operation when the caller omits one.
     *
     * Order (see chooseDefaultAccount): the APPLE_MAIL_MCP_DEFAULT_ACCOUNT env
     * override → Mail.app's configured default-send account (if enabled) → the
     * first enabled account. A disabled account is never chosen implicitly (#47).
     */
    private resolveAccount;
    /**
     * Resolves a mailbox name to its actual name in the account.
     *
     * Different account types (IMAP, Exchange, iCloud) use different
     * mailbox naming conventions:
     * - IMAP/Gmail: "INBOX", "Sent", "Drafts"
     * - Exchange: "Inbox", "Sent Items", "Deleted Items"
     * - iCloud: "INBOX", "Sent", "Trash"
     *
     * This method tries to find a matching mailbox by:
     * 1. Exact match
     * 2. Case-insensitive match
     * 3. Known aliases (e.g., "Sent" -> "Sent Items")
     *
     * @param mailbox - Requested mailbox name
     * @param account - Account to search in
     * @returns Actual mailbox name, or original if not found
     */
    private resolveMailbox;
    /**
     * Search for messages matching criteria.
     *
     * @param query - Text to search for in subject or sender
     * @param mailbox - Mailbox to search in (e.g., "INBOX")
     * @param account - Account to search in
     * @param limit - Maximum number of results
     * @returns Array of matching messages
     */
    searchMessages(query?: string, mailbox?: string, account?: string, limit?: number, dateFrom?: string, dateTo?: string, from?: string, subject?: string, isRead?: boolean, isFlagged?: boolean): Message[];
    /**
     * Search for messages, returning both the matches and diagnostics describing
     * how complete the search was.
     *
     * This is the correctness fix for issue #24. The previous implementation ran
     * an unbounded `messages of mb whose <predicate>` over every mailbox in an
     * account; on large IMAP/Gmail mailboxes (tens of thousands of messages) that
     * single Apple Event exceeded the timeout, the error was swallowed by a `try`,
     * and the function returned a clean — but wrong — empty result. Callers/agents
     * then confidently reported "no such mail."
     *
     * Two changes fix that:
     *  1. Cheap count-guard: mailboxes larger than the scan threshold are skipped
     *     (Apple Mail can't search them before timing out anyway) and reported.
     *  2. Honest diagnostics: per-account/per-mailbox timeouts are surfaced as a
     *     `partial` result with the affected scopes named, instead of an empty
     *     "success."
     */
    searchMessagesWithDiagnostics(query?: string, mailbox?: string, account?: string, limit?: number, dateFrom?: string, dateTo?: string, from?: string, subject?: string, isRead?: boolean, isFlagged?: boolean): SearchResult;
    /**
     * Split a per-account search payload into its message list and the DIAG
     * trailer, parse both, and return a SearchResult. See searchMessagesWithDiagnostics.
     */
    private parseSearchResult;
    /**
     * Get a message by ID.
     *
     * Note: Mail.app message IDs are unique per mailbox. This method searches
     * all mailboxes in all accounts to find the message.
     */
    getMessageById(id: string, deepAttachmentCheck?: boolean): Message | null;
    /**
     * Get the content of a message.
     *
     * @param id - Message ID
     * @param includeHtml - When true, also fetch the raw MIME source and extract
     *   the `text/html` body part into `htmlContent`. This is opt-in because the
     *   source can be MB-sized (it includes base64 attachments) and the plain-text
     *   path doesn't need it; fetching it unconditionally was both slow and, worse,
     *   returned the entire raw MIME blob mislabeled as HTML (#32).
     */
    getMessageContent(id: string, includeHtml?: boolean): MessageContent | null;
    /**
     * Get the raw MIME source of a message.
     * Used as fallback for attachment extraction when AppleScript
     * mail attachments returns empty.
     *
     * Timeout is 2x the default (120s) because `source of msg` returns
     * the entire raw message including base64-encoded attachments —
     * a 20MB attachment can take several seconds over Exchange/IMAP.
     */
    getRawSource(id: string): string | null;
    /**
     * List messages in a mailbox.
     *
     * @param mailbox - Mailbox to list from (default: INBOX)
     * @param account - Account to list from
     * @param limit - Maximum number of messages
     * @returns Array of messages
     */
    listMessages(mailbox?: string, account?: string, limit?: number, from?: string, offset?: number): Message[];
    /**
     * List messages, returning matches plus coverage diagnostics.
     *
     * Like `searchMessages`, the unscoped (all-mailboxes) path used to iterate
     * `messages of mb` over every mailbox with a swallowing per-mailbox `try`,
     * so a large IMAP/Gmail mailbox timed out and the method returned `[]` — a
     * false "No messages found." This applies the same #24 discipline: skip
     * mailboxes above the scan threshold (reported), enforce a per-account
     * wall-clock budget, capture per-mailbox timeouts, and surface all of it as a
     * partial result. (by-id lookups don't need this — `whose id is` is indexed
     * and returns instantly even on a 44k-message mailbox.)
     */
    listMessagesWithDiagnostics(mailbox?: string, account?: string, limit?: number, from?: string, offset?: number): SearchResult;
    /**
     * Parse message list output from AppleScript.
     *
     * Two emission schemas, disambiguated by length:
     *   7 fields: single-mailbox — ...|hasAtt (mailbox from caller)
     *   8 fields: all-mailboxes — ...|mailbox|hasAtt
     *
     * `hasAttachments` here is the fast-path AppleScript count only; it will
     * false-negative for MIME-embedded attachments (a known AppleScript
     * limitation). Use getMessage or list-attachments for authoritative info.
     */
    private parseMessageList;
    /**
     * Send an email.
     *
     * @param to - Recipient email addresses
     * @param subject - Email subject
     * @param body - Email body (plain text)
     * @param cc - CC recipients
     * @param bcc - BCC recipients
     * @param account - Account to send from
     * @returns true if sent successfully
     */
    sendEmail(to: string[], subject: string, body: string, cc?: string[], bcc?: string[], account?: string, attachments?: AttachmentInput[]): boolean;
    private sendEmailWithPaths;
    /**
     * Send individual personalized emails to a list of recipients (mail merge).
     *
     * Replaces {{placeholder}} tokens in subject and body with per-recipient values.
     * Each recipient receives their own individual email.
     *
     * @param recipients - List of recipient objects with email and variable values
     * @param subject - Email subject (may contain {{placeholders}})
     * @param body - Email body (may contain {{placeholders}})
     * @param account - Account to send from
     * @param delayMs - Delay between sends in milliseconds (default: 500, max: 10000)
     * @returns Array of per-recipient results
     */
    sendSerialEmail(recipients: SerialEmailRecipient[], subject: string, body: string, account?: string, delayMs?: number): SerialEmailResult[];
    /**
     * Create a draft email (saved to Drafts folder, not sent).
     *
     * @param to - Recipient email addresses
     * @param subject - Email subject
     * @param body - Email body (plain text)
     * @param cc - CC recipients
     * @param bcc - BCC recipients
     * @param account - Account to create draft in
     * @returns true if draft created successfully
     */
    createDraft(to: string[], subject: string, body: string, cc?: string[], bcc?: string[], account?: string, attachments?: AttachmentInput[]): boolean;
    private createDraftWithCommands;
    /**
     * Reply to a message.
     *
     * @param id - Message ID to reply to
     * @param body - Reply body
     * @param replyAll - If true, reply to all recipients
     * @param send - If true, send immediately; if false, save as draft
     * @returns true if reply created/sent successfully
     */
    replyToMessage(id: string, body: string, replyAll?: boolean, send?: boolean): boolean;
    /**
     * Forward a message.
     *
     * @param id - Message ID to forward
     * @param to - Recipients to forward to
     * @param body - Optional body to prepend
     * @param send - If true, send immediately; if false, save as draft
     * @returns true if forward created/sent successfully
     */
    forwardMessage(id: string, to: string[], body?: string, send?: boolean): boolean;
    /**
     * Helper to find and operate on a message by ID.
     */
    private findMessageScript;
    /**
     * Mark a message as read.
     */
    markAsRead(id: string): boolean;
    /**
     * Mark a message as unread.
     */
    markAsUnread(id: string): boolean;
    /**
     * AppleScript statement(s) to flag a message variable, optionally setting its
     * color. `colorIndex` is Apple's flag-index palette (0 red, 1 orange,
     * 2 yellow, 3 green, 4 blue, 5 purple, 6 gray); it is validated to 0-6 by the
     * schema layer and is a number, so it is safe to interpolate. Omitting it
     * applies Mail's default flag without touching the color.
     */
    private flagOperation;
    /**
     * Flag a message, optionally with a color (see {@link flagOperation}).
     */
    flagMessage(id: string, colorIndex?: number): boolean;
    /**
     * Resolve a message's numeric Mail.app id from its RFC822 Message-ID (the
     * backend-independent join key). This bridges an `imap:` id to the numeric id
     * required to apply a flag *color* — IMAP flags are colorless, so a smart
     * mailbox keyed on flag color can only ever match a message flagged via the
     * AppleScript numeric-id path.
     *
     * The Message-ID is matched both bracketless and `<bracketed>` (Mail returns
     * it bracketless; IMAP envelopes carry the brackets). When `accountName` is
     * given the search is scoped to that account, checking its INBOX first (swept
     * messages live there) to avoid scanning huge All Mail/Archive mailboxes.
     *
     * @returns the numeric id as a string, or null if no message matches.
     */
    findNumericIdByMessageId(messageId: string, accountName?: string): string | null;
    /**
     * Unflag a message.
     */
    unflagMessage(id: string): boolean;
    /**
     * Delete a message.
     */
    deleteMessage(id: string): {
        success: boolean;
        error?: string;
    };
    /**
     * Classify a failed message mutation (delete/move) into an actionable error.
     *
     * Mail.app's scripting bridge cannot delete or move drafts, and cannot mutate
     * messages in some server-side special mailboxes — it throws `AppleEvent
     * handler failed` rather than a useful message (#42). When that pattern is
     * seen, look up the message's mailbox (cheap, indexed `whose id is`) to give a
     * draft-specific or server-specific hint. Other errors (e.g. "Message not
     * found", "ambiguous destination") pass through unchanged.
     */
    private classifyMessageMutationError;
    /**
     * Move a message to a different mailbox.
     */
    /**
     * Move a message to a destination mailbox, with full nested-mailbox support.
     *
     * Resolving the destination as `mailbox "X" of account "Y"` only finds
     * top-level mailboxes, so nested destinations (e.g. a "Moore" subfolder)
     * silently failed. Instead we walk the target account's full mailbox tree and
     * match by name. Resolution is:
     *   - account-scoped (won't move to a same-named mailbox in another account)
     *   - ambiguity-aware: if the name matches more than one mailbox in the
     *     account we refuse to guess and return an error — silently moving mail to
     *     the wrong folder is worse than failing.
     * The source message is located by walking every account's tree breadth-first
     * (top-level mailboxes like Inbox are checked first), so messages in nested
     * mailboxes are found too.
     *
     * Returns a result object so batch callers can surface the specific failure
     * (destination not found / ambiguous / message not found).
     */
    private moveMessageInternal;
    moveMessage(id: string, mailbox: string, account?: string): {
        success: boolean;
        error?: string;
    };
    /**
     * Run one operation over many message IDs in a SINGLE osascript invocation.
     *
     * Previously each batch method looped and called the per-id method, so a
     * 100-id batch spawned 100 osascript processes — each one re-resolving
     * accounts and walking the whole account→mailbox tree — all serialized
     * through the gate (issue #31). This walks the tree exactly once: for each
     * mailbox it probes the still-pending IDs with `whose id is` (indexed, so
     * effectively free) and applies `operation` to any match, tracking found IDs
     * so it can stop early once all are accounted for. Per-id outcomes come back
     * as control-char-delimited `id<FS>status` records (status: `ok`,
     * `notfound`, or `error:<msg>`), and results are returned in input order.
     *
     * `setup` runs once before the walk (used by move to resolve the destination);
     * it may bail the whole batch by returning a `BATCH_FATAL`-prefixed string.
     */
    private runBatchOperation;
    /**
     * Delete multiple messages at once (single tree walk — see runBatchOperation).
     */
    batchDeleteMessages(ids: string[]): BatchOperationResult[];
    /**
     * Move multiple messages to a mailbox at once (single tree walk).
     *
     * The destination is resolved once (account-scoped, ambiguity-aware — a name
     * matching more than one mailbox fails the whole batch rather than guessing),
     * then every matched message is moved in the same walk.
     */
    batchMoveMessages(ids: string[], mailbox: string, account?: string): BatchOperationResult[];
    /**
     * Mark multiple messages as read at once (single tree walk).
     */
    batchMarkAsRead(ids: string[]): BatchOperationResult[];
    /**
     * Mark multiple messages as unread at once (single tree walk).
     */
    batchMarkAsUnread(ids: string[]): BatchOperationResult[];
    /**
     * Flag multiple messages at once (single tree walk).
     */
    batchFlagMessages(ids: string[], colorIndex?: number): BatchOperationResult[];
    /**
     * Unflag multiple messages at once (single tree walk).
     */
    batchUnflagMessages(ids: string[]): BatchOperationResult[];
    /**
     * List attachments for a message.
     * Tries AppleScript first, falls back to MIME source parsing
     * when AppleScript returns empty (known issue across all account types).
     */
    listAttachments(id: string): Attachment[];
    /**
     * Save an attachment from a message to disk.
     * Tries AppleScript first, falls back to MIME source extraction
     * when AppleScript can't find the attachment.
     */
    saveAttachment(id: string, attachmentName: string, savePath: string): boolean;
    /**
     * Fetch an attachment's bytes as base64 (B4) — the read counterpart to
     * sending inline base64 content. Reuses saveAttachment via a throwaway temp
     * dir (under an allowed root), then reads and encodes the file.
     */
    getAttachmentBase64(id: string, attachmentName: string): {
        success: boolean;
        base64?: string;
        bytes?: number;
        error?: string;
    };
    /**
     * List all mailboxes for an account.
     */
    listMailboxes(account?: string): Mailbox[];
    /**
     * Get unread count for a mailbox.
     */
    getUnreadCount(mailbox?: string, account?: string): number;
    /**
     * Create a new mailbox.
     */
    createMailbox(name: string, account?: string): {
        success: boolean;
        error?: string;
    };
    /**
     * Delete a mailbox.
     */
    deleteMailbox(name: string, account?: string): {
        success: boolean;
        error?: string;
    };
    /**
     * Rename a mailbox by creating a new one, moving messages, and deleting the old one.
     */
    renameMailbox(oldName: string, newName: string, account?: string): {
        success: boolean;
        error?: string;
    };
    /**
     * List all mail accounts (uses cache).
     */
    listAccounts(): Account[];
    /**
     * Fetches account list directly from Mail.app via AppleScript.
     * Used internally by the cache; prefer getCachedAccounts() or listAccounts().
     */
    private fetchAccounts;
    /**
     * Fetches mailbox names for an account directly from Mail.app.
     * Used internally by the cache; prefer getCachedMailboxNames().
     */
    private fetchMailboxNames;
    /**
     * List all mail rules.
     */
    listRules(): MailRule[];
    /**
     * Enable or disable a mail rule.
     */
    setRuleEnabled(ruleName: string, enabled: boolean): boolean;
    /**
     * Create a mail rule (B2). Builds conditions (from/to/cc/subject/content with
     * a match operator) and actions (mark read/flagged, delete, move to a
     * mailbox) on a real Mail.app rule. Returns an error string on failure.
     */
    createRule(opts: RuleSpec): {
        success: boolean;
        error?: string;
    };
    /**
     * Delete a mail rule by name (B2). Returns false if no such rule exists.
     */
    deleteRule(ruleName: string): boolean;
    /**
     * Search contacts by name or email.
     */
    searchContacts(query: string): Contact[];
    private templateStore;
    /**
     * List all stored templates.
     */
    listTemplates(): EmailTemplate[];
    /**
     * Get a template by ID.
     */
    getTemplate(id: string): EmailTemplate | null;
    /**
     * Create or update a template (persisted).
     */
    saveTemplate(name: string, subject: string, body: string, to?: string[], cc?: string[], id?: string): EmailTemplate;
    /**
     * Delete a template (persisted).
     */
    deleteTemplate(id: string): boolean;
    /**
     * Use a template to create a draft.
     */
    useTemplate(id: string, overrides?: {
        to?: string[];
        cc?: string[];
        subject?: string;
        body?: string;
    }): boolean;
    /**
     * Run health check on Mail.app connectivity.
     */
    healthCheck(): HealthCheckResult;
    /**
     * Get mail statistics.
     */
    getMailStats(): MailStats;
    /**
     * Get counts of recently received messages.
     *
     * Only counts messages in INBOX for performance (scanning all mailboxes
     * is too slow for large accounts).
     *
     * @returns Counts of messages received in last 24h, 7d, and 30d
     */
    getRecentlyReceivedStats(): RecentlyReceivedStats;
    /**
     * Get sync status for Mail.app.
     *
     * Checks for sync activity indicators like:
     * - Activity monitor status
     * - Network activity status
     * - Background refresh indicators
     *
     * @returns Sync status information
     */
    getSyncStatus(): SyncStatus;
}
//# sourceMappingURL=appleMailManager.d.ts.map