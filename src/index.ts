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
import { sendViaSmtp } from "@/services/smtpMailer.js";
import {
  isImapAccount,
  imapSearchMessages,
  imapListMessages,
  imapCreateMailbox,
  imapDeleteMailbox,
  imapRenameMailbox,
} from "@/services/imapClient.js";
import { createSerialGate } from "@/utils/serialize.js";
import type { SearchDiagnostics } from "@/types.js";

// =============================================================================
// Shared Validation Schemas
// =============================================================================

/** Message IDs in Apple Mail are always numeric. Enforce this at the schema level
 *  to prevent AppleScript injection via the `whose id is ${id}` interpolation. */
const MESSAGE_ID_SCHEMA = z.string().regex(/^\d+$/, "Message ID must be numeric");

/** Batch operations are capped to prevent unbounded loops / DoS. */
const BATCH_IDS_SCHEMA = z
  .array(MESSAGE_ID_SCHEMA)
  .min(1, "At least one message ID is required")
  .max(100, "Cannot process more than 100 messages in a single batch");

/** Date filter strings must look like natural-language dates (e.g. "March 1, 2026").
 *  Block characters that could escape an AppleScript `date "..."` literal. */
const DATE_FILTER_SCHEMA = z
  .string()
  .regex(
    /^[a-zA-Z0-9 ,/\-:]+$/,
    "Date must contain only alphanumeric characters, spaces, commas, slashes, hyphens, and colons"
  )
  .refine((val) => !isNaN(new Date(val).getTime()), {
    message: "Date string must be a valid date (e.g., 'January 1, 2026' or '2026-03-15')",
  })
  .optional();

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

type ToolResponse = ReturnType<typeof successResponse> | ReturnType<typeof errorResponse>;

/**
 * Render a partial-coverage warning from search/list diagnostics, so a caller
 * never mistakes an incomplete scan for a confirmed "no matches" (#24/#29).
 * Returns "" when coverage was complete.
 */
function partialCoverageBlock(diagnostics: SearchDiagnostics): string {
  const notes: string[] = [];
  if (diagnostics.timedOutAccounts.length > 0) {
    notes.push(`timed out (no results) for account(s): ${diagnostics.timedOutAccounts.join(", ")}`);
  }
  if (diagnostics.skippedLargeMailboxes.length > 0) {
    notes.push(
      `skipped mailbox(es) too large to scan via AppleScript: ${diagnostics.skippedLargeMailboxes.join(", ")} — scope with \`mailbox\` (+ a \`dateFrom\`/\`dateTo\` window for search) to reach them`
    );
  }
  if (diagnostics.notSearchedMailboxes.length > 0) {
    notes.push(
      `could not finish scanning mailbox(es): ${diagnostics.notSearchedMailboxes.join(", ")}`
    );
  }
  if (notes.length === 0) return "";
  return `\n\n⚠️  Partial results — this is NOT a confirmed "no such mail":\n${notes
    .map((n) => `  - ${n}`)
    .join("\n")}`;
}

/**
 * Serial execution gate for AppleScript-backed tool calls (issue #11).
 *
 * Concurrent MCP tool calls are funneled through this single gate so only one
 * osascript invocation hits Mail.app's single-threaded AppleScript dispatch at
 * a time, with a short settle delay between calls so the dispatch queue drains.
 * Without it, a concurrent batch races into Mail.app, the later calls blow past
 * their timeouts, and Mail.app is left half-recovered for the next batch.
 */
const serializeAppleScript = createSerialGate();

/**
 * Wraps a tool handler with consistent error handling, serialized through the
 * AppleScript gate so concurrent MCP tool calls don't race into Mail.app (#11).
 * Handlers may be synchronous or async (the SMTP send path in send-email is
 * async), so the handler result is awaited inside the gate.
 */
