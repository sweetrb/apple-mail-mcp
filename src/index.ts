#!/usr/bin/env node
/**
 * Apple Mail MCP Server
 *
 * A Model Context Protocol (MCP) server that provides AI assistants
 * with the ability to interact with Apple Mail on macOS.
 *
 * This server exposes tools for:
 * - Reading and searching emails
 * - Sending emails
 * - Managing mailboxes
 * - Managing multiple accounts (iCloud, Gmail, Exchange, etc.)
 *
 * Architecture:
 * - Tool definitions are declarative (schema + handler)
 * - The AppleMailManager class handles all AppleScript operations
 * - Error handling is consistent across all tools
 *
 * @module apple-mail-mcp
 * @see https://modelcontextprotocol.io
 */

import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AppleMailManager } from "@/services/appleMailManager.js";

// Read version from package.json to keep it in sync
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

// =============================================================================
// Server Initialization
// =============================================================================

/**
 * MCP server instance configured for Apple Mail operations.
 */
const server = new McpServer({
  name: "apple-mail",
  version,
  description: "MCP server for managing Apple Mail - read, search, send, and organize emails",
});

/**
 * Singleton instance of the Apple Mail manager.
 * Handles all AppleScript execution and mail operations.
 */
const mailManager = new AppleMailManager();

// =============================================================================
// Response Helpers
// =============================================================================

/**
 * Creates a successful MCP tool response.
 */
function successResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
  };
}

/**
 * Creates an error MCP tool response.
 */
function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/**
 * Wraps a tool handler with consistent error handling.
 */
function withErrorHandling<T extends Record<string, unknown>>(
  handler: (params: T) => ReturnType<typeof successResponse>,
  errorPrefix: string
) {
  return async (params: T) => {
    try {
      return handler(params);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(`${errorPrefix}: ${message}`);
    }
  };
}

// =============================================================================
// Message Tools
// =============================================================================

// --- search-messages ---

server.tool(
  "search-messages",
  {
    query: z.string().optional().describe("Text to search for in subject, sender, or content"),
    from: z.string().optional().describe("Filter by sender email address"),
    subject: z.string().optional().describe("Filter by subject line"),
    mailbox: z.string().optional().describe("Mailbox to search in (e.g., 'INBOX')"),
    account: z.string().optional().describe("Account to search in"),
    isRead: z.boolean().optional().describe("Filter by read status"),
    isFlagged: z.boolean().optional().describe("Filter by flagged status"),
    limit: z.number().optional().describe("Maximum number of results (default: 50)"),
  },
  withErrorHandling(({ query, mailbox, account, limit = 50 }) => {
    const messages = mailManager.searchMessages(query, mailbox, account, limit);

    if (messages.length === 0) {
      return successResponse("No messages found matching criteria");
    }

    const messageList = messages
      .map((m) => `  - ${m.subject} (from: ${m.sender}) [${m.isRead ? "read" : "unread"}]`)
      .join("\n");

    return successResponse(`Found ${messages.length} message(s):\n${messageList}`);
  }, "Error searching messages")
);

// --- get-message ---

server.tool(
  "get-message",
  {
    id: z.string().min(1, "Message ID is required"),
  },
  withErrorHandling(({ id }) => {
    const content = mailManager.getMessageContent(id);

    if (!content) {
      return errorResponse(`Message with ID "${id}" not found`);
    }

    return successResponse(`Subject: ${content.subject}\n\n${content.plainText}`);
  }, "Error retrieving message")
);

// --- list-messages ---

server.tool(
  "list-messages",
  {
    mailbox: z.string().optional().describe("Mailbox to list messages from (default: INBOX)"),
    account: z.string().optional().describe("Account to list messages from"),
    limit: z.number().optional().describe("Maximum number of messages (default: 50)"),
    unreadOnly: z.boolean().optional().describe("Only show unread messages"),
  },
  withErrorHandling(({ mailbox, account, limit = 50 }) => {
    const messages = mailManager.listMessages(mailbox, account, limit);

    if (messages.length === 0) {
      return successResponse("No messages found");
    }

    const messageList = messages.map((m) => `  - ${m.subject} (from: ${m.sender})`).join("\n");

    return successResponse(`Found ${messages.length} message(s):\n${messageList}`);
  }, "Error listing messages")
);

