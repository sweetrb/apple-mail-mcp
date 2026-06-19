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
  resolveImapConfigs,
  imapSearchMessages,
  imapListMessages,
  imapUnreadCount,
  imapListMailboxes,
  imapMailStats,
  imapCreateMailbox,
  imapDeleteMailbox,
  imapRenameMailbox,
  imapGetMessage,
  imapMarkRead,
  imapMarkUnread,
  imapFlagMessage,
  imapUnflagMessage,
  imapMoveMessageById,
  imapDeleteMessageById,
} from "@/services/imapClient.js";
import {
  successResponse,
  errorResponse,
  partialCoverageBlock,
  withErrorHandling,
  messageSummary,
} from "@/tools/respond.js";
import { routeMessage } from "@/services/messageRouter.js";
import { runDoctor, formatDoctorReport } from "@/tools/doctor.js";
import { registerResourcesAndPrompts } from "@/tools/resourcesAndPrompts.js";
import { normalizeSubject, subjectFromGetMessage } from "@/tools/thread.js";
import { ImapIdleWatcher } from "@/services/imapIdle.js";

// =============================================================================
// Shared Validation Schemas
// =============================================================================

/** AppleScript message IDs are always numeric. Enforced to prevent AppleScript
 *  injection via the `whose id is ${id}` interpolation. */
const NUMERIC_MESSAGE_ID_SCHEMA = z.string().regex(/^\d+$/, "Message ID must be numeric");

/** A single-message id is EITHER an AppleScript numeric id OR an IMAP composite
 *  token (`imap:<base64url>`, emitted by the IMAP read path). The IMAP form is
 *  base64url so it stays injection-safe; it never reaches AppleScript (it's
 *  decoded and routed to IMAP instead). */
const MESSAGE_ID_SCHEMA = z
  .string()
  .regex(/^(\d+|imap:[A-Za-z0-9_-]+)$/, "Message ID must be numeric or an IMAP id (imap:…)");

/** Batch operations are AppleScript-only and capped to prevent unbounded loops /
 *  DoS. IMAP ids are rejected here — use the single-message tools for those. */
const BATCH_IDS_SCHEMA = z
  .array(NUMERIC_MESSAGE_ID_SCHEMA)
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

// Attachments: absolute file paths and/or inline base64 content (B4).
const ATTACHMENTS_SCHEMA = z
  .array(
    z.union([
      z.string().describe("Absolute path to an existing file"),
      z.object({
        filename: z.string().min(1).describe("Filename to give the attachment"),
        contentBase64: z.string().min(1).describe("Base64-encoded file content"),
      }),
    ])
  )
  .max(20, "Cannot attach more than 20 files")
  .optional()
  .describe(
    "Files to attach: absolute paths (e.g. '/Users/me/report.pdf') and/or " +
      "inline {filename, contentBase64} objects for content not on disk."
  );

// Read version from package.json to keep it in sync
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

// =============================================================================
// Server Initialization
// =============================================================================

/**
 * MCP server instance configured for Apple Mail operations.
 */
const server = new McpServer(
  {
    name: "apple-mail",
    version,
    description: "MCP server for managing Apple Mail - read, search, send, and organize emails",
  },
  // logging capability lets the IMAP IDLE watcher push new-mail notifications (B5).
  { capabilities: { logging: {} } }
);

/**
 * Singleton instance of the Apple Mail manager.
 * Handles all AppleScript execution and mail operations.
 */
const mailManager = new AppleMailManager();

// MCP resources (accounts/templates/mailboxes) and prompts (triage/reply/
// summary) — additive context + workflows alongside the tools (D2).
registerResourcesAndPrompts(server, mailManager);