function withErrorHandling<T extends Record<string, unknown>>(
  handler: (params: T) => ToolResponse | Promise<ToolResponse>,
  errorPrefix: string
) {
  return async (params: T) => {
    return serializeAppleScript(async () => {
      try {
        return await handler(params);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return errorResponse(`${errorPrefix}: ${message}`);
      }
    });
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
    from: z
      .string()
      .optional()
      .describe(
        "Filter by sender (substring match against the full sender string, i.e. display name + address — not an exact address match)"
      ),
    subject: z.string().optional().describe("Filter by subject line (substring match)"),
    mailbox: z
      .string()
      .optional()
      .describe("Mailbox to search in (e.g., 'INBOX'). Omit to search all mailboxes."),
    account: z.string().optional().describe("Account to search in (omit to search all accounts)"),
    isRead: z.boolean().optional().describe("Filter by read status"),
    isFlagged: z.boolean().optional().describe("Filter by flagged status"),
    dateFrom: DATE_FILTER_SCHEMA.describe("Start date filter (e.g., 'January 1, 2026')"),
    dateTo: DATE_FILTER_SCHEMA.describe("End date filter (e.g., 'March 1, 2026')"),
    limit: z.number().optional().describe("Maximum number of results (default: 50)"),
  },
  withErrorHandling(
    async ({
      query,
      mailbox,
      account,
      limit = 50,
      dateFrom,
      dateTo,
      from,
      subject,
      isRead,
      isFlagged,
    }) => {
      // IMAP backend (issue #43): server-side search when this account is
      // explicitly configured for IMAP; otherwise fall through to AppleScript.
      if (isImapAccount(account)) {
        return successResponse(
          await imapSearchMessages({
            query,
            mailbox,
            account,
            limit,
            dateFrom,
            dateTo,
            from,
            subject,
            isRead,
            isFlagged,
          })
        );
      }

      const { messages, diagnostics } = mailManager.searchMessagesWithDiagnostics(
        query,
        mailbox,
        account,
        limit,
        dateFrom,
        dateTo,
        from,
        subject,
        isRead,
        isFlagged
      );

      const coverageBlock = partialCoverageBlock(diagnostics);

      if (messages.length === 0) {
        const base = diagnostics.partial
          ? "No messages found in the portions that were searched."
          : "No messages found matching criteria";
        return successResponse(`${base}${coverageBlock}`);
      }

      const messageList = messages
        .map(
          (m) =>
            `  - ID: ${m.id} | ${m.dateReceived.toLocaleDateString()} | ${m.subject} (from: ${m.sender}) [${m.isRead ? "read" : "unread"}]`
        )
        .join("\n");

      return successResponse(
        `Found ${messages.length} message(s):\n${messageList}${coverageBlock}`
      );
    },
    "Error searching messages"
  )
);

// --- get-message ---

