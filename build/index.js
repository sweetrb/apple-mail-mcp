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
import { AppleMailManager, isPathWithinAllowedRoots } from "./services/appleMailManager.js";
import { writeFileSync } from "fs";
import { resolve as resolvePath, join as joinPath } from "path";
import { sendViaSmtp } from "./services/smtpMailer.js";
import { isImapAccount, resolveImapConfigs, imapSearchMessages, imapListMessages, imapUnreadCount, imapListMailboxes, imapMailStats, imapListAttachments, imapFetchAttachment, imapBatchMarkRead, imapBatchMarkUnread, imapBatchFlag, imapBatchUnflag, imapBatchDelete, imapBatchMove, imapThread, imapCreateMailbox, imapDeleteMailbox, imapRenameMailbox, imapGetMessage, imapMarkRead, imapMarkUnread, imapFlagMessage, imapUnflagMessage, imapMoveMessageById, imapDeleteMessageById, } from "./services/imapClient.js";
import { successResponse, errorResponse, partialCoverageBlock, withErrorHandling, messageSummary, } from "./tools/respond.js";
import { routeMessage } from "./services/messageRouter.js";
import { runDoctor, formatDoctorReport } from "./tools/doctor.js";
import { registerResourcesAndPrompts } from "./tools/resourcesAndPrompts.js";
import { normalizeSubject, subjectFromGetMessage } from "./tools/thread.js";
import { ImapIdleWatcher } from "./services/imapIdle.js";
import { loadFileConfig } from "./services/fileConfig.js";
// Load file-based config FIRST (2.1.1) — before anything reads APPLE_MAIL_MCP_*.
// Lets users configure the server when the host app strips the MCP env block.
loadFileConfig();
// =============================================================================
// Shared Validation Schemas
// =============================================================================
/** A single-message id is EITHER an AppleScript numeric id OR an IMAP composite
 *  token (`imap:<base64url>`, emitted by the IMAP read path). The IMAP form is
 *  base64url so it stays injection-safe; it never reaches AppleScript (it's
 *  decoded and routed to IMAP instead). */
const MESSAGE_ID_SCHEMA = z
    .string()
    .regex(/^(\d+|imap:[A-Za-z0-9_-]+)$/, "Message ID must be numeric or an IMAP id (imap:…)");
/** Batch operations accept numeric (AppleScript) and/or imap: ids (I2) and are
 *  capped to prevent unbounded loops / DoS. Numeric ids run via AppleScript;
 *  imap: ids are grouped by mailbox and applied in a single UID command. */
const BATCH_IDS_SCHEMA = z
    .array(MESSAGE_ID_SCHEMA)
    .min(1, "At least one message ID is required")
    .max(100, "Cannot process more than 100 messages in a single batch");
/** Date filter strings must look like natural-language dates (e.g. "March 1, 2026").
 *  Block characters that could escape an AppleScript `date "..."` literal. */
const DATE_FILTER_SCHEMA = z
    .string()
    .regex(/^[a-zA-Z0-9 ,/\-:]+$/, "Date must contain only alphanumeric characters, spaces, commas, slashes, hyphens, and colons")
    .refine((val) => !isNaN(new Date(val).getTime()), {
    message: "Date string must be a valid date (e.g., 'January 1, 2026' or '2026-03-15')",
})
    .optional();
// Attachments: absolute file paths and/or inline base64 content (B4).
const ATTACHMENTS_SCHEMA = z
    .array(z.union([
    z.string().describe("Absolute path to an existing file"),
    z.object({
        filename: z.string().min(1).describe("Filename to give the attachment"),
        contentBase64: z.string().min(1).describe("Base64-encoded file content"),
    }),
]))
    .max(20, "Cannot attach more than 20 files")
    .optional()
    .describe("Files to attach: absolute paths (e.g. '/Users/me/report.pdf') and/or " +
    "inline {filename, contentBase64} objects for content not on disk.");
// Read version from package.json to keep it in sync
const require = createRequire(import.meta.url);
const { version } = require("../package.json");
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
}, 
// logging capability lets the IMAP IDLE watcher push new-mail notifications (B5).
{ capabilities: { logging: {} } });
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
/**
 * Split a batch of ids into numeric (AppleScript) and imap: (IMAP) groups, run
 * each path, and merge into success/fail counts (I2). imap: ids apply in a
 * single UID command per mailbox; numeric ids use the existing AppleScript batch.
 */
