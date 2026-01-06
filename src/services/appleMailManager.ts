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

import { executeAppleScript } from "@/utils/applescript.js";
import type {
  Message,
  MessageContent,
  Mailbox,
  Account,
  Attachment,
  HealthCheckResult,
  MailStats,
  AccountStats,
} from "@/types.js";

// =============================================================================
// Text Processing Utilities
// =============================================================================

/**
 * Escapes text for safe embedding in AppleScript string literals.
 *
 * AppleScript strings use double quotes, so we need to escape:
 * 1. Backslashes (\) - escaped as \\
 * 2. Double quotes (") - escaped as \"
 *
 * @param text - Raw text to escape
 * @returns Text safe for AppleScript string embedding
 */
function escapeForAppleScript(text: string): string {
  if (!text) return "";
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Parses AppleScript date representation to JavaScript Date.
 *
 * AppleScript returns dates in a verbose format like:
 * "date Saturday, December 27, 2025 at 3:44:02 PM"
 *
 * @param appleScriptDate - Date string from AppleScript
 * @returns Parsed Date, or current date if parsing fails
 */
function parseAppleScriptDate(appleScriptDate: string): Date {
  const withoutPrefix = appleScriptDate.replace(/^date\s+/, "");
  const normalized = withoutPrefix.replace(" at ", " ");
  const parsed = new Date(normalized);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * Builds an AppleScript command scoped to a specific account.
 */
function buildAccountScopedScript(account: string, command: string): string {
  return `
    tell application "Mail"
      tell account "${escapeForAppleScript(account)}"
        ${command}
      end tell
    end tell
  `;
}

/**
 * Builds an AppleScript command at the application level.
 */
function buildAppLevelScript(command: string): string {
  return `
    tell application "Mail"
      ${command}
    end tell
  `;
}

// =============================================================================
// Apple Mail Manager Class
// =============================================================================

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
export class AppleMailManager {
  /**
   * Default account used when no account is specified.
   */
  private defaultAccount: string | null = null;

  /**
   * Resolves the account to use for an operation.
   * Falls back to first available account if not specified.
   */
  private resolveAccount(account?: string): string {
    if (account) return account;
    if (this.defaultAccount) return this.defaultAccount;

    // Get first account as default
    const accounts = this.listAccounts();
    if (accounts.length > 0) {
      this.defaultAccount = accounts[0].name;
      return this.defaultAccount;
    }

    return "iCloud"; // Last resort fallback
  }

  // ===========================================================================
  // Message Operations
  // ===========================================================================

  /**
   * Search for messages matching criteria.
   *
   * @param query - Text to search for in subject or sender
   * @param mailbox - Mailbox to search in (e.g., "INBOX")
   * @param account - Account to search in
   * @param limit - Maximum number of results
   * @returns Array of matching messages
   */
  searchMessages(query?: string, mailbox?: string, account?: string, limit = 50): Message[] {
    const targetAccount = this.resolveAccount(account);
    const targetMailbox = mailbox || "INBOX";

    // Build the search condition
    let searchCondition = "";
    if (query) {
      const safeQuery = escapeForAppleScript(query);
      searchCondition = `whose subject contains "${safeQuery}" or sender contains "${safeQuery}"`;
    }

    const searchCommand = `
      set msgList to {}
      set theMailbox to mailbox "${escapeForAppleScript(targetMailbox)}"
      set allMessages to messages of theMailbox ${searchCondition}
      set msgCount to 0
      repeat with msg in allMessages
        if msgCount >= ${limit} then exit repeat
        try
          set msgId to id of msg
          set msgSubject to subject of msg
          set msgSender to sender of msg
          set msgDate to date received of msg
          set msgRead to read status of msg
          set msgFlagged to flagged status of msg
          set end of msgList to msgId & "|||" & msgSubject & "|||" & msgSender & "|||" & (msgDate as string) & "|||" & msgRead & "|||" & msgFlagged
          set msgCount to msgCount + 1
        end try
      end repeat
      set AppleScript's text item delimiters to "|||ITEM|||"
      return msgList as text
    `;

    const script = buildAccountScopedScript(targetAccount, searchCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to search messages: ${result.error}`);
      return [];
    }

    if (!result.output.trim()) return [];

    return this.parseMessageList(result.output, targetMailbox, targetAccount);
  }

  /**
   * Get a message by ID.
   */
  getMessageById(id: string): Message | null {
    const script = buildAppLevelScript(`
      try
        set msg to message id ${id}
        set msgSubject to subject of msg
        set msgSender to sender of msg
        set msgDate to date received of msg
        set msgRead to read status of msg
        set msgFlagged to flagged status of msg
        set msgJunk to junk mail status of msg
        set msgDeleted to deleted status of msg
        set msgMailbox to name of mailbox of msg
        set msgAccount to name of account of mailbox of msg
        return msgSubject & "|||" & msgSender & "|||" & (msgDate as string) & "|||" & msgRead & "|||" & msgFlagged & "|||" & msgJunk & "|||" & msgDeleted & "|||" & msgMailbox & "|||" & msgAccount
      on error
        return ""
      end try
    `);

    const result = executeAppleScript(script);

    if (!result.success || !result.output.trim()) {
      console.error(`Failed to get message ${id}: ${result.error}`);
      return null;
    }

    const parts = result.output.split("|||");
    if (parts.length < 9) return null;

    return {
      id: id.toString(),
      subject: parts[0],
      sender: parts[1],
      recipients: [],
      dateReceived: parseAppleScriptDate(parts[2]),
      isRead: parts[3] === "true",
      isFlagged: parts[4] === "true",
      isJunk: parts[5] === "true",
      isDeleted: parts[6] === "true",
      mailbox: parts[7],
      account: parts[8],
      hasAttachments: false, // Would require separate query
    };
  }

  /**
   * Get the content of a message.
   */
  getMessageContent(id: string): MessageContent | null {
    const script = buildAppLevelScript(`
      try
        set msg to message id ${id}
        set msgSubject to subject of msg
        set msgContent to content of msg
        return msgSubject & "|||CONTENT|||" & msgContent
      on error errMsg
        return "ERROR:" & errMsg
      end try
    `);

    const result = executeAppleScript(script);

    if (!result.success || result.output.startsWith("ERROR:")) {
      console.error(`Failed to get message content: ${result.error || result.output}`);
      return null;
    }

    const parts = result.output.split("|||CONTENT|||");
    if (parts.length < 2) return null;

    return {
      id: id.toString(),
      subject: parts[0],
      plainText: parts[1],
    };
  }

  /**
   * List messages in a mailbox.
   *
   * @param mailbox - Mailbox to list from (default: INBOX)
   * @param account - Account to list from
   * @param limit - Maximum number of messages
   * @returns Array of messages
   */
  listMessages(mailbox?: string, account?: string, limit = 50): Message[] {
    const targetAccount = this.resolveAccount(account);
    const targetMailbox = mailbox || "INBOX";

    const listCommand = `
      set msgList to {}
      set theMailbox to mailbox "${escapeForAppleScript(targetMailbox)}"
      set msgCount to 0
      repeat with msg in messages of theMailbox
        if msgCount >= ${limit} then exit repeat
        try
          set msgId to id of msg
          set msgSubject to subject of msg
          set msgSender to sender of msg
          set msgDate to date received of msg
          set msgRead to read status of msg
          set msgFlagged to flagged status of msg
          set end of msgList to msgId & "|||" & msgSubject & "|||" & msgSender & "|||" & (msgDate as string) & "|||" & msgRead & "|||" & msgFlagged
          set msgCount to msgCount + 1
        end try
      end repeat
      set AppleScript's text item delimiters to "|||ITEM|||"
      return msgList as text
    `;

    const script = buildAccountScopedScript(targetAccount, listCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to list messages: ${result.error}`);
      return [];
    }

    if (!result.output.trim()) return [];

    return this.parseMessageList(result.output, targetMailbox, targetAccount);
  }

  /**
   * Parse message list output from AppleScript.
   */
  private parseMessageList(output: string, mailbox: string, account: string): Message[] {
    const items = output.split("|||ITEM|||");
    const messages: Message[] = [];

    for (const item of items) {
      const parts = item.split("|||");
      if (parts.length < 6) continue;

      messages.push({
        id: parts[0].trim(),
        subject: parts[1],
        sender: parts[2],
        recipients: [],
        dateReceived: parseAppleScriptDate(parts[3]),
        isRead: parts[4] === "true",
        isFlagged: parts[5] === "true",
        isJunk: false,
        isDeleted: false,
        mailbox,
        account,
        hasAttachments: false,
      });
    }

    return messages;
  }

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
  sendEmail(
    to: string[],
    subject: string,
    body: string,
    cc?: string[],
    bcc?: string[],
    account?: string
  ): boolean {
    const safeSubject = escapeForAppleScript(subject);
    const safeBody = escapeForAppleScript(body);

    // Build recipient additions
    let recipientCommands = "";
    for (const addr of to) {
      recipientCommands += `make new to recipient at end of to recipients with properties {address:"${escapeForAppleScript(addr)}"}\n`;
    }
    if (cc) {
      for (const addr of cc) {
        recipientCommands += `make new cc recipient at end of cc recipients with properties {address:"${escapeForAppleScript(addr)}"}\n`;
      }
    }
    if (bcc) {
      for (const addr of bcc) {
        recipientCommands += `make new bcc recipient at end of bcc recipients with properties {address:"${escapeForAppleScript(addr)}"}\n`;
      }
    }

    let sendCommand: string;
    if (account) {
      const safeAccount = escapeForAppleScript(account);
      sendCommand = `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:true}
        tell newMessage
          ${recipientCommands}
          set sender to "${safeAccount}"
        end tell
        send newMessage
        return "sent"
      `;
    } else {
      sendCommand = `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:true}
        tell newMessage
          ${recipientCommands}
        end tell
        send newMessage
        return "sent"
      `;
    }

    const script = buildAppLevelScript(sendCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to send email: ${result.error}`);
      return false;
    }

    return result.output.includes("sent");
  }

  /**
   * Mark a message as read.
   */
  markAsRead(id: string): boolean {
    const script = buildAppLevelScript(`
      try
        set read status of message id ${id} to true
        return "ok"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(script);

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to mark message as read: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Mark a message as unread.
   */
  markAsUnread(id: string): boolean {
    const script = buildAppLevelScript(`
      try
        set read status of message id ${id} to false
        return "ok"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(script);

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to mark message as unread: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Flag a message.
   */
  flagMessage(id: string): boolean {
    const script = buildAppLevelScript(`
      try
        set flagged status of message id ${id} to true
        return "ok"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(script);

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to flag message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Unflag a message.
   */
  unflagMessage(id: string): boolean {
    const script = buildAppLevelScript(`
      try
        set flagged status of message id ${id} to false
        return "ok"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(script);

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to unflag message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Delete a message.
   */
  deleteMessage(id: string): boolean {
    const script = buildAppLevelScript(`
      try
        delete message id ${id}
        return "ok"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(script);

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to delete message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Move a message to a different mailbox.
   */
  moveMessage(id: string, mailbox: string, account?: string): boolean {
    const targetAccount = this.resolveAccount(account);
    const safeMailbox = escapeForAppleScript(mailbox);
    const safeAccount = escapeForAppleScript(targetAccount);

    const script = buildAppLevelScript(`
      try
        set msg to message id ${id}
        set destMailbox to mailbox "${safeMailbox}" of account "${safeAccount}"
        move msg to destMailbox
        return "ok"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(script);

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to move message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * List attachments for a message.
   */
  listAttachments(id: string): Attachment[] {
    const script = buildAppLevelScript(`
      try
        set msg to message id ${id}
        set attachList to {}
        repeat with att in mail attachments of msg
          set attName to name of att
          set attType to MIME type of att
          set attSize to file size of att
          set end of attachList to attName & "|||" & attType & "|||" & attSize
        end repeat
        set AppleScript's text item delimiters to "|||ITEM|||"
        return attachList as text
      on error errMsg
        return ""
      end try
    `);

    const result = executeAppleScript(script);

    if (!result.success || !result.output.trim()) {
      return [];
    }

    const items = result.output.split("|||ITEM|||");
    const attachments: Attachment[] = [];

    for (const item of items) {
      const parts = item.split("|||");
      if (parts.length < 3) continue;

      attachments.push({
        id: `${id}-${parts[0]}`, // Composite ID
        name: parts[0],
        mimeType: parts[1],
        size: parseInt(parts[2]) || 0,
      });
    }

    return attachments;
  }

  // ===========================================================================
  // Mailbox Operations
  // ===========================================================================

  /**
   * List all mailboxes for an account.
   */
  listMailboxes(account?: string): Mailbox[] {
    const targetAccount = this.resolveAccount(account);

    const listCommand = `
      set mailboxList to {}
      repeat with mb in mailboxes
        set mbName to name of mb
        set mbUnread to unread count of mb
        set mbCount to count of messages of mb
        set end of mailboxList to mbName & "|||" & mbUnread & "|||" & mbCount
      end repeat
      set AppleScript's text item delimiters to "|||ITEM|||"
      return mailboxList as text
    `;

    const script = buildAccountScopedScript(targetAccount, listCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to list mailboxes: ${result.error}`);
      return [];
    }

    if (!result.output.trim()) return [];

    const items = result.output.split("|||ITEM|||");
    const mailboxes: Mailbox[] = [];

    for (const item of items) {
      const parts = item.split("|||");
      if (parts.length < 3) continue;

      mailboxes.push({
        name: parts[0],
        account: targetAccount,
        unreadCount: parseInt(parts[1]) || 0,
        messageCount: parseInt(parts[2]) || 0,
      });
    }

    return mailboxes;
  }

  /**
   * Get unread count for a mailbox.
   */
  getUnreadCount(mailbox?: string, account?: string): number {
    const targetAccount = this.resolveAccount(account);

    let command: string;
    if (mailbox) {
      const safeMailbox = escapeForAppleScript(mailbox);
      command = `return unread count of mailbox "${safeMailbox}"`;
    } else {
      // Get total unread across all mailboxes
      command = `
        set total to 0
        repeat with mb in mailboxes
          set total to total + (unread count of mb)
        end repeat
        return total
      `;
    }

    const script = buildAccountScopedScript(targetAccount, command);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to get unread count: ${result.error}`);
      return 0;
    }

    return parseInt(result.output) || 0;
  }

  // ===========================================================================
  // Account Operations
  // ===========================================================================

  /**
   * List all mail accounts.
   */
  listAccounts(): Account[] {
    const script = buildAppLevelScript(`
      set accountList to {}
      repeat with acct in accounts
        set acctName to name of acct
        set acctEmail to email addresses of acct
        set acctEnabled to enabled of acct
        set emailStr to ""
        if (count of acctEmail) > 0 then
          set emailStr to item 1 of acctEmail
        end if
        set end of accountList to acctName & "|||" & emailStr & "|||" & acctEnabled
      end repeat
      set AppleScript's text item delimiters to "|||ITEM|||"
      return accountList as text
    `);

    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to list accounts: ${result.error}`);
      return [];
    }

    if (!result.output.trim()) return [];

    const items = result.output.split("|||ITEM|||");
    const accounts: Account[] = [];

    for (const item of items) {
      const parts = item.split("|||");
      if (parts.length < 3) continue;

      accounts.push({
        name: parts[0],
        email: parts[1],
        enabled: parts[2] === "true",
      });
    }

    return accounts;
  }

  // ===========================================================================
  // Diagnostics
  // ===========================================================================

  /**
   * Run health check on Mail.app connectivity.
   */
  healthCheck(): HealthCheckResult {
    const checks: HealthCheckResult["checks"] = [];

    // Check 1: Mail.app is accessible
    const mailCheck = executeAppleScript('tell application "Mail" to return "ok"');
    if (mailCheck.success && mailCheck.output === "ok") {
      checks.push({
        name: "mail_app",
        passed: true,
        message: "Mail.app is accessible",
      });
    } else {
      const errorHint = mailCheck.error?.includes("not authorized")
        ? " (check Automation permissions in System Preferences)"
        : "";
      checks.push({
        name: "mail_app",
        passed: false,
        message: `Mail.app is not accessible${errorHint}`,
      });
      return { healthy: false, checks };
    }

    // Check 2: AppleScript permissions
    const permCheck = executeAppleScript('tell application "Mail" to get name of account 1');
    if (permCheck.success) {
      checks.push({
        name: "permissions",
        passed: true,
        message: "AppleScript automation permissions granted",
      });
    } else {
      const isPermError =
        permCheck.error?.includes("not authorized") || permCheck.error?.includes("not permitted");
      checks.push({
        name: "permissions",
        passed: !isPermError,
        message: isPermError
          ? "AppleScript permissions denied. Grant access in System Preferences > Privacy & Security > Automation"
          : `Permission check returned: ${permCheck.error}`,
      });
      if (isPermError) {
        return { healthy: false, checks };
      }
    }

    // Check 3: At least one account accessible
    const accounts = this.listAccounts();
    if (accounts.length > 0) {
      const accountNames = accounts.map((a) => a.name).join(", ");
      checks.push({
        name: "accounts",
        passed: true,
        message: `Found ${accounts.length} account(s): ${accountNames}`,
      });
    } else {
      checks.push({
        name: "accounts",
        passed: false,
        message: "No Mail accounts found. Set up an account in Mail.app first.",
      });
      return { healthy: false, checks };
    }

    // Check 4: Basic operations work
    const mailboxes = this.listMailboxes(accounts[0].name);
    checks.push({
      name: "operations",
      passed: true,
      message: `Basic operations working (${mailboxes.length} mailbox(es) in ${accounts[0].name})`,
    });

    return {
      healthy: checks.every((c) => c.passed),
      checks,
    };
  }

  /**
   * Get mail statistics.
   */
  getMailStats(): MailStats {
    const accounts = this.listAccounts();
    const accountStats: AccountStats[] = [];
    let totalMessages = 0;
    let totalUnread = 0;

    for (const account of accounts) {
      const mailboxes = this.listMailboxes(account.name);
      let accountMessages = 0;
      let accountUnread = 0;

      const mailboxStats = mailboxes.map((mb) => {
        accountMessages += mb.messageCount;
        accountUnread += mb.unreadCount;
        return {
          name: mb.name,
          messageCount: mb.messageCount,
          unreadCount: mb.unreadCount,
        };
      });

      totalMessages += accountMessages;
      totalUnread += accountUnread;

      accountStats.push({
        name: account.name,
        totalMessages: accountMessages,
        unreadMessages: accountUnread,
        mailboxCount: mailboxes.length,
        mailboxes: mailboxStats,
      });
    }

    return {
      totalMessages,
      totalUnread,
      accounts: accountStats,
    };
  }
}