server.tool(
  "get-message",
  {
    id: MESSAGE_ID_SCHEMA,
    preferHtml: z
      .boolean()
      .optional()
      .describe("Return the HTML body (extracted from the message source) instead of plain text"),
  },
  withErrorHandling(({ id, preferHtml }) => {
    // Only fetch/parse the raw source when HTML is actually requested (#32).
    const content = mailManager.getMessageContent(id, preferHtml === true);

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
    mailbox: z
      .string()
      .optional()
      .describe("Mailbox to list messages from. Omit to list from all mailboxes."),
    account: z.string().optional().describe("Account to list messages from"),
    limit: z.number().optional().describe("Maximum number of messages (default: 50)"),
    offset: z.number().optional().describe("Number of messages to skip (for pagination)"),
    from: z.string().optional().describe("Filter by sender email address or name"),
    unreadOnly: z.boolean().optional().describe("Only show unread messages"),
  },
  withErrorHandling(async ({ mailbox, account, limit = 50, offset = 0, from, unreadOnly }) => {
    // IMAP backend (issue #43): server-side listing when this account is
    // explicitly configured for IMAP; otherwise fall through to AppleScript.
    if (isImapAccount(account)) {
      return successResponse(
        await imapListMessages({ mailbox, account, limit, offset, from, unreadOnly })
      );
    }

    const { messages, diagnostics } = mailManager.listMessagesWithDiagnostics(
      mailbox,
      account,
      limit,
      from,
      offset
    );

    const coverageBlock = partialCoverageBlock(diagnostics);

    if (messages.length === 0) {
      const base = diagnostics.partial
        ? "No messages found in the portions that were listed."
        : "No messages found";
      return successResponse(`${base}${coverageBlock}`);
    }

    const messageList = messages
      .map(
        (m) =>
          `  - ID: ${m.id} | ${m.dateReceived.toLocaleDateString()} | ${m.subject} (from: ${m.sender})`
      )
      .join("\n");

    return successResponse(`Found ${messages.length} message(s):\n${messageList}${coverageBlock}`);
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
      .max(20, "Cannot attach more than 20 files")
      .optional()
      .describe("Absolute file paths to attach (e.g., ['/Users/me/report.pdf'])"),
    transport: z
      .enum(["applescript", "smtp"])
      .optional()
      .describe(
        "Send transport. 'applescript' (default) sends through Mail.app. " +
          "'smtp' submits clean MIME directly via SMTP, avoiding the macOS 15+ " +
          "Mail.app <blockquote> wrapping (issue #12); requires APPLE_MAIL_MCP_SMTP_* env config."
      ),
  },
  withErrorHandling(async ({ to, subject, body, cc, bcc, account, attachments, transport }) => {
    const attachInfo = attachments?.length ? ` with ${attachments.length} attachment(s)` : "";

    if (transport === "smtp") {
      const result = await sendViaSmtp({ to, subject, body, cc, bcc, from: account, attachments });
      if (!result.success) {
        return errorResponse(result.error ?? "Failed to send email via SMTP.");
      }
      return successResponse(`Email sent via SMTP to ${to.join(", ")}${attachInfo}`);
    }

    const success = mailManager.sendEmail(to, subject, body, cc, bcc, account, attachments);

    if (!success) {
      return errorResponse("Failed to send email. Check Mail.app configuration.");
    }

    return successResponse(`Email sent to ${to.join(", ")}${attachInfo}`);
  }, "Error sending email")
);

// --- send-serial-email ---

server.tool(
  "send-serial-email",
  {
    recipients: z
      .array(
        z.object({
          email: z.string().min(1, "Recipient email is required"),
          variables: z
            .record(z.string())
            .describe("Placeholder values, e.g. { Name: 'Alice', Company: 'Acme' }"),
        })
      )
      .min(1, "At least one recipient is required")
      .max(100, "Cannot send to more than 100 recipients in a single batch")
      .describe("List of recipients with personalization variables (max 100)"),
    subject: z
      .string()
      .min(1, "Subject is required")
      .describe("Subject line — use {{Key}} for placeholders"),
    body: z
      .string()
      .min(1, "Body is required")
      .describe("Email body — use {{Key}} for placeholders"),
    account: z.string().optional().describe("Account to send from"),
    delayMs: z
      .number()
      .min(0)
      .max(10000)
      .optional()
      .describe("Delay between sends in ms (default: 500, max: 10000)"),
  },
  withErrorHandling(({ recipients, subject, body, account, delayMs }) => {
    const results = mailManager.sendSerialEmail(recipients, subject, body, account, delayMs);
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    const details = results
      .map((r) => `  - ${r.email}: ${r.success ? "sent" : `FAILED (${r.error})`}`)
      .join("\n");

    if (failCount === 0) {
      return successResponse(`Successfully sent ${successCount} email(s):\n${details}`);
    } else if (successCount === 0) {
      return errorResponse(`Failed to send all ${failCount} email(s):\n${details}`);
    } else {
      return successResponse(
        `Sent ${successCount} of ${results.length} email(s), ${failCount} failed:\n${details}`
      );
    }
  }, "Error sending serial emails")
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
      .max(20, "Cannot attach more than 20 files")
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
    id: MESSAGE_ID_SCHEMA,
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
    id: MESSAGE_ID_SCHEMA,
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
    id: MESSAGE_ID_SCHEMA,
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
    id: MESSAGE_ID_SCHEMA,
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
    id: MESSAGE_ID_SCHEMA,
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
    id: MESSAGE_ID_SCHEMA,
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
    id: MESSAGE_ID_SCHEMA,
  },
  withErrorHandling(({ id }) => {
    const { success, error } = mailManager.deleteMessage(id);

    if (!success) {
      return errorResponse(error || `Failed to delete message "${id}"`);
    }

    return successResponse("Message deleted");
  }, "Error deleting message")
);

// --- move-message ---

server.tool(
  "move-message",
  {
    id: MESSAGE_ID_SCHEMA,
    mailbox: z.string().min(1, "Destination mailbox is required"),
    account: z.string().optional().describe("Account containing the destination mailbox"),
  },
  withErrorHandling(({ id, mailbox, account }) => {
    const { success, error } = mailManager.moveMessage(id, mailbox, account);

    if (!success) {
      return errorResponse(error || `Failed to move message to "${mailbox}"`);
    }

    return successResponse(`Message moved to "${mailbox}"`);
  }, "Error moving message")
);

// --- batch-delete-messages ---

server.tool(
  "batch-delete-messages",
  {
    ids: BATCH_IDS_SCHEMA,
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
    ids: BATCH_IDS_SCHEMA,
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
    ids: BATCH_IDS_SCHEMA,
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
    ids: BATCH_IDS_SCHEMA,
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
    ids: BATCH_IDS_SCHEMA,
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
    ids: BATCH_IDS_SCHEMA,
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
    id: MESSAGE_ID_SCHEMA,
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
    id: MESSAGE_ID_SCHEMA,
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
  withErrorHandling(async ({ name, account }) => {
    // IMAP backend (issue #43, Phase 2): server-side folder op when this account
    // is IMAP-configured; otherwise AppleScript.
    if (isImapAccount(account)) {
      const r = await imapCreateMailbox(name);
      if (!r.success) return errorResponse(r.error || `Failed to create mailbox "${name}"`);
      return successResponse(r.info || `Mailbox "${name}" created`);
    }

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
  withErrorHandling(async ({ name, account }) => {
    if (isImapAccount(account)) {
      const r = await imapDeleteMailbox(name);
      if (!r.success) return errorResponse(r.error || `Failed to delete mailbox "${name}"`);
      return successResponse(r.info || `Mailbox "${name}" deleted`);
    }

    const { success, error } = mailManager.deleteMailbox(name, account);

    if (!success) {
      return errorResponse(error || `Failed to delete mailbox "${name}"`);
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
  withErrorHandling(async ({ oldName, newName, account }) => {
    if (isImapAccount(account)) {
      const r = await imapRenameMailbox(oldName, newName);
      if (!r.success) {
        return errorResponse(r.error || `Failed to rename mailbox "${oldName}" to "${newName}"`);
      }
      return successResponse(r.info || `Mailbox renamed from "${oldName}" to "${newName}"`);
    }

    const { success, error } = mailManager.renameMailbox(oldName, newName, account);

    if (!success) {
      return errorResponse(error || `Failed to rename mailbox "${oldName}" to "${newName}"`);
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
