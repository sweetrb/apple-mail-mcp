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
    account: z.string().optional().describe("Account to search in (omit to search all accounts)"),
    isRead: z.boolean().optional().describe("Filter by read status"),
    isFlagged: z.boolean().optional().describe("Filter by flagged status"),
    dateFrom: z.string().optional().describe("Start date filter (e.g., 'January 1, 2026')"),
    dateTo: z.string().optional().describe("End date filter (e.g., 'March 1, 2026')"),
    limit: z.number().optional().describe("Maximum number of results (default: 50)"),
  },
  withErrorHandling(({ query, mailbox, account, limit = 50, dateFrom, dateTo }) => {
    const messages = mailManager.searchMessages(query, mailbox, account, limit, dateFrom, dateTo);

    if (messages.length === 0) {
      return successResponse("No messages found matching criteria");
    }

    const messageList = messages
      .map(
        (m) =>
          `  - ID: ${m.id} | ${m.dateReceived.toLocaleDateString()} | ${m.subject} (from: ${m.sender}) [${m.isRead ? "read" : "unread"}]`
      )
      .join("\n");

    return successResponse(`Found ${messages.length} message(s):\n${messageList}`);
  }, "Error searching messages")
);

// --- get-message ---

server.tool(
  "get-message",
  {
    id: z.string().min(1, "Message ID is required"),
    preferHtml: z.boolean().optional().describe("Return HTML source instead of plain text"),
  },
  withErrorHandling(({ id, preferHtml }) => {
    const content = mailManager.getMessageContent(id);

    if (!content) {
      return errorResponse(`Message with ID "${id}" not found`);
    }

    if (preferHtml && content.htmlContent) {
      return successResponse(`Subject: ${content.subject}\n\n${content.htmlContent}`);
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
    offset: z.number().optional().describe("Number of messages to skip (for pagination)"),
    from: z.string().optional().describe("Filter by sender email address or name"),
    unreadOnly: z.boolean().optional().describe("Only show unread messages"),
  },
  withErrorHandling(({ mailbox, account, limit = 50, offset = 0, from }) => {
    const messages = mailManager.listMessages(mailbox, account, limit, from, offset);

    if (messages.length === 0) {
      return successResponse("No messages found");
    }

    const messageList = messages
      .map(
        (m) =>
          `  - ID: ${m.id} | ${m.dateReceived.toLocaleDateString()} | ${m.subject} (from: ${m.sender})`
      )
      .join("\n");

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
    attachments: z
      .array(z.string())
      .optional()
      .describe("Absolute file paths to attach (e.g., ['/Users/me/report.pdf'])"),
  },
  withErrorHandling(({ to, subject, body, cc, bcc, account, attachments }) => {
    const success = mailManager.sendEmail(to, subject, body, cc, bcc, account, attachments);

    if (!success) {
      return errorResponse("Failed to send email. Check Mail.app configuration.");
    }

    const attachInfo = attachments?.length ? ` with ${attachments.length} attachment(s)` : "";
    return successResponse(`Email sent to ${to.join(", ")}${attachInfo}`);
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
    attachments: z
      .array(z.string())
      .optional()
      .describe("Absolute file paths to attach (e.g., ['/Users/me/report.pdf'])"),
  },
  withErrorHandling(({ to, subject, body, cc, bcc, account, attachments }) => {
    const success = mailManager.createDraft(to, subject, body, cc, bcc, account, attachments);

    if (!success) {
      return errorResponse("Failed to create draft. Check Mail.app configuration.");
    }

    const attachInfo = attachments?.length ? ` with ${attachments.length} attachment(s)` : "";
    return successResponse(`Draft created for ${to.join(", ")}${attachInfo}`);
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

// --- unflag-message ---

server.tool(
  "unflag-message",
  {
    id: z.string().min(1, "Message ID is required"),
  },
  withErrorHandling(({ id }) => {
    const success = mailManager.unflagMessage(id);

    if (!success) {
      return errorResponse(`Failed to unflag message "${id}"`);
    }

    return successResponse("Message unflagged");
  }, "Error unflagging message")
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

// --- batch-delete-messages ---

server.tool(
  "batch-delete-messages",
  {
    ids: z.array(z.string()).min(1, "At least one message ID is required"),
  },
  withErrorHandling(({ ids }) => {
    const results = mailManager.batchDeleteMessages(ids);
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    if (failCount === 0) {
      return successResponse(`Successfully deleted ${successCount} message(s)`);
    } else if (successCount === 0) {
      return errorResponse(`Failed to delete all ${failCount} message(s)`);
    } else {
      return successResponse(`Deleted ${successCount} message(s), ${failCount} failed`);
    }
  }, "Error batch deleting messages")
);

// --- batch-move-messages ---

server.tool(
  "batch-move-messages",
  {
    ids: z.array(z.string()).min(1, "At least one message ID is required"),
    mailbox: z.string().min(1, "Destination mailbox is required"),
    account: z.string().optional().describe("Account containing the destination mailbox"),
  },
  withErrorHandling(({ ids, mailbox, account }) => {
    const results = mailManager.batchMoveMessages(ids, mailbox, account);
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    if (failCount === 0) {
      return successResponse(`Successfully moved ${successCount} message(s) to "${mailbox}"`);
    } else if (successCount === 0) {
      return errorResponse(`Failed to move all ${failCount} message(s)`);
    } else {
      return successResponse(
        `Moved ${successCount} message(s) to "${mailbox}", ${failCount} failed`
      );
    }
  }, "Error batch moving messages")
);

// --- batch-mark-as-read ---

server.tool(
  "batch-mark-as-read",
  {
    ids: z.array(z.string()).min(1, "At least one message ID is required"),
  },
  withErrorHandling(({ ids }) => {
    const results = mailManager.batchMarkAsRead(ids);
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    if (failCount === 0) {
      return successResponse(`Successfully marked ${successCount} message(s) as read`);
    } else if (successCount === 0) {
      return errorResponse(`Failed to mark all ${failCount} message(s) as read`);
    } else {
      return successResponse(`Marked ${successCount} message(s) as read, ${failCount} failed`);
    }
  }, "Error batch marking messages as read")
);

// --- batch-mark-as-unread ---

server.tool(
  "batch-mark-as-unread",
  {
    ids: z.array(z.string()).min(1, "At least one message ID is required"),
  },
  withErrorHandling(({ ids }) => {
    const results = mailManager.batchMarkAsUnread(ids);
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    if (failCount === 0) {
      return successResponse(`Successfully marked ${successCount} message(s) as unread`);
    } else if (successCount === 0) {
      return errorResponse(`Failed to mark all ${failCount} message(s) as unread`);
    } else {
      return successResponse(`Marked ${successCount} message(s) as unread, ${failCount} failed`);
    }
  }, "Error batch marking messages as unread")
);

// --- batch-flag-messages ---

server.tool(
  "batch-flag-messages",
  {
    ids: z.array(z.string()).min(1, "At least one message ID is required"),
  },
  withErrorHandling(({ ids }) => {
    const results = mailManager.batchFlagMessages(ids);
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    if (failCount === 0) {
      return successResponse(`Successfully flagged ${successCount} message(s)`);
    } else if (successCount === 0) {
      return errorResponse(`Failed to flag all ${failCount} message(s)`);
    } else {
      return successResponse(`Flagged ${successCount} message(s), ${failCount} failed`);
    }
  }, "Error batch flagging messages")
);

// --- batch-unflag-messages ---

server.tool(
  "batch-unflag-messages",
  {
    ids: z.array(z.string()).min(1, "At least one message ID is required"),
  },
  withErrorHandling(({ ids }) => {
    const results = mailManager.batchUnflagMessages(ids);
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    if (failCount === 0) {
      return successResponse(`Successfully unflagged ${successCount} message(s)`);
    } else if (successCount === 0) {
      return errorResponse(`Failed to unflag all ${failCount} message(s)`);
    } else {
      return successResponse(`Unflagged ${successCount} message(s), ${failCount} failed`);
    }
  }, "Error batch unflagging messages")
);

// --- list-attachments ---

server.tool(
  "list-attachments",
  {
    id: z.string().min(1, "Message ID is required"),
  },
  withErrorHandling(({ id }) => {
    const attachments = mailManager.listAttachments(id);

    if (attachments.length === 0) {
      return successResponse("No attachments found");
    }

    const attachmentList = attachments
      .map((a) => {
        const sizeKb = Math.round(a.size / 1024);
        return `  - ${a.name} (${a.mimeType}, ${sizeKb} KB)`;
      })
      .join("\n");

    return successResponse(`Found ${attachments.length} attachment(s):\n${attachmentList}`);
  }, "Error listing attachments")
);

// --- save-attachment ---

server.tool(
  "save-attachment",
  {
    id: z.string().min(1, "Message ID is required"),
    attachmentName: z.string().min(1, "Attachment name is required"),
    savePath: z.string().min(1, "Save directory path is required"),
  },
  withErrorHandling(({ id, attachmentName, savePath }) => {
    const success = mailManager.saveAttachment(id, attachmentName, savePath);

    if (!success) {
      return errorResponse(`Failed to save attachment "${attachmentName}"`);
    }

    return successResponse(`Attachment "${attachmentName}" saved to ${savePath}`);
  }, "Error saving attachment")
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

// --- create-mailbox ---

server.tool(
  "create-mailbox",
  {
    name: z.string().min(1, "Mailbox name is required"),
    account: z.string().optional().describe("Account to create the mailbox in"),
  },
  withErrorHandling(({ name, account }) => {
    const success = mailManager.createMailbox(name, account);

    if (!success) {
      return errorResponse(`Failed to create mailbox "${name}"`);
    }

    return successResponse(`Mailbox "${name}" created`);
  }, "Error creating mailbox")
);

// --- delete-mailbox ---

server.tool(
  "delete-mailbox",
  {
    name: z.string().min(1, "Mailbox name is required"),
    account: z.string().optional().describe("Account containing the mailbox"),
  },
  withErrorHandling(({ name, account }) => {
    const success = mailManager.deleteMailbox(name, account);

    if (!success) {
      return errorResponse(`Failed to delete mailbox "${name}"`);
    }

    return successResponse(`Mailbox "${name}" deleted`);
  }, "Error deleting mailbox")
);

// --- rename-mailbox ---

server.tool(
  "rename-mailbox",
  {
    oldName: z.string().min(1, "Current mailbox name is required"),
    newName: z.string().min(1, "New mailbox name is required"),
    account: z.string().optional().describe("Account containing the mailbox"),
  },
  withErrorHandling(({ oldName, newName, account }) => {
    const success = mailManager.renameMailbox(oldName, newName, account);

    if (!success) {
      return errorResponse(`Failed to rename mailbox "${oldName}" to "${newName}"`);
    }

    return successResponse(`Mailbox renamed from "${oldName}" to "${newName}"`);
  }, "Error renaming mailbox")
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
// Mail Rules Tools
// =============================================================================

// --- list-rules ---

server.tool(
  "list-rules",
  {},
  withErrorHandling(() => {
    const rules = mailManager.listRules();

    if (rules.length === 0) {
      return successResponse("No mail rules found");
    }

    const ruleList = rules
      .map((r) => `  - ${r.name} [${r.enabled ? "enabled" : "disabled"}]`)
      .join("\n");

    return successResponse(`Found ${rules.length} rule(s):\n${ruleList}`);
  }, "Error listing rules")
);

// --- enable-rule ---

server.tool(
  "enable-rule",
  {
    name: z.string().min(1, "Rule name is required"),
  },
  withErrorHandling(({ name }) => {
    const success = mailManager.setRuleEnabled(name, true);

    if (!success) {
      return errorResponse(`Failed to enable rule "${name}"`);
    }

    return successResponse(`Rule "${name}" enabled`);
  }, "Error enabling rule")
);

// --- disable-rule ---

server.tool(
  "disable-rule",
  {
    name: z.string().min(1, "Rule name is required"),
  },
  withErrorHandling(({ name }) => {
    const success = mailManager.setRuleEnabled(name, false);

    if (!success) {
      return errorResponse(`Failed to disable rule "${name}"`);
    }

    return successResponse(`Rule "${name}" disabled`);
  }, "Error disabling rule")
);

// =============================================================================
// Contacts Tools
// =============================================================================

// --- search-contacts ---

server.tool(
  "search-contacts",
  {
    query: z.string().min(1, "Search query is required"),
  },
  withErrorHandling(({ query }) => {
    const contacts = mailManager.searchContacts(query);

    if (contacts.length === 0) {
      return successResponse("No contacts found");
    }

    const contactList = contacts
      .map((c) => {
        const emails = c.emails.length > 0 ? c.emails.join(", ") : "no email";
        return `  - ${c.name} (${emails})`;
      })
      .join("\n");

    return successResponse(`Found ${contacts.length} contact(s):\n${contactList}`);
  }, "Error searching contacts")
);

// =============================================================================
// Email Template Tools
// =============================================================================

// --- save-template ---

server.tool(
  "save-template",
  {
    name: z.string().min(1, "Template name is required"),
    subject: z.string().min(1, "Subject is required"),
    body: z.string().min(1, "Body is required"),
    to: z.array(z.string()).optional().describe("Default recipients"),
    cc: z.array(z.string()).optional().describe("Default CC recipients"),
    id: z.string().optional().describe("Template ID (for updating existing template)"),
  },
  withErrorHandling(({ name, subject, body, to, cc, id }) => {
    const template = mailManager.saveTemplate(name, subject, body, to, cc, id);

    return successResponse(`Template "${template.name}" saved with ID: ${template.id}`);
  }, "Error saving template")
);

// --- list-templates ---

server.tool(
  "list-templates",
  {},
  withErrorHandling(() => {
    const templates = mailManager.listTemplates();

    if (templates.length === 0) {
      return successResponse("No templates saved");
    }

    const templateList = templates
      .map((t) => `  - [${t.id}] ${t.name} — "${t.subject}"`)
      .join("\n");

    return successResponse(`Found ${templates.length} template(s):\n${templateList}`);
  }, "Error listing templates")
);

// --- get-template ---

server.tool(
  "get-template",
  {
    id: z.string().min(1, "Template ID is required"),
  },
  withErrorHandling(({ id }) => {
    const template = mailManager.getTemplate(id);

    if (!template) {
      return errorResponse(`Template "${id}" not found`);
    }

    const lines = [
      `Name: ${template.name}`,
      `Subject: ${template.subject}`,
      template.to ? `To: ${template.to.join(", ")}` : null,
      template.cc ? `CC: ${template.cc.join(", ")}` : null,
      `\n${template.body}`,
    ]
      .filter(Boolean)
      .join("\n");

    return successResponse(lines);
  }, "Error getting template")
);

// --- delete-template ---

server.tool(
  "delete-template",
  {
    id: z.string().min(1, "Template ID is required"),
  },
  withErrorHandling(({ id }) => {
    const success = mailManager.deleteTemplate(id);

    if (!success) {
      return errorResponse(`Template "${id}" not found`);
    }

    return successResponse(`Template "${id}" deleted`);
  }, "Error deleting template")
);

// --- use-template ---

server.tool(
  "use-template",
  {
    id: z.string().min(1, "Template ID is required"),
    to: z.array(z.string()).optional().describe("Override recipients"),
    cc: z.array(z.string()).optional().describe("Override CC recipients"),
    subject: z.string().optional().describe("Override subject"),
    body: z.string().optional().describe("Override body"),
  },
  withErrorHandling(({ id, to, cc, subject, body }) => {
    const success = mailManager.useTemplate(id, { to, cc, subject, body });

    if (!success) {
      return errorResponse(`Failed to use template "${id}". Template not found or no recipients.`);
    }

    return successResponse(`Draft created from template "${id}"`);
  }, "Error using template")
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

    if (stats.recentlyReceived) {
      lines.push(`📥 Recently Received:`);
      lines.push(`  Last 24 hours: ${stats.recentlyReceived.last24h}`);
      lines.push(`  Last 7 days: ${stats.recentlyReceived.last7d}`);
      lines.push(`  Last 30 days: ${stats.recentlyReceived.last30d}`);
      lines.push(``);
    }

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

// --- get-sync-status ---

server.tool(
  "get-sync-status",
  {},
  withErrorHandling(() => {
    const status = mailManager.getSyncStatus();

    const lines: string[] = [];
    lines.push(`🔄 Mail Sync Status`);
    lines.push(`═══════════════════`);

    if (status.error) {
      lines.push(`Status: ⚠️ ${status.error}`);
    } else {
      lines.push(`Mail.app: ${status.recentActivity ? "Running" : "Not running"}`);
      lines.push(`Sync active: ${status.syncDetected ? "Yes" : "No"}`);
    }

    return successResponse(lines.join("\n"));
  }, "Error getting sync status")
);

// =============================================================================
// Server Startup
// =============================================================================

/**
 * Initialize and start the MCP server.
 */
const transport = new StdioServerTransport();
await server.connect(transport);
