/**
 * Type Definitions for Apple Mail MCP Server
 *
 * This module contains all TypeScript interfaces and types used throughout
 * the Apple Mail MCP server. These types model:
 *
 * - Apple Mail data structures (messages, mailboxes, accounts)
 * - AppleScript execution results
 * - MCP tool parameters
 *
 * @module types
 */
/**
 * Represents an email message in Apple Mail.
 */
export interface Message {
    /** Unique identifier for the message */
    id: string;
    /** Subject line of the email */
    subject: string;
    /** Sender email address */
    sender: string;
    /** Sender display name (if available) */
    senderName?: string;
    /** Recipients (To field) */
    recipients: string[];
    /** CC recipients */
    ccRecipients?: string[];
    /** BCC recipients (only available for sent mail) */
    bccRecipients?: string[];
    /** Date the message was received */
    dateReceived: Date;
    /** Date the message was sent */
    dateSent?: Date;
    /** Whether the message has been read */
    isRead: boolean;
    /** Whether the message is flagged */
    isFlagged: boolean;
    /** Whether the message is marked as junk */
    isJunk: boolean;
    /** Whether the message has been deleted */
    isDeleted: boolean;
    /** Name of the mailbox containing the message */
    mailbox: string;
    /** Name of the account containing the message */
    account: string;
    /** Whether the message has attachments */
    hasAttachments: boolean;
}
/**
 * Per-account / per-mailbox diagnostics for a search, so callers can tell a
 * genuine "no matches" apart from "we couldn't finish searching."
 *
 * Apple Mail's AppleScript bridge is pathologically slow on large IMAP/Gmail
 * mailboxes (tens of thousands of messages): a single `whose` predicate — or
 * even reading the newest 20 messages by index — can blow past the Apple Event
 * timeout. Before this was tracked, those timeouts were swallowed and the
 * search returned a clean (but wrong) empty result. See issue #24.
 */
export interface SearchDiagnostics {
    /** True if any account/mailbox could not be fully searched (timeout or skip). */
    partial: boolean;
    /** Accounts that timed out entirely (whole-account AppleScript was killed). */
    timedOutAccounts: string[];
    /**
     * Mailboxes skipped because their message count exceeded the scan threshold,
     * formatted as "Account / Mailbox (count)".
     */
    skippedLargeMailboxes: string[];
    /**
     * Mailboxes that were reached but timed out or errored mid-scan, formatted as
     * "Account / Mailbox".
     */
    notSearchedMailboxes: string[];
}
/**
 * A search result paired with diagnostics about coverage.
 */
export interface SearchResult {
    messages: Message[];
    diagnostics: SearchDiagnostics;
}
/**
 * Represents the content of an email message.
 */
export interface MessageContent {
    /** Message identifier */
    id: string;
    /** Subject line */
    subject: string;
    /** Plain text content */
    plainText: string;
    /** HTML content (if available) */
    htmlContent?: string;
}
/**
 * Represents a mailbox (folder) in Apple Mail.
 */
export interface Mailbox {
    /** Display name of the mailbox */
    name: string;
    /** Account containing the mailbox */
    account: string;
    /** Number of unread messages */
    unreadCount: number;
    /** Total number of messages */
    messageCount: number;
}
/**
 * Represents an email account in Apple Mail.
 */
export interface Account {
    /** Display name of the account */
    name: string;
    /** Primary email address for the account */
    email: string;
    /** Account type (e.g., "iCloud", "Gmail", "Exchange") */
    accountType?: string;
    /** Whether the account is enabled */
    enabled: boolean;
}
/**
 * Represents an email attachment.
 */
export interface Attachment {
    /** Attachment identifier */
    id: string;
    /** Filename of the attachment */
    name: string;
    /** MIME type of the attachment */
    mimeType: string;
    /** Size in bytes */
    size: number;
}
/**
 * Options for AppleScript execution.
 */
export interface AppleScriptOptions {
    /** Maximum execution time in milliseconds */
    timeoutMs?: number;
    /** Maximum number of retry attempts */
    maxRetries?: number;
    /** Initial delay between retries in milliseconds */
    retryDelayMs?: number;
}
/**
 * Result from executing an AppleScript command.
 */
export interface AppleScriptResult {
    /** Whether the script executed successfully */
    success: boolean;
    /** Output from the script (stdout) */
    output: string;
    /** Error message if execution failed */
    error?: string;
}
/**
 * Parameters for searching messages.
 */
export interface SearchMessagesParams {
    /** Text to search for (searches subject, sender, content) */
    query?: string;
    /** Filter by sender email address */
    from?: string;
    /** Filter by recipient email address */
    to?: string;
    /** Filter by subject line */
    subject?: string;
    /** Mailbox to search in */
    mailbox?: string;
    /** Account to search in */
    account?: string;
    /** Filter by read status */
    isRead?: boolean;
    /** Filter by flagged status */
    isFlagged?: boolean;
    /** Start date for search range */
    dateFrom?: Date;
    /** End date for search range */
    dateTo?: Date;
    /** Maximum number of results to return */
    limit?: number;
}
/**
 * Parameters for sending an email.
 */
export interface SendEmailParams {
    /** Recipient email addresses (To field) */
    to: string[];
    /** CC recipients */
    cc?: string[];
    /** BCC recipients */
    bcc?: string[];
    /** Email subject line */
    subject: string;
    /** Email body content */
    body: string;
    /** Whether the body is HTML formatted */
    isHtml?: boolean;
    /** Account to send from */
    account?: string;
}
/**
 * Parameters for getting a message by ID.
 */
export interface GetMessageParams {
    /** Message identifier */
    id: string;
}
/**
 * Parameters for listing messages.
 */
