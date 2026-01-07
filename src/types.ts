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

// =============================================================================
// Apple Mail Data Models
// =============================================================================

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

// =============================================================================
// AppleScript Execution
// =============================================================================

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

// =============================================================================
// MCP Tool Parameters
// =============================================================================

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

// =============================================================================
// Health Check
// =============================================================================

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

// =============================================================================
// Mail Statistics
// =============================================================================

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

// =============================================================================
// Batch Operations
// =============================================================================

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

// =============================================================================
// Sync Detection
// =============================================================================

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