// Response helpers, the AppleScript serial gate, withErrorHandling, and the
// message backend router now live in @/tools/respond and @/services/messageRouter.

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
      const structured = {
        messages: messages.map(messageSummary),
        count: messages.length,
        partial: diagnostics.partial,
        skippedLargeMailboxes: diagnostics.skippedLargeMailboxes,
        notSearchedMailboxes: diagnostics.notSearchedMailboxes,
        timedOutAccounts: diagnostics.timedOutAccounts,
      };

      if (messages.length === 0) {
        const base = diagnostics.partial
          ? "No messages found in the portions that were searched."
          : "No messages found matching criteria";
        return successResponse(`${base}${coverageBlock}`, structured);
      }

      const messageList = messages
        .map(
          (m) =>
            `  - ID: ${m.id} | ${m.dateReceived.toLocaleDateString()} | ${m.subject} (from: ${m.sender}) [${m.isRead ? "read" : "unread"}]`
        )
        .join("\n");

      return successResponse(
        `Found ${messages.length} message(s):\n${messageList}${coverageBlock}`,
        structured
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
  withErrorHandling(
    ({ id, preferHtml }) =>
      routeMessage(id, {
        // IMAP id (imap:…) → fetch via IMAP (#43 Phase 3); else AppleScript.
        imap: () => imapGetMessage(id, preferHtml === true),
        apple: () => {
          // Only fetch/parse the raw source when HTML is actually requested (#32).
          const content = mailManager.getMessageContent(id, preferHtml === true);
          if (!content) return errorResponse(`Message with ID "${id}" not found`);
          const isHtml = preferHtml === true && !!content.htmlContent;
          const body = isHtml ? content.htmlContent! : content.plainText;
          return successResponse(`Subject: ${content.subject}\n\n${body}`, {
            id,
            subject: content.subject,
            body,
            isHtml,
          });
        },
        ok: "",
        fail: `Message with ID "${id}" not found`,
      }),
    "Error retrieving message"
  )
);

// --- get-thread ---

server.tool(
  "get-thread",
  {
    id: MESSAGE_ID_SCHEMA.describe("A message ID in the conversation (numeric or imap:…)"),
    account: z.string().optional().describe("Account to search (omit to search all)"),
    mailbox: z.string().optional().describe("Mailbox to search (omit to search all)"),
    limit: z.number().optional().describe("Max messages in the thread (default 50)"),
  },
  withErrorHandling(async ({ id, account, mailbox, limit = 50 }) => {
    // Resolve the seed message's subject, then gather the conversation by
    // normalized subject (B1). Works across the AppleScript and IMAP backends.
    let seedSubject: string | null = null;
    if (id.startsWith("imap:")) {
      const r = await imapGetMessage(id, false, { account });
      if (!r.success || !r.info) return errorResponse(r.error || `Message "${id}" not found`);
      seedSubject = subjectFromGetMessage(r.info);
    } else {
      const msg = mailManager.getMessageById(id);
      if (!msg) return errorResponse(`Message with ID "${id}" not found`);
      seedSubject = msg.subject;
    }
    if (!seedSubject) return errorResponse(`Could not determine the subject of message "${id}"`);
    const base = normalizeSubject(seedSubject);

    // IMAP backend: server-side subject search.
    if (isImapAccount(account)) {
      const text = await imapSearchMessages({ subject: base, mailbox, account, limit });
      return successResponse(`Thread "${base}":\n${text}`, { subject: base });
    }

    const { messages, diagnostics } = mailManager.searchMessagesWithDiagnostics(
      undefined,
      mailbox,
      account,
      limit,
      undefined,
      undefined,
      undefined,
      base
    );
    // Oldest-first is the natural reading order for a conversation.
    const ordered = messages
      .slice()
      .sort((a, b) => a.dateReceived.getTime() - b.dateReceived.getTime());
    const coverageBlock = partialCoverageBlock(diagnostics);
    const structured = {
      subject: base,
      messages: ordered.map(messageSummary),
      count: ordered.length,
      partial: diagnostics.partial,
    };
    if (ordered.length === 0) {
      return successResponse(`No messages found in thread "${base}".${coverageBlock}`, structured);
    }
    const list = ordered
      .map(
        (m) =>
          `  - ID: ${m.id} | ${m.dateReceived.toLocaleDateString()} | ${m.subject} (from: ${m.sender}) [${m.isRead ? "read" : "unread"}]`
      )
      .join("\n");
    return successResponse(
      `Thread "${base}" — ${ordered.length} message(s), oldest first:\n${list}${coverageBlock}`,
      structured
    );
  }, "Error retrieving thread")
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
    const structured = {
      messages: messages.map(messageSummary),
      count: messages.length,
      partial: diagnostics.partial,
      skippedLargeMailboxes: diagnostics.skippedLargeMailboxes,
      notSearchedMailboxes: diagnostics.notSearchedMailboxes,
      timedOutAccounts: diagnostics.timedOutAccounts,
    };

    if (messages.length === 0) {
      const base = diagnostics.partial
        ? "No messages found in the portions that were listed."
        : "No messages found";
      return successResponse(`${base}${coverageBlock}`, structured);
    }

    const messageList = messages
      .map(
        (m) =>
          `  - ID: ${m.id} | ${m.dateReceived.toLocaleDateString()} | ${m.subject} (from: ${m.sender})`
      )
      .join("\n");

    return successResponse(
      `Found ${messages.length} message(s):\n${messageList}${coverageBlock}`,
      structured
    );
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
    attachments: ATTACHMENTS_SCHEMA,
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
    attachments: ATTACHMENTS_SCHEMA,
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
  withErrorHandling(
    ({ id }) =>
      routeMessage(id, {
        imap: () => imapMarkRead(id),
        apple: () =>
          mailManager.markAsRead(id)
            ? successResponse("Message marked as read")
            : errorResponse(`Failed to mark message "${id}" as read`),
        ok: "Message marked as read",
        fail: `Failed to mark message "${id}" as read`,
      }),
    "Error marking message as read"
  )
);