export interface ListMessagesParams {
    /** Mailbox to list messages from */
    mailbox?: string;
    /** Account to list messages from */
    account?: string;
    /** Maximum number of messages to return */
    limit?: number;
    /** Filter to unread messages only */
    unreadOnly?: boolean;
}
/**
 * Parameters for mailbox operations.
 */
export interface MailboxParams {
    /** Mailbox name */
    name: string;
    /** Account containing the mailbox */
    account?: string;
}
/**
 * Parameters for moving a message.
 */
export interface MoveMessageParams {
    /** Message identifier */
    id: string;
    /** Destination mailbox name */
    mailbox: string;
    /** Account containing the destination mailbox */
    account?: string;
}
/**
 * A single recipient in a serial email (mail merge) operation.
 */
export interface SerialEmailRecipient {
    /** Recipient email address */
    email: string;
    /** Variable values for placeholder replacement (e.g., { Name: "Alice", Company: "Acme" }) */
    variables: Record<string, string>;
}
/**
 * Result of sending a serial email to a single recipient.
 */
export interface SerialEmailResult {
    /** Recipient email address */
    email: string;
    /** Whether the email was sent successfully */
    success: boolean;
    /** Error message if sending failed */
    error?: string;
}
/**
 * Individual check result in a health check.
 */
export interface HealthCheckItem {
    /** Name of the check */
    name: string;
    /** Whether the check passed */
    passed: boolean;
    /** Details about the check result */
    message: string;
}
/**
 * Result of a health check operation.
 */
export interface HealthCheckResult {
    /** Whether all checks passed */
    healthy: boolean;
    /** Individual check results */
    checks: HealthCheckItem[];
}
/**
 * Statistics for a mailbox.
 */
export interface MailboxStats {
    /** Mailbox name */
    name: string;
    /** Total message count */
    messageCount: number;
    /** Unread message count */
    unreadCount: number;
}
/**
 * Statistics for an account.
 */
export interface AccountStats {
    /** Account name */
    name: string;
    /** Total messages in account */
    totalMessages: number;
    /** Total unread messages */
    unreadMessages: number;
    /** Number of mailboxes */
    mailboxCount: number;
    /** Per-mailbox statistics */
    mailboxes: MailboxStats[];
}
/**
 * Recently received message counts.
 */
export interface RecentlyReceivedStats {
    /** Messages received in last 24 hours */
    last24h: number;
    /** Messages received in last 7 days */
    last7d: number;
    /** Messages received in last 30 days */
    last30d: number;
}
/**
 * Overall mail statistics.
 */
export interface MailStats {
    /** Total messages across all accounts */
    totalMessages: number;
    /** Total unread messages */
    totalUnread: number;
    /** Per-account statistics */
    accounts: AccountStats[];
    /** Recently received message counts */
    recentlyReceived?: RecentlyReceivedStats;
}
/**
 * Result of a batch operation on a single item.
 */
export interface BatchOperationResult {
    /** Item identifier */
    id: string;
    /** Whether the operation succeeded */
    success: boolean;
    /** Error message if operation failed */
    error?: string;
}
/**
 * Represents a mail rule in Apple Mail.
 */
export interface MailRule {
    /** Rule name */
    name: string;
    /** Whether the rule is enabled */
    enabled: boolean;
}
/**
 * An attachment to send (B4): either an absolute path to an existing file, or
 * raw bytes provided inline as base64 with a filename — so a client can attach
 * content it generated without first writing it to disk.
 */
export type AttachmentInput = string | {
    filename: string;
    contentBase64: string;
};
/** Header/field a rule condition tests (B2). */
export type RuleConditionField = "from" | "to" | "cc" | "subject" | "content";
/** How a rule condition compares the field to its value (B2). */
export type RuleConditionOperator = "contains" | "notContains" | "equals" | "beginsWith" | "endsWith";
export interface RuleCondition {
    field: RuleConditionField;
    operator: RuleConditionOperator;
    value: string;
}
export interface RuleActions {
    markRead?: boolean;
    markFlagged?: boolean;
    /** Move matched messages to trash. */
    delete?: boolean;
    /** Move matched messages to this mailbox (by name). */
    moveTo?: string;
    /** Account that owns `moveTo` (disambiguates same-named mailboxes). */
    moveToAccount?: string;
}
/** Specification for creating a mail rule (B2). */
export interface RuleSpec {
    name: string;
    conditions: RuleCondition[];
    actions?: RuleActions;
    /** true (default) = all conditions must match; false = any. */
    matchAll?: boolean;
    /** Whether the rule is enabled on creation (default true). */
    enabled?: boolean;
}
/**
 * Represents a contact from Contacts.app.
 */
export interface Contact {
    /** Full name */
    name: string;
    /** Email addresses */
    emails: string[];
    /** Phone numbers */
    phones: string[];
}
/**
 * Represents a stored email template.
 */
export interface EmailTemplate {
    /** Template identifier */
    id: string;
    /** Template name */
    name: string;
    /** Default subject line */
    subject: string;
    /** Template body */
    body: string;
    /** Default recipients */
    to?: string[];
    /** Default CC recipients */
    cc?: string[];
}
/**
 * Status of Mail.app sync activity.
 */
export interface SyncStatus {
    /** Whether sync activity was detected */
    syncDetected: boolean;
    /** Number of items pending upload */
    pendingUpload: number;
    /** Whether there was recent database activity */
    recentActivity: boolean;
    /** Seconds since last database change */
    secondsSinceLastChange: number;
    /** Error message if status check failed */
    error?: string;
}
//# sourceMappingURL=types.d.ts.map