async function hybridBatchCounts(ids, appleFn, imapFn) {
    const imapIds = ids.filter((i) => i.startsWith("imap:"));
    const numericIds = ids.filter((i) => !i.startsWith("imap:"));
    let success = 0;
    let fail = 0;
    const errors = [];
    if (numericIds.length > 0) {
        const res = appleFn(numericIds);
        const s = res.filter((r) => r.success).length;
        success += s;
        fail += res.length - s;
    }
    if (imapIds.length > 0) {
        const r = await imapFn(imapIds);
        success += r.success;
        fail += r.failed;
        errors.push(...r.errors);
    }
    return { success, fail, errors };
}
// =============================================================================
// Message Tools
// =============================================================================
// --- search-messages ---
server.tool("search-messages", "Use when: finding messages by query/sender/subject/date/read/flag filters and you need their ids for follow-up operations.\nReturns: matching messages with id, date, subject, sender, and read state (plus partial-coverage diagnostics when some mailboxes were skipped).\nDo not use when: you want a plain mailbox listing without filters (use list-messages), already have an id and want the body (use get-message), or want a whole conversation (use get-thread).\nPrefer this first to obtain the message ids that get-message/mark-as-read/delete-message/move-message and the batch tools require.", {
    query: z.string().optional().describe("Text to search for in subject, sender, or content"),
    from: z
        .string()
        .optional()
        .describe("Filter by sender (substring match against the full sender string, i.e. display name + address — not an exact address match)"),
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
}, withErrorHandling(async ({ query, mailbox, account, limit = 50, dateFrom, dateTo, from, subject, isRead, isFlagged, }) => {
    // IMAP backend (issue #43): server-side search when this account is
    // explicitly configured for IMAP; otherwise fall through to AppleScript.
    if (isImapAccount(account)) {
        return successResponse(await imapSearchMessages({
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
        }));
    }
    const { messages, diagnostics } = mailManager.searchMessagesWithDiagnostics(query, mailbox, account, limit, dateFrom, dateTo, from, subject, isRead, isFlagged);
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
        .map((m) => `  - ID: ${m.id} | ${m.dateReceived.toLocaleDateString()} | ${m.subject} (from: ${m.sender}) [${m.isRead ? "read" : "unread"}]`)
        .join("\n");
    return successResponse(`Found ${messages.length} message(s):\n${messageList}${coverageBlock}`, structured);
}, "Error searching messages"));
// --- get-message ---
server.tool("get-message", "Use when: reading the full body of one message whose id you already have (numeric or imap:…); set preferHtml to get the HTML body instead of plain text.\nReturns: the message subject and body (plain text by default, HTML when preferHtml is true).\nDo not use when: you don't yet have an id (use search-messages or list-messages first), or you want the whole conversation (use get-thread).", {
    id: MESSAGE_ID_SCHEMA,
    preferHtml: z
        .boolean()
        .optional()
        .describe("Return the HTML body (extracted from the message source) instead of plain text"),
}, withErrorHandling(({ id, preferHtml }) => routeMessage(id, {
    // IMAP id (imap:…) → fetch via IMAP (#43 Phase 3); else AppleScript.
    imap: () => imapGetMessage(id, preferHtml === true),
    apple: () => {
        // Only fetch/parse the raw source when HTML is actually requested (#32).
        const content = mailManager.getMessageContent(id, preferHtml === true);
        if (!content)
            return errorResponse(`Message with ID "${id}" not found`);
        const isHtml = preferHtml === true && !!content.htmlContent;
        const body = isHtml ? content.htmlContent : content.plainText;
        return successResponse(`Subject: ${content.subject}\n\n${body}`, {
            id,
            subject: content.subject,
            body,
            isHtml,
        });
    },
    ok: "",
    fail: `Message with ID "${id}" not found`,
}), "Error retrieving message"));
// --- get-thread ---
server.tool("get-thread", "Use when: you have one message id and want the whole conversation it belongs to, oldest-first. With an imap: id it threads by References/Message-ID; otherwise it groups by normalized subject.\nReturns: the thread's normalized subject and its messages (id, date, subject, sender, read state).\nDo not use when: you only need the single message (use get-message) or are searching by arbitrary criteria (use search-messages).", {
    id: MESSAGE_ID_SCHEMA.describe("A message ID in the conversation (numeric or imap:…)"),
    account: z.string().optional().describe("Account to search (omit to search all)"),
    mailbox: z.string().optional().describe("Mailbox to search (omit to search all)"),
    limit: z.number().optional().describe("Max messages in the thread (default 50)"),
}, withErrorHandling(async ({ id, account, mailbox, limit = 50 }) => {
    // True threading via References/Message-ID when we have an imap: id (I5);
    // falls through to subject grouping if the server lacks HEADER search or
    // nothing References-linked is found.
    if (id.startsWith("imap:")) {
        const t = await imapThread(id, { account }, limit);
        if (t && t.count > 1)
            return successResponse(t.text, { ...t.structured });
    }
    // Resolve the seed message's subject, then gather the conversation by
    // normalized subject (B1). Works across the AppleScript and IMAP backends.
    let seedSubject = null;
    if (id.startsWith("imap:")) {
        const r = await imapGetMessage(id, false, { account });
        if (!r.success || !r.info)
            return errorResponse(r.error || `Message "${id}" not found`);
        seedSubject = subjectFromGetMessage(r.info);
    }
    else {
        const msg = mailManager.getMessageById(id);
        if (!msg)
            return errorResponse(`Message with ID "${id}" not found`);
        seedSubject = msg.subject;
    }
    if (!seedSubject)
        return errorResponse(`Could not determine the subject of message "${id}"`);
    const base = normalizeSubject(seedSubject);
    // IMAP backend: server-side subject search.
    if (isImapAccount(account)) {
        const text = await imapSearchMessages({ subject: base, mailbox, account, limit });
        return successResponse(`Thread "${base}":\n${text}`, { subject: base });
    }
    const { messages, diagnostics } = mailManager.searchMessagesWithDiagnostics(undefined, mailbox, account, limit, undefined, undefined, undefined, base);
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
        .map((m) => `  - ID: ${m.id} | ${m.dateReceived.toLocaleDateString()} | ${m.subject} (from: ${m.sender}) [${m.isRead ? "read" : "unread"}]`)
        .join("\n");
    return successResponse(`Thread "${base}" — ${ordered.length} message(s), oldest first:\n${list}${coverageBlock}`, structured);
}, "Error retrieving thread"));
// --- list-messages ---
server.tool("list-messages", "Use when: browsing a mailbox's recent messages (optionally filtered by sender or unread-only) with pagination via limit/offset, and you need their ids.\nReturns: messages with id, date, subject, and sender (plus partial-coverage diagnostics when some mailboxes were skipped).\nDo not use when: you have specific search criteria like subject/date/flags (use search-messages) or already have an id and want the body (use get-message).\nLike search-messages, use this to obtain the ids that read/mark/delete/move and batch tools require.", {
    mailbox: z
        .string()
        .optional()
        .describe("Mailbox to list messages from. Omit to list from all mailboxes."),
    account: z.string().optional().describe("Account to list messages from"),
    limit: z.number().optional().describe("Maximum number of messages (default: 50)"),
    offset: z.number().optional().describe("Number of messages to skip (for pagination)"),
    from: z.string().optional().describe("Filter by sender email address or name"),
    unreadOnly: z.boolean().optional().describe("Only show unread messages"),
}, withErrorHandling(async ({ mailbox, account, limit = 50, offset = 0, from, unreadOnly }) => {
    // IMAP backend (issue #43): server-side listing when this account is
    // explicitly configured for IMAP; otherwise fall through to AppleScript.
    if (isImapAccount(account)) {
        return successResponse(await imapListMessages({ mailbox, account, limit, offset, from, unreadOnly }));
    }
    const { messages, diagnostics } = mailManager.listMessagesWithDiagnostics(mailbox, account, limit, from, offset);
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
        .map((m) => `  - ID: ${m.id} | ${m.dateReceived.toLocaleDateString()} | ${m.subject} (from: ${m.sender})`)
        .join("\n");
    return successResponse(`Found ${messages.length} message(s):\n${messageList}${coverageBlock}`, structured);
}, "Error listing messages"));
// --- send-email ---
server.tool("send-email", "Use when: the user has explicitly confirmed they want to send a single email now to the given recipients (to/cc/bcc are arrays), optionally with attachments and a chosen transport.\nReturns: a confirmation naming the recipients and attachment count.\nDo not use when: the user wants to review first (use create-draft), is replying to or forwarding an existing message (use reply-to-message / forward-message), or wants per-recipient personalized copies (use send-serial-email).\nSafety: this SENDS real email immediately and it cannot be unsent — require explicit user confirmation of the exact recipients, subject, and body before calling. Prefer create-draft when there is any doubt.", {
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
        .describe("Send transport. 'applescript' (default) sends through Mail.app. " +
        "'smtp' submits clean MIME directly via SMTP, avoiding the macOS 15+ " +
        "Mail.app <blockquote> wrapping (issue #12); requires APPLE_MAIL_MCP_SMTP_* env config."),
}, withErrorHandling(async ({ to, subject, body, cc, bcc, account, attachments, transport }) => {
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
}, "Error sending email"));
// --- send-serial-email ---
server.tool("send-serial-email", "Use when: the user has confirmed a mail-merge — sending individually personalized copies to many recipients (max 100), with {{Key}} placeholders in subject/body replaced per-recipient from each recipient's variables. Recipients do not see each other.\nReturns: a per-recipient sent/failed report with counts.\nDo not use when: sending one message to a shared recipient list (use send-email) or saving for review (use create-draft).\nSafety: this SENDS many real emails immediately and they cannot be unsent — require explicit user confirmation of the recipient list, the subject/body template, and the placeholder substitutions before calling.", {
    recipients: z
        .array(z.object({
        email: z.string().min(1, "Recipient email is required"),
        variables: z
            .record(z.string())
            .describe("Placeholder values, e.g. { Name: 'Alice', Company: 'Acme' }"),
    }))
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
}, withErrorHandling(({ recipients, subject, body, account, delayMs }) => {
    const results = mailManager.sendSerialEmail(recipients, subject, body, account, delayMs);
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;
    const details = results
        .map((r) => `  - ${r.email}: ${r.success ? "sent" : `FAILED (${r.error})`}`)
        .join("\n");
    if (failCount === 0) {
        return successResponse(`Successfully sent ${successCount} email(s):\n${details}`);
    }
    else if (successCount === 0) {
        return errorResponse(`Failed to send all ${failCount} email(s):\n${details}`);
    }
    else {
        return successResponse(`Sent ${successCount} of ${results.length} email(s), ${failCount} failed:\n${details}`);
    }
}, "Error sending serial emails"));
// --- create-draft ---
server.tool("create-draft", "Use when: composing an email the user should review in Mail.app before sending — the safe default for any new message (to/cc/bcc are arrays, optional attachments).\nReturns: a confirmation that the draft was created, with recipients and attachment count.\nDo not use when: the user has already confirmed they want it sent now (use send-email).\nSafety: low risk — creates a draft only and sends nothing; the user must open Mail.app and send it themselves.", {
    to: z.array(z.string()).min(1, "At least one recipient is required"),
    subject: z.string().min(1, "Subject is required"),
    body: z.string().min(1, "Body is required"),
    cc: z.array(z.string()).optional().describe("CC recipients"),
    bcc: z.array(z.string()).optional().describe("BCC recipients"),
    account: z.string().optional().describe("Account to create draft in"),
    attachments: ATTACHMENTS_SCHEMA,
}, withErrorHandling(({ to, subject, body, cc, bcc, account, attachments }) => {
    const success = mailManager.createDraft(to, subject, body, cc, bcc, account, attachments);
    if (!success) {
        return errorResponse("Failed to create draft. Check Mail.app configuration.");
    }
    const attachInfo = attachments?.length ? ` with ${attachments.length} attachment(s)` : "";
    return successResponse(`Draft created for ${to.join(", ")}${attachInfo}`);
}, "Error creating draft"));
// --- reply-to-message ---
server.tool("reply-to-message", "Use when: replying to an existing message by id, preserving its threading headers. Set replyAll for all recipients; set send=false to save as a draft instead of sending.\nReturns: a confirmation that the reply was sent or saved as a draft.\nDo not use when: composing a brand-new message (use send-email / create-draft) or forwarding to new recipients (use forward-message).\nSafety: with the default send=true this SENDS real email immediately and cannot be unsent — require explicit user confirmation of the recipients and body, or pass send=false to let the user review.", {
    id: MESSAGE_ID_SCHEMA,
    body: z.string().min(1, "Reply body is required"),
    replyAll: z.boolean().optional().default(false).describe("Reply to all recipients"),
    send: z.boolean().optional().default(true).describe("Send immediately (false = save as draft)"),
}, withErrorHandling(({ id, body, replyAll, send }) => {
    const success = mailManager.replyToMessage(id, body, replyAll, send);
    if (!success) {
        return errorResponse(`Failed to reply to message "${id}"`);
    }
    return successResponse(send ? "Reply sent" : "Reply saved as draft");
}, "Error replying to message"));
// --- forward-message ---
server.tool("forward-message", "Use when: forwarding an existing message (by id) to new recipients (to is an array), with an optional body to prepend. Set send=false to save as a draft.\nReturns: a confirmation that the message was forwarded or saved as a draft.\nDo not use when: replying to the sender/recipients (use reply-to-message) or composing a new message (use send-email / create-draft).\nSafety: with the default send=true this SENDS real email immediately and cannot be unsent — require explicit user confirmation of the recipients and any prepended body, or pass send=false to let the user review.", {
    id: MESSAGE_ID_SCHEMA,
    to: z.array(z.string()).min(1, "At least one recipient is required"),
    body: z.string().optional().describe("Optional message to prepend"),
    send: z.boolean().optional().default(true).describe("Send immediately (false = save as draft)"),
}, withErrorHandling(({ id, to, body, send }) => {
    const success = mailManager.forwardMessage(id, to, body, send);
    if (!success) {
        return errorResponse(`Failed to forward message "${id}"`);
    }
    return successResponse(send ? `Message forwarded to ${to.join(", ")}` : "Forward saved as draft");
}, "Error forwarding message"));
// --- mark-as-read ---
server.tool("mark-as-read", "Use when: marking a single message (by id) as read.\nReturns: a confirmation that the message was marked read.\nDo not use when: marking several at once (use batch-mark-as-read) or marking unread (use mark-as-unread). Get the id from search-messages or list-messages first.", {
    id: MESSAGE_ID_SCHEMA,
}, withErrorHandling(({ id }) => routeMessage(id, {
    imap: () => imapMarkRead(id),
    apple: () => mailManager.markAsRead(id)
        ? successResponse("Message marked as read")
        : errorResponse(`Failed to mark message "${id}" as read`),
    ok: "Message marked as read",
    fail: `Failed to mark message "${id}" as read`,
}), "Error marking message as read"));
// --- mark-as-unread ---
server.tool("mark-as-unread", "Use when: marking a single message (by id) as unread.\nReturns: a confirmation that the message was marked unread.\nDo not use when: marking several at once (use batch-mark-as-unread) or marking read (use mark-as-read). Get the id from search-messages or list-messages first.", {
    id: MESSAGE_ID_SCHEMA,
}, withErrorHandling(({ id }) => routeMessage(id, {
    imap: () => imapMarkUnread(id),
    apple: () => mailManager.markAsUnread(id)
        ? successResponse("Message marked as unread")
        : errorResponse(`Failed to mark message "${id}" as unread`),
    ok: "Message marked as unread",
    fail: `Failed to mark message "${id}" as unread`,
}), "Error marking message as unread"));
// --- flag-message ---
server.tool("flag-message", "Use when: flagging a single message (by id).\nReturns: a confirmation that the message was flagged.\nDo not use when: flagging several at once (use batch-flag-messages) or removing a flag (use unflag-message). Get the id from search-messages or list-messages first.", {
    id: MESSAGE_ID_SCHEMA,
}, withErrorHandling(({ id }) => routeMessage(id, {
    imap: () => imapFlagMessage(id),
    apple: () => mailManager.flagMessage(id)
        ? successResponse("Message flagged")
        : errorResponse(`Failed to flag message "${id}"`),
    ok: "Message flagged",
    fail: `Failed to flag message "${id}"`,
}), "Error flagging message"));
// --- unflag-message ---
server.tool("unflag-message", "Use when: removing the flag from a single message (by id).\nReturns: a confirmation that the message was unflagged.\nDo not use when: unflagging several at once (use batch-unflag-messages) or adding a flag (use flag-message). Get the id from search-messages or list-messages first.", {
    id: MESSAGE_ID_SCHEMA,
}, withErrorHandling(({ id }) => routeMessage(id, {
    imap: () => imapUnflagMessage(id),
    apple: () => mailManager.unflagMessage(id)
        ? successResponse("Message unflagged")
        : errorResponse(`Failed to unflag message "${id}"`),
    ok: "Message unflagged",
    fail: `Failed to unflag message "${id}"`,
}), "Error unflagging message"));
// --- delete-message ---
server.tool("delete-message", "Use when: deleting a single message by id (moves it to Trash).\nReturns: a confirmation that the message was deleted.\nDo not use when: deleting several at once (use batch-delete-messages) or just filing it away (use move-message).\nSafety: destructive — require explicit user confirmation, and search-messages/list-messages first to confirm you have the right id before deleting.", {
    id: MESSAGE_ID_SCHEMA,
}, withErrorHandling(({ id }) => routeMessage(id, {
    imap: () => imapDeleteMessageById(id),
    apple: () => {
        const { success, error } = mailManager.deleteMessage(id);
        return success
            ? successResponse("Message deleted")
            : errorResponse(error || `Failed to delete message "${id}"`);
    },
    ok: "Message deleted",
    fail: `Failed to delete message "${id}"`,
}), "Error deleting message"));
// --- move-message ---
server.tool("move-message", "Use when: moving a single message (by id) into another mailbox/folder, e.g. archiving or filing.\nReturns: a confirmation naming the destination mailbox.\nDo not use when: moving several at once (use batch-move-messages) or deleting (use delete-message). Use list-mailboxes to confirm the destination name exists.\nSafety: moves a real message between folders — confirm the destination mailbox, and search-messages/list-messages first to confirm the id.", {
    id: MESSAGE_ID_SCHEMA,
    mailbox: z.string().min(1, "Destination mailbox is required"),
    account: z.string().optional().describe("Account containing the destination mailbox"),
}, withErrorHandling(({ id, mailbox, account }) => routeMessage(id, {
    imap: () => imapMoveMessageById(id, mailbox),
    apple: () => {
        const { success, error } = mailManager.moveMessage(id, mailbox, account);
        return success
            ? successResponse(`Message moved to "${mailbox}"`)
            : errorResponse(error || `Failed to move message to "${mailbox}"`);
    },
    ok: `Message moved to "${mailbox}"`,
    fail: `Failed to move message to "${mailbox}"`,
}), "Error moving message"));
// --- batch-delete-messages ---
server.tool("batch-delete-messages", "Use when: deleting multiple messages in one call (1–100 ids; moves them to Trash).\nReturns: counts of how many were deleted and how many failed.\nDo not use when: deleting just one (use delete-message) or filing messages away (use batch-move-messages).\nSafety: destructive and applies to many messages at once — require explicit user confirmation, and search-messages/list-messages first to confirm every id is correct before deleting.", {
    ids: BATCH_IDS_SCHEMA,
}, withErrorHandling(async ({ ids }) => {
    const { success: successCount, fail: failCount } = await hybridBatchCounts(ids, (n) => mailManager.batchDeleteMessages(n), (im) => imapBatchDelete(im));
    if (failCount === 0) {
        return successResponse(`Successfully deleted ${successCount} message(s)`);
    }
    else if (successCount === 0) {
        return errorResponse(`Failed to delete all ${failCount} message(s)`);
    }
    else {
        return successResponse(`Deleted ${successCount} message(s), ${failCount} failed`);
    }
}, "Error batch deleting messages"));
// --- batch-move-messages ---
server.tool("batch-move-messages", "Use when: moving multiple messages (1–100 ids) into the same destination mailbox/folder in one call, e.g. bulk archiving.\nReturns: counts of how many were moved and how many failed.\nDo not use when: moving just one (use move-message) or deleting (use batch-delete-messages). Use list-mailboxes to confirm the destination name exists.\nSafety: moves many real messages at once — confirm the destination mailbox, and search-messages/list-messages first to confirm the ids.", {
    ids: BATCH_IDS_SCHEMA,
    mailbox: z.string().min(1, "Destination mailbox is required"),
    account: z.string().optional().describe("Account containing the destination mailbox"),
}, withErrorHandling(async ({ ids, mailbox, account }) => {
    const { success: successCount, fail: failCount } = await hybridBatchCounts(ids, (n) => mailManager.batchMoveMessages(n, mailbox, account), (im) => imapBatchMove(im, mailbox, { account }));
    if (failCount === 0) {
        return successResponse(`Successfully moved ${successCount} message(s) to "${mailbox}"`);
    }
    else if (successCount === 0) {
        return errorResponse(`Failed to move all ${failCount} message(s)`);
    }
    else {
        return successResponse(`Moved ${successCount} message(s) to "${mailbox}", ${failCount} failed`);
    }
}, "Error batch moving messages"));
// --- batch-mark-as-read ---
server.tool("batch-mark-as-read", "Use when: marking multiple messages (1–100 ids) as read in one call.\nReturns: counts of how many were marked read and how many failed.\nDo not use when: marking just one (use mark-as-read) or marking unread (use batch-mark-as-unread). Get the ids from search-messages or list-messages first.", {
    ids: BATCH_IDS_SCHEMA,
}, withErrorHandling(async ({ ids }) => {
    const { success: successCount, fail: failCount } = await hybridBatchCounts(ids, (n) => mailManager.batchMarkAsRead(n), (im) => imapBatchMarkRead(im));
    if (failCount === 0) {
        return successResponse(`Successfully marked ${successCount} message(s) as read`);
    }
    else if (successCount === 0) {
        return errorResponse(`Failed to mark all ${failCount} message(s) as read`);
    }
    else {
        return successResponse(`Marked ${successCount} message(s) as read, ${failCount} failed`);
    }
}, "Error batch marking messages as read"));
// --- batch-mark-as-unread ---
server.tool("batch-mark-as-unread", "Use when: marking multiple messages (1–100 ids) as unread in one call.\nReturns: counts of how many were marked unread and how many failed.\nDo not use when: marking just one (use mark-as-unread) or marking read (use batch-mark-as-read). Get the ids from search-messages or list-messages first.", {
    ids: BATCH_IDS_SCHEMA,
}, withErrorHandling(async ({ ids }) => {
    const { success: successCount, fail: failCount } = await hybridBatchCounts(ids, (n) => mailManager.batchMarkAsUnread(n), (im) => imapBatchMarkUnread(im));
    if (failCount === 0) {
        return successResponse(`Successfully marked ${successCount} message(s) as unread`);
    }
    else if (successCount === 0) {
        return errorResponse(`Failed to mark all ${failCount} message(s) as unread`);
    }
    else {
        return successResponse(`Marked ${successCount} message(s) as unread, ${failCount} failed`);
    }
}, "Error batch marking messages as unread"));
// --- batch-flag-messages ---
server.tool("batch-flag-messages", "Use when: flagging multiple messages (1–100 ids) in one call.\nReturns: counts of how many were flagged and how many failed.\nDo not use when: flagging just one (use flag-message) or removing flags (use batch-unflag-messages). Get the ids from search-messages or list-messages first.", {
    ids: BATCH_IDS_SCHEMA,
}, withErrorHandling(async ({ ids }) => {
    const { success: successCount, fail: failCount } = await hybridBatchCounts(ids, (n) => mailManager.batchFlagMessages(n), (im) => imapBatchFlag(im));
    if (failCount === 0) {
        return successResponse(`Successfully flagged ${successCount} message(s)`);
    }
    else if (successCount === 0) {
        return errorResponse(`Failed to flag all ${failCount} message(s)`);
    }
    else {
        return successResponse(`Flagged ${successCount} message(s), ${failCount} failed`);
    }
}, "Error batch flagging messages"));
// --- batch-unflag-messages ---
server.tool("batch-unflag-messages", "Use when: removing flags from multiple messages (1–100 ids) in one call.\nReturns: counts of how many were unflagged and how many failed.\nDo not use when: unflagging just one (use unflag-message) or adding flags (use batch-flag-messages). Get the ids from search-messages or list-messages first.", {
    ids: BATCH_IDS_SCHEMA,
}, withErrorHandling(async ({ ids }) => {
    const { success: successCount, fail: failCount } = await hybridBatchCounts(ids, (n) => mailManager.batchUnflagMessages(n), (im) => imapBatchUnflag(im));
    if (failCount === 0) {
        return successResponse(`Successfully unflagged ${successCount} message(s)`);
    }
    else if (successCount === 0) {
        return errorResponse(`Failed to unflag all ${failCount} message(s)`);
    }
    else {
        return successResponse(`Unflagged ${successCount} message(s), ${failCount} failed`);
    }
}, "Error batch unflagging messages"));
// --- list-attachments ---
server.tool("list-attachments", "Use when: enumerating a message's attachments (by id) to discover their names, MIME types, and sizes — typically before saving or fetching one.\nReturns: each attachment's name, MIME type, and size, plus a count.\nDo not use when: you want the bytes (use fetch-attachment for inline base64, or save-attachment to write to disk). Get the message id from search-messages or list-messages first.", {
    id: MESSAGE_ID_SCHEMA,
}, withErrorHandling(async ({ id }) => {
    // IMAP (I1): BODYSTRUCTURE enumerates parts (incl. MIME attachments
    // AppleScript can't see) without downloading the message.
    const attachments = id.startsWith("imap:")
        ? await (async () => {
            const r = await imapListAttachments(id);
            if (!r.success)
                throw new Error(r.error || "Failed to list attachments via IMAP");
            return r.attachments ?? [];
        })()
        : mailManager.listAttachments(id);
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
    return successResponse(`Found ${attachments.length} attachment(s):\n${attachmentList}`, structured);
}, "Error listing attachments"));
// --- save-attachment ---
server.tool("save-attachment", "Use when: writing one of a message's attachments to disk, by message id and attachmentName, into the savePath directory (saved as savePath/attachmentName).\nReturns: a confirmation of the saved file path.\nDo not use when: you don't know the attachment name (use list-attachments first) or want the bytes inline rather than on disk (use fetch-attachment).\nSafety: writes a file to disk — savePath must be a directory inside the configured allowed roots, and attachmentName may not contain path separators or '..'; calls outside those constraints are rejected.", {
    id: MESSAGE_ID_SCHEMA,
    attachmentName: z.string().min(1, "Attachment name is required"),
    savePath: z.string().min(1, "Save directory path is required"),
}, withErrorHandling(async ({ id, attachmentName, savePath }) => {
    // IMAP (I1): fetch the part's bytes via IMAP, then write into savePath (a
    // directory) as savePath/attachmentName — mirroring the AppleScript path,
    // with the same name + allowed-roots validation.
    if (id.startsWith("imap:")) {
        if (/[/\\\0]/.test(attachmentName) || attachmentName.includes("..")) {
            return errorResponse(`Invalid attachment name: "${attachmentName}"`);
        }
        const resolvedDir = resolvePath(savePath);
        if (!isPathWithinAllowedRoots(resolvedDir)) {
            return errorResponse(`Save path "${savePath}" is outside allowed directories`);
        }
        const r = await imapFetchAttachment(id, attachmentName);
        if (!r.success || !r.base64) {
            return errorResponse(r.error || `Failed to fetch attachment "${attachmentName}"`);
        }
        writeFileSync(joinPath(resolvedDir, attachmentName), Buffer.from(r.base64, "base64"));
        return successResponse(`Attachment "${attachmentName}" saved to ${savePath}`);
    }
    const success = mailManager.saveAttachment(id, attachmentName, savePath);
    if (!success) {
        return errorResponse(`Failed to save attachment "${attachmentName}"`);
    }
    return successResponse(`Attachment "${attachmentName}" saved to ${savePath}`);
}, "Error saving attachment"));
// --- fetch-attachment ---
server.tool("fetch-attachment", "Use when: retrieving an attachment's raw bytes inline as base64 (by message id and attachmentName), e.g. to process its contents without touching disk.\nReturns: the attachment's bytes base64-encoded, with its size and (for IMAP) MIME type.\nDo not use when: you don't know the attachment name (use list-attachments first) or you just want it saved to disk (use save-attachment).", {
    id: MESSAGE_ID_SCHEMA,
    attachmentName: z.string().min(1, "Attachment name is required"),
}, withErrorHandling(async ({ id, attachmentName }) => {
    // Returns the attachment bytes as base64 (B4) — the read counterpart to
    // sending inline base64 content. IMAP (I1) fetches the part directly; numeric
    // ids fall back to the AppleScript/MIME path.
    if (id.startsWith("imap:")) {
        const r = await imapFetchAttachment(id, attachmentName);
        if (!r.success || !r.base64) {
            return errorResponse(r.error || `Failed to fetch attachment "${attachmentName}"`);
        }
        return successResponse(`Fetched "${attachmentName}" (${r.bytes} bytes, base64-encoded below).\n\n${r.base64}`, { attachmentName, bytes: r.bytes, mimeType: r.mimeType, contentBase64: r.base64 });
    }
    const r = mailManager.getAttachmentBase64(id, attachmentName);
    if (!r.success) {
        return errorResponse(r.error || `Failed to fetch attachment "${attachmentName}"`);
    }
    return successResponse(`Fetched "${attachmentName}" (${r.bytes} bytes, base64-encoded below).\n\n${r.base64}`, { attachmentName, bytes: r.bytes, contentBase64: r.base64 });
}, "Error fetching attachment"));
// =============================================================================
// Mailbox Tools
// =============================================================================
// --- list-mailboxes ---
server.tool("list-mailboxes", "Use when: discovering the mailbox/folder names (and unread/message counts) available in an account, e.g. before moving messages or searching a specific mailbox.\nReturns: each mailbox's name with its unread (and, for IMAP, total message) count, plus a count.\nDo not use when: you want the messages inside a mailbox (use list-messages or search-messages) or the list of accounts (use list-accounts).", {
    account: z.string().optional().describe("Account to list mailboxes from"),
}, withErrorHandling(async ({ account }) => {
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
        if (boxes.length === 0)
            return successResponse("No mailboxes found", structured);
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
}, "Error listing mailboxes"));
// --- get-unread-count ---
server.tool("get-unread-count", "Use when: you only need the number of unread messages (optionally scoped to one mailbox and/or account), without listing the messages themselves.\nReturns: the unread count for the requested scope.\nDo not use when: you need the actual unread messages and their ids (use list-messages with unreadOnly, or search-messages with isRead=false) or broader totals (use get-mail-stats).", {
    mailbox: z.string().optional().describe("Mailbox to check (default: all)"),
    account: z.string().optional().describe("Account to check"),
}, withErrorHandling(async ({ mailbox, account }) => {
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
}, "Error getting unread count"));
// --- create-mailbox ---
server.tool("create-mailbox", "Use when: creating a new mailbox/folder in an account.\nReturns: a confirmation that the mailbox was created.\nDo not use when: renaming an existing one (use rename-mailbox) or deleting one (use delete-mailbox). Use list-mailboxes to see what already exists.\nSafety: creates a real folder in the mail account — confirm the name and target account first.", {
    name: z.string().min(1, "Mailbox name is required"),
    account: z.string().optional().describe("Account to create the mailbox in"),
}, withErrorHandling(async ({ name, account }) => {
    // IMAP backend (issue #43, Phase 2): server-side folder op when this account
    // is IMAP-configured; otherwise AppleScript.
    if (isImapAccount(account)) {
        const r = await imapCreateMailbox(name, { account });
        if (!r.success)
            return errorResponse(r.error || `Failed to create mailbox "${name}"`);
        return successResponse(r.info || `Mailbox "${name}" created`);
    }
    const success = mailManager.createMailbox(name, account);
    if (!success) {
        return errorResponse(`Failed to create mailbox "${name}"`);
    }
    return successResponse(`Mailbox "${name}" created`);
}, "Error creating mailbox"));
// --- delete-mailbox ---
server.tool("delete-mailbox", "Use when: deleting a mailbox/folder from an account.\nReturns: a confirmation that the mailbox was deleted.\nDo not use when: renaming it (use rename-mailbox) or deleting messages within it (use delete-message / batch-delete-messages).\nSafety: destructive — deleting a mailbox removes the folder and any messages it contains. Require explicit user confirmation and use list-mailboxes first to confirm the exact name.", {
    name: z.string().min(1, "Mailbox name is required"),
    account: z.string().optional().describe("Account containing the mailbox"),
}, withErrorHandling(async ({ name, account }) => {
    if (isImapAccount(account)) {
        const r = await imapDeleteMailbox(name, { account });
        if (!r.success)
            return errorResponse(r.error || `Failed to delete mailbox "${name}"`);
        return successResponse(r.info || `Mailbox "${name}" deleted`);
    }
    const { success, error } = mailManager.deleteMailbox(name, account);
    if (!success) {
        return errorResponse(error || `Failed to delete mailbox "${name}"`);
    }
    return successResponse(`Mailbox "${name}" deleted`);
}, "Error deleting mailbox"));
// --- rename-mailbox ---
server.tool("rename-mailbox", "Use when: renaming an existing mailbox/folder from oldName to newName within an account.\nReturns: a confirmation naming the old and new mailbox names.\nDo not use when: creating a new folder (use create-mailbox) or deleting one (use delete-mailbox). Use list-mailboxes to confirm the current name.\nSafety: renames a real folder in the mail account — confirm oldName matches exactly (case-sensitive) before calling.", {
    oldName: z.string().min(1, "Current mailbox name is required"),
    newName: z.string().min(1, "New mailbox name is required"),
    account: z.string().optional().describe("Account containing the mailbox"),
}, withErrorHandling(async ({ oldName, newName, account }) => {
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
}, "Error renaming mailbox"));
// =============================================================================
// Account Tools
// =============================================================================
// --- list-accounts ---
server.tool("list-accounts", "Use when: discovering the configured Mail accounts (e.g. iCloud, Gmail) so you can pass an exact account name to other tools.\nReturns: the account names and a count.\nDo not use when: you want the folders within an account (use list-mailboxes) or messages (use list-messages / search-messages).", {}, withErrorHandling(() => {
    const accounts = mailManager.listAccounts();
    const structured = { accounts, count: accounts.length };
    if (accounts.length === 0) {
        return successResponse("No Mail accounts found", structured);
    }
    const accountList = accounts.map((a) => `  - ${a.name}`).join("\n");
    return successResponse(`Found ${accounts.length} account(s):\n${accountList}`, structured);
}, "Error listing accounts"));
// =============================================================================
// Mail Rules Tools
// =============================================================================
// --- list-rules ---
server.tool("list-rules", "Use when: discovering the Mail rules that exist and whether each is enabled or disabled, e.g. before enabling/disabling/deleting one.\nReturns: each rule's name and enabled/disabled state.\nDo not use when: you want to change a rule (use enable-rule / disable-rule / create-rule / delete-rule).", {}, withErrorHandling(() => {
    const rules = mailManager.listRules();
    if (rules.length === 0) {
        return successResponse("No mail rules found");
    }
    const ruleList = rules
        .map((r) => `  - ${r.name} [${r.enabled ? "enabled" : "disabled"}]`)
        .join("\n");
    return successResponse(`Found ${rules.length} rule(s):\n${ruleList}`);
}, "Error listing rules"));
// --- enable-rule ---
server.tool("enable-rule", "Use when: turning on an existing Mail rule by name.\nReturns: a confirmation that the rule was enabled.\nDo not use when: turning a rule off (use disable-rule), creating one (use create-rule), or deleting one (use delete-rule). Use list-rules to confirm the exact rule name.", {
    name: z.string().min(1, "Rule name is required"),
}, withErrorHandling(({ name }) => {
    const success = mailManager.setRuleEnabled(name, true);
    if (!success) {
        return errorResponse(`Failed to enable rule "${name}"`);
    }
    return successResponse(`Rule "${name}" enabled`);
}, "Error enabling rule"));
// --- disable-rule ---
server.tool("disable-rule", "Use when: turning off an existing Mail rule by name (without deleting it).\nReturns: a confirmation that the rule was disabled.\nDo not use when: turning a rule on (use enable-rule), creating one (use create-rule), or removing it permanently (use delete-rule). Use list-rules to confirm the exact rule name.", {
    name: z.string().min(1, "Rule name is required"),
}, withErrorHandling(({ name }) => {
    const success = mailManager.setRuleEnabled(name, false);
    if (!success) {
        return errorResponse(`Failed to disable rule "${name}"`);
    }
    return successResponse(`Rule "${name}" disabled`);
}, "Error disabling rule"));
// --- create-rule ---
server.tool("create-rule", "Use when: creating a new Mail rule with one or more conditions (field/operator/value) and at least one action (markRead, markFlagged, delete, or moveTo). Set matchAll to require all conditions vs. any.\nReturns: a confirmation naming the rule and its condition count.\nDo not use when: toggling an existing rule (use enable-rule / disable-rule) or removing one (use delete-rule). Use list-rules to avoid duplicating an existing rule.\nSafety: creates a rule that automatically acts on real mail (including delete/move actions) on an ongoing basis — confirm the conditions and actions with the user before calling.", {
    name: z.string().min(1, "Rule name is required"),
    conditions: z
        .array(z.object({
        field: z.enum(["from", "to", "cc", "subject", "content"]),
        operator: z
            .enum(["contains", "notContains", "equals", "beginsWith", "endsWith"])
            .default("contains"),
        value: z.string().min(1, "Condition value is required"),
    }))
        .min(1, "At least one condition is required"),
    actions: z
        .object({
        markRead: z.boolean().optional(),
        markFlagged: z.boolean().optional(),
        delete: z.boolean().optional(),
        moveTo: z.string().optional(),
        moveToAccount: z.string().optional(),
    })
        .refine((a) => a.markRead || a.markFlagged || a.delete || a.moveTo, "At least one action is required (markRead, markFlagged, delete, or moveTo)"),
    matchAll: z.boolean().default(true),
    enabled: z.boolean().default(true),
}, withErrorHandling((args) => {
    const result = mailManager.createRule(args);
    if (!result.success) {
        return errorResponse(`Failed to create rule "${args.name}": ${result.error}`);
    }
    return successResponse(`Rule "${args.name}" created with ${args.conditions.length} condition(s).`, { name: args.name, created: true });
}, "Error creating rule"));
// --- delete-rule ---
server.tool("delete-rule", "Use when: permanently removing a Mail rule by name.\nReturns: a confirmation that the rule was deleted.\nDo not use when: you only want to pause it (use disable-rule) or create one (use create-rule).\nSafety: destructive — the rule is removed permanently. Require explicit user confirmation and use list-rules first to confirm the exact name.", {
    name: z.string().min(1, "Rule name is required"),
}, withErrorHandling(({ name }) => {
    const success = mailManager.deleteRule(name);
    if (!success) {
        return errorResponse(`Failed to delete rule "${name}" (not found?)`);
    }
    return successResponse(`Rule "${name}" deleted`, { name, deleted: true });
}, "Error deleting rule"));
// =============================================================================
// Contacts Tools
// =============================================================================
// --- search-contacts ---
server.tool("search-contacts", "Use when: looking up a person in Contacts.app by name to find their email address(es) before composing or sending mail.\nReturns: matching contacts with their names and email addresses.\nDo not use when: searching email messages (use search-messages) — this queries Contacts, not the mailbox.", {
    query: z.string().min(1, "Search query is required"),
}, withErrorHandling(({ query }) => {
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
}, "Error searching contacts"));
// =============================================================================
// Email Template Tools
// =============================================================================
// --- save-template ---
server.tool("save-template", "Use when: creating a reusable email template (name, subject, body, optional default to/cc), or updating one by passing its existing id. Subject/body may contain placeholders for later use.\nReturns: the saved template's name and id (reuse the id with use-template / get-template / delete-template).\nDo not use when: composing a one-off message (use create-draft / send-email) or filling in a template to send (use use-template).\nSafety: writes the template to the on-disk templates store (APPLE_MAIL_MCP_TEMPLATES_FILE) and persists across restarts; passing an existing id overwrites that template.", {
    name: z.string().min(1, "Template name is required"),
    subject: z.string().min(1, "Subject is required"),
    body: z.string().min(1, "Body is required"),
    to: z.array(z.string()).optional().describe("Default recipients"),
    cc: z.array(z.string()).optional().describe("Default CC recipients"),
    id: z.string().optional().describe("Template ID (for updating existing template)"),
}, withErrorHandling(({ name, subject, body, to, cc, id }) => {
    const template = mailManager.saveTemplate(name, subject, body, to, cc, id);
    return successResponse(`Template "${template.name}" saved with ID: ${template.id}`);
}, "Error saving template"));
// --- list-templates ---
server.tool("list-templates", "Use when: discovering the saved email templates and their ids, e.g. before using or editing one.\nReturns: each template's id, name, and subject.\nDo not use when: you want a single template's full body (use get-template) or want to apply one (use use-template).", {}, withErrorHandling(() => {
    const templates = mailManager.listTemplates();
    if (templates.length === 0) {
        return successResponse("No templates saved");
    }
    const templateList = templates
        .map((t) => `  - [${t.id}] ${t.name} — "${t.subject}"`)
        .join("\n");
    return successResponse(`Found ${templates.length} template(s):\n${templateList}`);
}, "Error listing templates"));
// --- get-template ---
server.tool("get-template", "Use when: reading the full contents of one saved template by id — its name, subject, default to/cc, and body.\nReturns: the template's name, subject, default recipients, and body text.\nDo not use when: you don't have the id (use list-templates first) or want to apply the template into a draft (use use-template).", {
    id: z.string().min(1, "Template ID is required"),
}, withErrorHandling(({ id }) => {
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
}, "Error getting template"));
// --- delete-template ---
server.tool("delete-template", "Use when: permanently removing a saved email template by id.\nReturns: a confirmation that the template was deleted.\nDo not use when: you only want to view it (use get-template) or update it (use save-template with the existing id).\nSafety: destructive — removes the template from the on-disk store permanently. Require explicit user confirmation and use list-templates first to confirm the id.", {
    id: z.string().min(1, "Template ID is required"),
}, withErrorHandling(({ id }) => {
    const success = mailManager.deleteTemplate(id);
    if (!success) {
        return errorResponse(`Template "${id}" not found`);
    }
    return successResponse(`Template "${id}" deleted`);
}, "Error deleting template"));
// --- use-template ---
server.tool("use-template", "Use when: composing a new draft from a saved template (by id), optionally overriding the recipients, subject, or body. Creates a draft in Mail.app for the user to review and send.\nReturns: a confirmation that a draft was created from the template.\nDo not use when: you want to inspect the template without composing (use get-template) or send immediately without a draft (use send-email).", {
    id: z.string().min(1, "Template ID is required"),
    to: z.array(z.string()).optional().describe("Override recipients"),
    cc: z.array(z.string()).optional().describe("Override CC recipients"),
    subject: z.string().optional().describe("Override subject"),
    body: z.string().optional().describe("Override body"),
}, withErrorHandling(({ id, to, cc, subject, body }) => {
    const success = mailManager.useTemplate(id, { to, cc, subject, body });
    if (!success) {
        return errorResponse(`Failed to use template "${id}". Template not found or no recipients.`);
    }
    return successResponse(`Draft created from template "${id}"`);
}, "Error using template"));
// =============================================================================
// Diagnostics Tools
// =============================================================================
// --- health-check ---
server.tool("health-check", "Use when: doing a quick check that Mail.app is reachable and the server's basic checks pass.\nReturns: an overall healthy/unhealthy status with a pass/fail line per check.\nDo not use when: you need detailed permission/account/IMAP/SMTP diagnostics with remediation steps (use doctor).", {}, withErrorHandling(() => {
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
}, "Error running health check"));
// --- doctor ---
server.tool("doctor", "Use when: troubleshooting setup problems — diagnoses Mail.app automation permissions, account state, and the IMAP/SMTP backends with actionable remediation messages.\nReturns: a detailed diagnostic report (formatted text plus structured checks).\nDo not use when: you just want a quick up/down status (use health-check) or message counts (use get-mail-stats).", {}, withErrorHandling(async () => {
    // Diagnoses Mail.app permission, account state, and the IMAP/SMTP backends
    // with actionable messages (C3). structuredContent carries the raw checks.
    const report = await runDoctor(mailManager);
    return successResponse(formatDoctorReport(report), { ...report });
}, "Error running doctor"));
// --- get-mail-stats ---
server.tool("get-mail-stats", "Use when: you want aggregate mailbox statistics — total and unread message counts, recently-received counts (last 24h/7d/30d), and (for the all-accounts path) a per-account breakdown.\nReturns: totals, unread counts, recent-activity counts, and per-account figures.\nDo not use when: you only need a single unread number (use get-unread-count) or want to list the messages themselves (use list-messages / search-messages).", {
    account: z
        .string()
        .optional()
        .describe("Limit to one account; uses fast IMAP STATUS if that account is IMAP-configured"),
}, withErrorHandling(async ({ account }) => {
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
    const lines = [];
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
            lines.push(`  ${account.name}: ${account.totalMessages} messages (${account.unreadMessages} unread)`);
        }
    }
    return successResponse(lines.join("\n"), { ...stats });
}, "Error getting mail statistics"));
// --- get-sync-status ---
server.tool("get-sync-status", "Use when: checking whether Mail.app is running and actively syncing, e.g. to explain why new mail hasn't appeared yet.\nReturns: whether Mail.app is running and whether sync activity was detected.\nDo not use when: you need message counts (use get-mail-stats) or a full setup diagnosis (use doctor).", {}, withErrorHandling(() => {
    const status = mailManager.getSyncStatus();
    const lines = [];
    lines.push(`🔄 Mail Sync Status`);
    lines.push(`═══════════════════`);
    if (status.error) {
        lines.push(`Status: ⚠️ ${status.error}`);
    }
    else {
        lines.push(`Mail.app: ${status.recentActivity ? "Running" : "Not running"}`);
        lines.push(`Sync active: ${status.syncDetected ? "Yes" : "No"}`);
    }
    return successResponse(lines.join("\n"), { ...status });
}, "Error getting sync status"));
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
let idleWatcher;
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
    }
    catch (e) {
        console.error(`IMAP IDLE watcher failed to start: ${String(e)}`);
    }
}
// Clean up the long-lived IDLE connections on shutdown.
for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
        void idleWatcher?.stop().finally(() => process.exit(0));
    });
}