// --- mark-as-unread ---

server.tool(
  "mark-as-unread",
  {
    id: MESSAGE_ID_SCHEMA,
  },
  withErrorHandling(
    ({ id }) =>
      routeMessage(id, {
        imap: () => imapMarkUnread(id),
        apple: () =>
          mailManager.markAsUnread(id)
            ? successResponse("Message marked as unread")
            : errorResponse(`Failed to mark message "${id}" as unread`),
        ok: "Message marked as unread",
        fail: `Failed to mark message "${id}" as unread`,
      }),
    "Error marking message as unread"
  )
);

// --- flag-message ---

server.tool(
  "flag-message",
  {
    id: MESSAGE_ID_SCHEMA,
  },
  withErrorHandling(
    ({ id }) =>
      routeMessage(id, {
        imap: () => imapFlagMessage(id),
        apple: () =>
          mailManager.flagMessage(id)
            ? successResponse("Message flagged")
            : errorResponse(`Failed to flag message "${id}"`),
        ok: "Message flagged",
        fail: `Failed to flag message "${id}"`,
      }),
    "Error flagging message"
  )
);

// --- unflag-message ---

server.tool(
  "unflag-message",
  {
    id: MESSAGE_ID_SCHEMA,
  },
  withErrorHandling(
    ({ id }) =>
      routeMessage(id, {
        imap: () => imapUnflagMessage(id),
        apple: () =>
          mailManager.unflagMessage(id)
            ? successResponse("Message unflagged")
            : errorResponse(`Failed to unflag message "${id}"`),
        ok: "Message unflagged",
        fail: `Failed to unflag message "${id}"`,
      }),
    "Error unflagging message"
  )
);

// --- delete-message ---

server.tool(
  "delete-message",
  {
    id: MESSAGE_ID_SCHEMA,
  },
  withErrorHandling(
    ({ id }) =>
      routeMessage(id, {
        imap: () => imapDeleteMessageById(id),
        apple: () => {
          const { success, error } = mailManager.deleteMessage(id);
          return success
            ? successResponse("Message deleted")
            : errorResponse(error || `Failed to delete message "${id}"`);
        },
        ok: "Message deleted",
        fail: `Failed to delete message "${id}"`,
      }),
    "Error deleting message"
  )
);

// --- move-message ---