// --- send-email ---

server.tool(
  "send-email",
  {
    to: z.array(z.string()).min(1, "At least one recipient is required"),
    subject: z.string().min(1, "Subject is required"),
    body: z.string().min(1, "Body is required"),
    cc: z.array(z.string()).optional().describe("CC recipients"),
    bcc: z.array(z.string()).optional().describe("BCC recipients"),
    account: z.string().optional().describe("Account to send from"),
  },
  withErrorHandling(({ to, subject, body, cc, bcc, account }) => {
    const success = mailManager.sendEmail(to, subject, body, cc, bcc, account);

    if (!success) {
      return errorResponse("Failed to send email. Check Mail.app configuration.");
    }

    return successResponse(`Email sent to ${to.join(", ")}`);
  }, "Error sending email")
);

// --- create-draft ---

server.tool(
  "create-draft",
  {
    to: z.array(z.string()).min(1, "At least one recipient is required"),
    subject: z.string().min(1, "Subject is required"),
    body: z.string().min(1, "Body is required"),
    cc: z.array(z.string()).optional().describe("CC recipients"),
    bcc: z.array(z.string()).optional().describe("BCC recipients"),
    account: z.string().optional().describe("Account to create draft in"),
  },
  withErrorHandling(({ to, subject, body, cc, bcc, account }) => {
    const success = mailManager.createDraft(to, subject, body, cc, bcc, account);

    if (!success) {
      return errorResponse("Failed to create draft. Check Mail.app configuration.");
    }

    return successResponse(`Draft created for ${to.join(", ")}`);
  }, "Error creating draft")
);

// --- reply-to-message ---

server.tool(
  "reply-to-message",
  {
    id: z.string().min(1, "Message ID is required"),
    body: z.string().min(1, "Reply body is required"),
    replyAll: z.boolean().optional().default(false).describe("Reply to all recipients"),
    send: z.boolean().optional().default(true).describe("Send immediately (false = save as draft)"),
  },
  withErrorHandling(({ id, body, replyAll, send }) => {
    const success = mailManager.replyToMessage(id, body, replyAll, send);

    if (!success) {
      return errorResponse(`Failed to reply to message "${id}"`);
    }

    return successResponse(send ? "Reply sent" : "Reply saved as draft");
  }, "Error replying to message")
);

// --- forward-message ---

server.tool(
  "forward-message",
  {
    id: z.string().min(1, "Message ID is required"),
    to: z.array(z.string()).min(1, "At least one recipient is required"),
    body: z.string().optional().describe("Optional message to prepend"),
    send: z.boolean().optional().default(true).describe("Send immediately (false = save as draft)"),
  },
  withErrorHandling(({ id, to, body, send }) => {
    const success = mailManager.forwardMessage(id, to, body, send);

    if (!success) {
      return errorResponse(`Failed to forward message "${id}"`);
    }

    return successResponse(
      send ? `Message forwarded to ${to.join(", ")}` : "Forward saved as draft"
    );
  }, "Error forwarding message")
);

// --- mark-as-read ---

server.tool(
  "mark-as-read",
  {
    id: z.string().min(1, "Message ID is required"),
  },
  withErrorHandling(({ id }) => {
    const success = mailManager.markAsRead(id);

    if (!success) {
      return errorResponse(`Failed to mark message "${id}" as read`);
    }

    return successResponse("Message marked as read");
  }, "Error marking message as read")
);

// --- mark-as-unread ---

server.tool(
  "mark-as-unread",
  {
    id: z.string().min(1, "Message ID is required"),
  },
  withErrorHandling(({ id }) => {
    const success = mailManager.markAsUnread(id);

    if (!success) {
      return errorResponse(`Failed to mark message "${id}" as unread`);
    }

    return successResponse("Message marked as unread");
  }, "Error marking message as unread")
);

// --- flag-message ---

server.tool(
  "flag-message",
  {
    id: z.string().min(1, "Message ID is required"),
  },
  withErrorHandling(({ id }) => {
    const success = mailManager.flagMessage(id);

    if (!success) {
      return errorResponse(`Failed to flag message "${id}"`);
    }

    return successResponse("Message flagged");
  }, "Error flagging message")
);

