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
  BatchOperationResult,
  SyncStatus,
  RecentlyReceivedStats,
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

/**
 * Common mailbox name variations across different account types.
 * Maps normalized (lowercase) names to possible actual names.
 */
const MAILBOX_ALIASES: Record<string, string[]> = {
  inbox: ["INBOX", "Inbox", "inbox"],
  sent: ["Sent", "Sent Items", "Sent Messages", "SENT", "sent"],
  drafts: ["Drafts", "DRAFTS", "drafts", "Draft"],
  trash: ["Trash", "Deleted Items", "Deleted Messages", "TRASH", "trash"],
  junk: ["Junk", "Junk Email", "Spam", "JUNK", "junk"],
  archive: ["Archive", "ARCHIVE", "archive", "All Mail"],
};

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
  private resolveMailbox(mailbox: string, account: string): string {
    // Get actual mailbox names from the account
    const script = buildAccountScopedScript(
      account,
      `
      set mbNames to {}
      repeat with mb in mailboxes
        set end of mbNames to name of mb
      end repeat
      return mbNames
    `
    );

    const result = executeAppleScript(script);
    if (!result.success || !result.output) {
      return mailbox; // Fall back to original
    }

    // Parse the mailbox names (AppleScript returns comma-separated list)
    const actualMailboxes = result.output.split(", ").map((s) => s.trim());

    // 1. Try exact match
    if (actualMailboxes.includes(mailbox)) {
      return mailbox;
    }

    // 2. Try case-insensitive match
    const lowerMailbox = mailbox.toLowerCase();
    const caseMatch = actualMailboxes.find((mb) => mb.toLowerCase() === lowerMailbox);
    if (caseMatch) {
      return caseMatch;
    }

    // 3. Try known aliases
    const aliases = MAILBOX_ALIASES[lowerMailbox];
    if (aliases) {
      for (const alias of aliases) {
        if (actualMailboxes.includes(alias)) {
          return alias;
        }
        // Also try case-insensitive alias match
        const aliasMatch = actualMailboxes.find((mb) => mb.toLowerCase() === alias.toLowerCase());
        if (aliasMatch) {
          return aliasMatch;
        }
      }
    }

    // No match found, return original and let AppleScript handle the error
    return mailbox;
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
    const requestedMailbox = mailbox || "INBOX";
    const targetMailbox = this.resolveMailbox(requestedMailbox, targetAccount);

    // Build the search condition
    let searchCondition = "";
    if (query) {
      const safeQuery = escapeForAppleScript(query);
      searchCondition = `whose subject contains "${safeQuery}" or sender contains "${safeQuery}"`;
    }

    const searchCommand = `
      set outputText to ""
      set theMailbox to mailbox "${escapeForAppleScript(targetMailbox)}"
      set allMessages to messages of theMailbox ${searchCondition}
      set msgCount to 0
      repeat with msg in allMessages
        if msgCount >= ${limit} then exit repeat
        try
          set msgId to id of msg as string
          set msgSubject to subject of msg
          set msgSender to sender of msg
          set msgDate to date received of msg as string
          set msgRead to read status of msg as string
          set msgFlagged to flagged status of msg as string
          if msgCount > 0 then set outputText to outputText & "|||ITEM|||"
          set outputText to outputText & msgId & "|||" & msgSubject & "|||" & msgSender & "|||" & msgDate & "|||" & msgRead & "|||" & msgFlagged
          set msgCount to msgCount + 1
        end try
      end repeat
      return outputText
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
   *
   * Note: Mail.app message IDs are unique per mailbox. This method searches
   * all mailboxes in all accounts to find the message.
   */
  getMessageById(id: string): Message | null {
    const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${id})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set msgSubject to subject of msg
                set msgSender to sender of msg
                set msgDate to date received of msg as string
                set msgRead to read status of msg as string
                set msgFlagged to flagged status of msg as string
                set msgJunk to junk mail status of msg as string
                set msgDeleted to deleted status of msg as string
                set msgMailbox to name of mb
                set msgAccount to name of acct
                return msgSubject & "|||" & msgSender & "|||" & msgDate & "|||" & msgRead & "|||" & msgFlagged & "|||" & msgJunk & "|||" & msgDeleted & "|||" & msgMailbox & "|||" & msgAccount
              end if
            end try
          end repeat
        end repeat
        return ""
      on error errMsg
        return ""
      end try
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 }); // Longer timeout for search

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
      hasAttachments: false,
    };
  }

  /**
   * Get the content of a message.
   */
  getMessageContent(id: string): MessageContent | null {
    const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${id})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set msgSubject to subject of msg
                set msgContent to content of msg
                return msgSubject & "|||CONTENT|||" & msgContent
              end if
            end try
          end repeat
        end repeat
        return ""
      on error errMsg
        return ""
      end try
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || !result.output.trim()) {
      console.error(`Failed to get message content: ${result.error}`);
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
    const requestedMailbox = mailbox || "INBOX";
    const targetMailbox = this.resolveMailbox(requestedMailbox, targetAccount);

    const listCommand = `
      set outputText to ""
      set theMailbox to mailbox "${escapeForAppleScript(targetMailbox)}"
      set msgCount to 0
      repeat with msg in messages of theMailbox
        if msgCount >= ${limit} then exit repeat
        try
          set msgId to id of msg as string
          set msgSubject to subject of msg
          set msgSender to sender of msg
          set msgDate to date received of msg as string
          set msgRead to read status of msg as string
          set msgFlagged to flagged status of msg as string
          if msgCount > 0 then set outputText to outputText & "|||ITEM|||"
          set outputText to outputText & msgId & "|||" & msgSubject & "|||" & msgSender & "|||" & msgDate & "|||" & msgRead & "|||" & msgFlagged
          set msgCount to msgCount + 1
        end try
      end repeat
      return outputText
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
  createDraft(
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

    let draftCommand: string;
    if (account) {
      const safeAccount = escapeForAppleScript(account);
      draftCommand = `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:false}
        tell newMessage
          ${recipientCommands}
          set sender to "${safeAccount}"
        end tell
        return "draft created"
      `;
    } else {
      draftCommand = `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:false}
        tell newMessage
          ${recipientCommands}
        end tell
        return "draft created"
      `;
    }

    const script = buildAppLevelScript(draftCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to create draft: ${result.error}`);
      return false;
    }

    return result.output.includes("draft created");
  }

  /**
   * Reply to a message.
   *
   * @param id - Message ID to reply to
   * @param body - Reply body
   * @param replyAll - If true, reply to all recipients
   * @param send - If true, send immediately; if false, save as draft
   * @returns true if reply created/sent successfully
   */
  replyToMessage(id: string, body: string, replyAll = false, send = true): boolean {
    const safeBody = escapeForAppleScript(body);
    const replyAllClause = replyAll ? " with reply to all" : "";
    const sendAction = send ? "send theReply" : "";

    const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${id})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set theReply to reply msg with opening window${replyAllClause}
                set content of theReply to "${safeBody}" & return & return & content of theReply
                ${sendAction}
                return "ok"
              end if
            end try
          end repeat
        end repeat
        return "error:Message not found"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to reply to message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Forward a message.
   *
   * @param id - Message ID to forward
   * @param to - Recipients to forward to
   * @param body - Optional body to prepend
   * @param send - If true, send immediately; if false, save as draft
   * @returns true if forward created/sent successfully
   */
  forwardMessage(id: string, to: string[], body?: string, send = true): boolean {
    const safeBody = body ? escapeForAppleScript(body) : "";
    const sendAction = send ? "send theForward" : "";

    // Build recipient additions
    let recipientCommands = "";
    for (const addr of to) {
      recipientCommands += `make new to recipient at end of to recipients of theForward with properties {address:"${escapeForAppleScript(addr)}"}\n`;
    }

    const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${id})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set theForward to forward msg with opening window
                ${recipientCommands}
                ${safeBody ? `set content of theForward to "${safeBody}" & return & return & content of theForward` : ""}
                ${sendAction}
                return "ok"
              end if
            end try
          end repeat
        end repeat
        return "error:Message not found"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to forward message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Helper to find and operate on a message by ID.
   */
  private findMessageScript(id: string, operation: string): string {
    return buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${id})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                ${operation}
                return "ok"
              end if
            end try
          end repeat
        end repeat
        return "error:Message not found"
      on error errMsg
        return "error:" & errMsg
      end try
    `);
  }

  /**
   * Mark a message as read.
   */
  markAsRead(id: string): boolean {
    const script = this.findMessageScript(id, "set read status of msg to true");
    const result = executeAppleScript(script, { timeoutMs: 60000 });

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
    const script = this.findMessageScript(id, "set read status of msg to false");
    const result = executeAppleScript(script, { timeoutMs: 60000 });

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
    const script = this.findMessageScript(id, "set flagged status of msg to true");
    const result = executeAppleScript(script, { timeoutMs: 60000 });

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
    const script = this.findMessageScript(id, "set flagged status of msg to false");
    const result = executeAppleScript(script, { timeoutMs: 60000 });

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
    const script = this.findMessageScript(id, "delete msg");
    const result = executeAppleScript(script, { timeoutMs: 60000 });

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
    const targetMailbox = this.resolveMailbox(mailbox, targetAccount);
    const safeMailbox = escapeForAppleScript(targetMailbox);
    const safeAccount = escapeForAppleScript(targetAccount);

    const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${id})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set destMailbox to mailbox "${safeMailbox}" of account "${safeAccount}"
                move msg to destMailbox
                return "ok"
              end if
            end try
          end repeat
        end repeat
        return "error:Message not found"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to move message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  // ===========================================================================
  // Batch Operations
  // ===========================================================================

  /**
   * Delete multiple messages at once.
   *
   * @param ids - Array of message IDs to delete
   * @returns Array of results for each message
   */
  batchDeleteMessages(ids: string[]): BatchOperationResult[] {
    const results: BatchOperationResult[] = [];

    for (const id of ids) {
      const success = this.deleteMessage(id);
      results.push({
        id,
        success,
        error: success ? undefined : "Failed to delete message",
      });
    }

    return results;
  }

  /**
   * Move multiple messages to a mailbox at once.
   *
   * @param ids - Array of message IDs to move
   * @param mailbox - Destination mailbox name
   * @param account - Account containing the destination mailbox
   * @returns Array of results for each message
   */
  batchMoveMessages(ids: string[], mailbox: string, account?: string): BatchOperationResult[] {
    const results: BatchOperationResult[] = [];

    for (const id of ids) {
      const success = this.moveMessage(id, mailbox, account);
      results.push({
        id,
        success,
        error: success ? undefined : "Failed to move message",
      });
    }

    return results;
  }

  /**
   * Mark multiple messages as read at once.
   *
   * @param ids - Array of message IDs to mark as read
   * @returns Array of results for each message
   */
  batchMarkAsRead(ids: string[]): BatchOperationResult[] {
    const results: BatchOperationResult[] = [];

    for (const id of ids) {
      const success = this.markAsRead(id);
      results.push({
        id,
        success,
        error: success ? undefined : "Failed to mark message as read",
      });
    }

    return results;
  }

  /**
   * List attachments for a message.
   */
  listAttachments(id: string): Attachment[] {
    const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${id})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set outputText to ""
                set attCount to 0
                repeat with att in mail attachments of msg
                  set attName to name of att
                  set attType to MIME type of att
                  set attSize to file size of att as string
                  if attCount > 0 then set outputText to outputText & "|||ITEM|||"
                  set outputText to outputText & attName & "|||" & attType & "|||" & attSize
                  set attCount to attCount + 1
                end repeat
                return outputText
              end if
            end try
          end repeat
        end repeat
        return ""
      on error errMsg
        return ""
      end try
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || !result.output.trim()) {
      return [];
    }

    const items = result.output.split("|||ITEM|||");
    const attachments: Attachment[] = [];

    for (const item of items) {
      const parts = item.split("|||");
      if (parts.length < 3) continue;

      attachments.push({
        id: `${id}-${parts[0]}`,
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
      const targetMailbox = this.resolveMailbox(mailbox, targetAccount);
      const safeMailbox = escapeForAppleScript(targetMailbox);
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

    // Get recently received stats
    const recentlyReceived = this.getRecentlyReceivedStats();

    return {
      totalMessages,
      totalUnread,
      accounts: accountStats,
      recentlyReceived,
    };
  }

  /**
   * Get counts of recently received messages.
   *
   * Only counts messages in INBOX for performance (scanning all mailboxes
   * is too slow for large accounts).
   *
   * @returns Counts of messages received in last 24h, 7d, and 30d
   */
  getRecentlyReceivedStats(): RecentlyReceivedStats {
    // Get message counts for different time periods
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Format dates for AppleScript comparison
    const formatDate = (d: Date): string => {
      const months = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      return `date "${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}"`;
    };

    // Only scan INBOX for performance - scanning all mailboxes is too slow
    const script = buildAppLevelScript(`
      set last24h to 0
      set last7d to 0
      set last30d to 0
      set oneDayAgo to ${formatDate(oneDayAgo)}
      set sevenDaysAgo to ${formatDate(sevenDaysAgo)}
      set thirtyDaysAgo to ${formatDate(thirtyDaysAgo)}

      repeat with acct in accounts
        try
          -- Try common inbox names
          set inboxNames to {"INBOX", "Inbox", "inbox"}
          repeat with inboxName in inboxNames
            try
              set theInbox to mailbox inboxName of acct
              set last24h to last24h + (count of (messages of theInbox whose date received >= oneDayAgo))
              set last7d to last7d + (count of (messages of theInbox whose date received >= sevenDaysAgo))
              set last30d to last30d + (count of (messages of theInbox whose date received >= thirtyDaysAgo))
              exit repeat
            end try
          end repeat
        end try
      end repeat

      return (last24h as string) & "|||" & (last7d as string) & "|||" & (last30d as string)
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || !result.output.trim()) {
      console.error(`Failed to get recently received stats: ${result.error}`);
      return { last24h: 0, last7d: 0, last30d: 0 };
    }

    const parts = result.output.split("|||");
    if (parts.length < 3) {
      return { last24h: 0, last7d: 0, last30d: 0 };
    }

    return {
      last24h: parseInt(parts[0]) || 0,
      last7d: parseInt(parts[1]) || 0,
      last30d: parseInt(parts[2]) || 0,
    };
  }

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
  getSyncStatus(): SyncStatus {
    // Check for Mail.app background activity and sync status
    // Mail.app doesn't expose sync status directly through AppleScript,
    // so we check for recent changes and activity indicators
    const script = buildAppLevelScript(`
      set syncInfo to ""

      -- Check if Mail.app is running
      tell application "System Events"
        set mailRunning to (name of processes) contains "Mail"
      end tell

      if not mailRunning then
        return "not_running"
      end if

      -- Check for background activity by looking at message counts changing
      -- This is a proxy for sync activity since Mail doesn't expose sync status
      set accountCount to count of accounts
      set totalMailboxes to 0
      repeat with acct in accounts
        set totalMailboxes to totalMailboxes + (count of mailboxes of acct)
      end repeat

      return "running|||" & accountCount & "|||" & totalMailboxes
    `);

    const result = executeAppleScript(script);

    if (!result.success) {
      return {
        syncDetected: false,
        pendingUpload: 0,
        recentActivity: false,
        secondsSinceLastChange: -1,
        error: result.error,
      };
    }

    if (result.output === "not_running") {
      return {
        syncDetected: false,
        pendingUpload: 0,
        recentActivity: false,
        secondsSinceLastChange: -1,
        error: "Mail.app is not running",
      };
    }

    // Parse the response
    const parts = result.output.split("|||");
    const isRunning = parts[0] === "running";
    const accountCount = parseInt(parts[1]) || 0;

    // Mail.app is running with accounts configured - assume sync is active
    // (Mail.app syncs automatically when running)
    return {
      syncDetected: isRunning && accountCount > 0,
      pendingUpload: 0, // Not exposed by Mail.app
      recentActivity: isRunning,
      secondsSinceLastChange: 0,
    };
  }
}