server.tool(
  "move-message",
  {
    id: MESSAGE_ID_SCHEMA,
    mailbox: z.string().min(1, "Destination mailbox is required"),
    account: z.string().optional().describe("Account containing the destination mailbox"),
  },
  withErrorHandling(
    ({ id, mailbox, account }) =>
      routeMessage(id, {
        imap: () => imapMoveMessageById(id, mailbox),
        apple: () => {
          const { success, error } = mailManager.moveMessage(id, mailbox, account);
          return success
            ? successResponse(`Message moved to "${mailbox}"`)
            : errorResponse(error || `Failed to move message to "${mailbox}"`);
        },
        ok: `Message moved to "${mailbox}"`,
        fail: `Failed to move message to "${mailbox}"`,
      }),
    "Error moving message"
  )
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
    const structured = { attachments, count: attachments.length };

    if (attachments.length === 0) {
      return successResponse("No attachments found", structured);
    }

    const attachmentList = attachments
      .map((a) => {
        const sizeKb = Math.round(a.size / 1024);
        return `  - ${a.name} (${a.mimeType}, ${sizeKb} KB)`;
      })
      .join("\n");

    return successResponse(
      `Found ${attachments.length} attachment(s):\n${attachmentList}`,
      structured
    );
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

// --- fetch-attachment ---

server.tool(
  "fetch-attachment",
  {
    id: NUMERIC_MESSAGE_ID_SCHEMA,
    attachmentName: z.string().min(1, "Attachment name is required"),
  },
  withErrorHandling(({ id, attachmentName }) => {
    // Returns the attachment bytes as base64 (B4) — the read counterpart to
    // sending inline base64 content, for clients that want the bytes directly
    // rather than writing to disk via save-attachment.
    const r = mailManager.getAttachmentBase64(id, attachmentName);
    if (!r.success) {
      return errorResponse(r.error || `Failed to fetch attachment "${attachmentName}"`);
    }
    return successResponse(
      `Fetched "${attachmentName}" (${r.bytes} bytes, base64-encoded below).\n\n${r.base64}`,
      { attachmentName, bytes: r.bytes, contentBase64: r.base64 }
    );
  }, "Error fetching attachment")
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
  withErrorHandling(async ({ account }) => {
    // IMAP (I6): LIST + per-mailbox STATUS — sees the true server hierarchy and
    // authoritative counts; falls back to AppleScript for non-IMAP accounts.
    if (isImapAccount(account)) {
      const boxes = await imapListMailboxes({ account });
      const structured = {
        mailboxes: boxes.map((b) => ({
          name: b.path,
          unreadCount: b.unseen,
          messageCount: b.messages,
        })),
        count: boxes.length,
      };
      if (boxes.length === 0) return successResponse("No mailboxes found", structured);
      const list = boxes.map((b) => `  - ${b.path} (${b.unseen} unread)`).join("\n");
      return successResponse(`Found ${boxes.length} mailbox(es):\n${list}`, structured);
    }

    const mailboxes = mailManager.listMailboxes(account);
    const structured = { mailboxes, count: mailboxes.length };

    if (mailboxes.length === 0) {
      return successResponse("No mailboxes found", structured);
    }

    const mailboxList = mailboxes.map((m) => `  - ${m.name} (${m.unreadCount} unread)`).join("\n");

    return successResponse(`Found ${mailboxes.length} mailbox(es):\n${mailboxList}`, structured);
  }, "Error listing mailboxes")
);

// --- get-unread-count ---

server.tool(
  "get-unread-count",
  {
    mailbox: z.string().optional().describe("Mailbox to check (default: all)"),
    account: z.string().optional().describe("Account to check"),
  },
  withErrorHandling(async ({ mailbox, account }) => {
    // IMAP (I4): STATUS (UNSEEN) is authoritative and fast even on huge
    // mailboxes; falls back to AppleScript for non-IMAP accounts.
    const count = isImapAccount(account)
      ? await imapUnreadCount(mailbox, { account })
      : mailManager.getUnreadCount(mailbox, account);
    const location = mailbox ? ` in "${mailbox}"` : "";

    return successResponse(`${count} unread message(s)${location}`, {
      unread: count,
      mailbox,
      account,
    });
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
      const r = await imapCreateMailbox(name, { account });
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
      const r = await imapDeleteMailbox(name, { account });
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
      const r = await imapRenameMailbox(oldName, newName, { account });
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
    const structured = { accounts, count: accounts.length };

    if (accounts.length === 0) {
      return successResponse("No Mail accounts found", structured);
    }

    const accountList = accounts.map((a) => `  - ${a.name}`).join("\n");
    return successResponse(`Found ${accounts.length} account(s):\n${accountList}`, structured);
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

// --- create-rule ---

server.tool(
  "create-rule",
  {
    name: z.string().min(1, "Rule name is required"),
    conditions: z
      .array(
        z.object({
          field: z.enum(["from", "to", "cc", "subject", "content"]),
          operator: z
            .enum(["contains", "notContains", "equals", "beginsWith", "endsWith"])
            .default("contains"),
          value: z.string().min(1, "Condition value is required"),
        })
      )
      .min(1, "At least one condition is required"),
    actions: z
      .object({
        markRead: z.boolean().optional(),
        markFlagged: z.boolean().optional(),
        delete: z.boolean().optional(),
        moveTo: z.string().optional(),
        moveToAccount: z.string().optional(),
      })
      .refine(
        (a) => a.markRead || a.markFlagged || a.delete || a.moveTo,
        "At least one action is required (markRead, markFlagged, delete, or moveTo)"
      ),
    matchAll: z.boolean().default(true),
    enabled: z.boolean().default(true),
  },
  withErrorHandling((args) => {
    const result = mailManager.createRule(args);
    if (!result.success) {
      return errorResponse(`Failed to create rule "${args.name}": ${result.error}`);
    }
    return successResponse(
      `Rule "${args.name}" created with ${args.conditions.length} condition(s).`,
      { name: args.name, created: true }
    );
  }, "Error creating rule")
);

// --- delete-rule ---

server.tool(
  "delete-rule",
  {
    name: z.string().min(1, "Rule name is required"),
  },
  withErrorHandling(({ name }) => {
    const success = mailManager.deleteRule(name);
    if (!success) {
      return errorResponse(`Failed to delete rule "${name}" (not found?)`);
    }
    return successResponse(`Rule "${name}" deleted`, { name, deleted: true });
  }, "Error deleting rule")
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

// --- doctor ---

server.tool(
  "doctor",
  {},
  withErrorHandling(async () => {
    // Diagnoses Mail.app permission, account state, and the IMAP/SMTP backends
    // with actionable messages (C3). structuredContent carries the raw checks.
    const report = await runDoctor(mailManager);
    return successResponse(formatDoctorReport(report), { ...report });
  }, "Error running doctor")
);

// --- get-mail-stats ---

server.tool(
  "get-mail-stats",
  {
    account: z
      .string()
      .optional()
      .describe("Limit to one account; uses fast IMAP STATUS if that account is IMAP-configured"),
  },
  withErrorHandling(async ({ account }) => {
    // IMAP (I3): for a named IMAP account, STATUS gives authoritative counts and
    // SEARCH SINCE gives recent activity — fast even on huge mailboxes.
    if (account && isImapAccount(account)) {
      const s = await imapMailStats({ account });
      const lines = [
        `📊 Mail Statistics — ${account} (IMAP)`,
        `══════════════════`,
        `Total messages: ${s.totalMessages}`,
        `Unread messages: ${s.totalUnread}`,
        ``,
        `📥 Recently Received (INBOX):`,
        `  Last 24 hours: ${s.recent.last24h}`,
        `  Last 7 days: ${s.recent.last7d}`,
        `  Last 30 days: ${s.recent.last30d}`,
      ];
      return successResponse(lines.join("\n"), { account, ...s });
    }

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

    return successResponse(lines.join("\n"), { ...stats });
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

    return successResponse(lines.join("\n"), { ...status });
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

// IMAP IDLE push notifications (B5) — opt-in. When enabled, watch every
// configured IMAP account's INBOX and notify the client on new mail via a
// logging message + a resource-updated signal for the account's mailbox.
let idleWatcher: ImapIdleWatcher | undefined;
if (/^(1|true|yes|on)$/i.test(process.env.APPLE_MAIL_MCP_IMAP_IDLE?.trim() ?? "")) {
  try {
    const configs = resolveImapConfigs();
    if (configs.length > 0) {
      idleWatcher = new ImapIdleWatcher({
        configs,
        onNewMail: (e) => {
          const newCount = e.count - e.prevCount;
          void server.server
            .sendLoggingMessage({
              level: "info",
              logger: "apple-mail-mcp",
              data: `New mail in "${e.account}": ${newCount} new message(s) (INBOX now ${e.count}).`,
            })
            .catch(() => undefined);
          void server.server
            .sendResourceUpdated({ uri: `mail://mailboxes/${encodeURIComponent(e.account)}` })
            .catch(() => undefined);
        },
      });
      await idleWatcher.start();
    }
  } catch (e) {
    console.error(`IMAP IDLE watcher failed to start: ${String(e)}`);
  }
}

// Clean up the long-lived IDLE connections on shutdown.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void idleWatcher?.stop().finally(() => process.exit(0));
  });
}