// --- delete-message ---

server.tool(
  "delete-message",
  {
    id: z.string().min(1, "Message ID is required"),
  },
  withErrorHandling(({ id }) => {
    const success = mailManager.deleteMessage(id);

    if (!success) {
      return errorResponse(`Failed to delete message "${id}"`);
    }

    return successResponse("Message deleted");
  }, "Error deleting message")
);

// --- move-message ---

server.tool(
  "move-message",
  {
    id: z.string().min(1, "Message ID is required"),
    mailbox: z.string().min(1, "Destination mailbox is required"),
    account: z.string().optional().describe("Account containing the destination mailbox"),
  },
  withErrorHandling(({ id, mailbox, account }) => {
    const success = mailManager.moveMessage(id, mailbox, account);

    if (!success) {
      return errorResponse(`Failed to move message to "${mailbox}"`);
    }

    return successResponse(`Message moved to "${mailbox}"`);
  }, "Error moving message")
);

// =============================================================================
// Mailbox Tools
// =============================================================================

// --- list-mailboxes ---

server.tool(
  "list-mailboxes",
  {
    account: z.string().optional().describe("Account to list mailboxes from"),
  },
  withErrorHandling(({ account }) => {
    const mailboxes = mailManager.listMailboxes(account);

    if (mailboxes.length === 0) {
      return successResponse("No mailboxes found");
    }

    const mailboxList = mailboxes.map((m) => `  - ${m.name} (${m.unreadCount} unread)`).join("\n");

    return successResponse(`Found ${mailboxes.length} mailbox(es):\n${mailboxList}`);
  }, "Error listing mailboxes")
);

// --- get-unread-count ---

server.tool(
  "get-unread-count",
  {
    mailbox: z.string().optional().describe("Mailbox to check (default: all)"),
    account: z.string().optional().describe("Account to check"),
  },
  withErrorHandling(({ mailbox, account }) => {
    const count = mailManager.getUnreadCount(mailbox, account);
    const location = mailbox ? ` in "${mailbox}"` : "";

    return successResponse(`${count} unread message(s)${location}`);
  }, "Error getting unread count")
);

// =============================================================================
// Account Tools
// =============================================================================

// --- list-accounts ---

server.tool(
  "list-accounts",
  {},
  withErrorHandling(() => {
    const accounts = mailManager.listAccounts();

    if (accounts.length === 0) {
      return successResponse("No Mail accounts found");
    }

    const accountList = accounts.map((a) => `  - ${a.name}`).join("\n");
    return successResponse(`Found ${accounts.length} account(s):\n${accountList}`);
  }, "Error listing accounts")
);

// =============================================================================
// Diagnostics Tools
// =============================================================================

// --- health-check ---

server.tool(
  "health-check",
  {},
  withErrorHandling(() => {
    const result = mailManager.healthCheck();

    const statusIcon = result.healthy ? "✓" : "✗";
    const statusText = result.healthy ? "All checks passed" : "Issues detected";

    const checkLines = result.checks
      .map((c) => {
        const icon = c.passed ? "✓" : "✗";
        return `  ${icon} ${c.name}: ${c.message}`;
      })
      .join("\n");

    return successResponse(`${statusIcon} ${statusText}\n\n${checkLines}`);
  }, "Error running health check")
);

// --- get-mail-stats ---

server.tool(
  "get-mail-stats",
  {},
  withErrorHandling(() => {
    const stats = mailManager.getMailStats();

    const lines: string[] = [];
    lines.push(`📊 Mail Statistics`);
    lines.push(`══════════════════`);
    lines.push(`Total messages: ${stats.totalMessages}`);
    lines.push(`Unread messages: ${stats.totalUnread}`);
    lines.push(``);

    if (stats.accounts.length > 0) {
      lines.push(`📁 By Account:`);
      for (const account of stats.accounts) {
        lines.push(
          `  ${account.name}: ${account.totalMessages} messages (${account.unreadMessages} unread)`
        );
      }
    }

    return successResponse(lines.join("\n"));
  }, "Error getting mail statistics")
);

// =============================================================================
// Server Startup
// =============================================================================

/**
 * Initialize and start the MCP server.
 */
const transport = new StdioServerTransport();
await server.connect(transport);
