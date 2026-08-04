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
import { AppleMailManager, resolveAttachmentSaveTarget } from "@/services/appleMailManager.js";
import { writeFileSync } from "fs";
import { join as joinPath } from "path";
import {
  sendViaSmtp,
  sendSerialViaSmtp,
  shouldUseSmtp,
  isSmtpConfigured,
  resolveSmtpConfig,
  type SmtpConfig,
} from "@/services/smtpMailer.js";
import {
  buildReplyOptions,
  buildForwardOptions,
  parseOriginalHeaders,
} from "@/services/replyForward.js";
import {
  isImapAccount,
  shouldUseImap,
  resolveImapConfigs,
  dropAllPools,
  imapSearchMessages,
  imapListMessages,
  imapUnreadCount,
  imapListMailboxes,
  imapMailStats,
  imapListAttachments,
  imapFetchAttachment,
  imapBatchMarkRead,
  imapBatchMarkUnread,
  imapBatchFlag,
  imapBatchUnflag,
  imapBatchDelete,
  imapBatchMove,
  imapThread,
  type ImapBatchResult,
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
  imapFetchMessageId,
  decodeImapId,
} from "@/services/imapClient.js";
import {
  successResponse,
  errorResponse,
  partialCoverageBlock,
  withErrorHandling,
  messageSummary,
} from "@/tools/respond.js";
import {
  fanOutImapMessages,
  mergeMessages,
  formatMergedRows,
  partitionAccountsForCounts,
  planCountSources,
  type MessageRow,
} from "@/services/imapMultiAccount.js";
import type { Account, SearchDiagnostics, SearchResult } from "@/types.js";
import { routeMessage } from "@/services/messageRouter.js";
import { runDoctor, formatDoctorReport } from "@/tools/doctor.js";
import { registerResourcesAndPrompts } from "@/tools/resourcesAndPrompts.js";
import {
  isInlineAttachmentBase64WithinLimit,
  MAX_INLINE_ATTACHMENT_BASE64_INPUT_CHARS,
} from "@/utils/attachmentLimits.js";
import { normalizeSubject, subjectFromGetMessage } from "@/tools/thread.js";
import { extractRfcMessageIdFromSource } from "@/utils/mimeParse.js";
import { ImapIdleWatcher } from "@/services/imapIdle.js";
import { loadFileConfig } from "@/services/fileConfig.js";
import { isOrphaned } from "@/utils/orphan.js";

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

/** Apple Mail flag colors → the 0-6 palette index. `grey` is an alias for `gray`.
 *  Works on BOTH routes: AppleScript sets `flag index`, and the IMAP path writes
 *  the same index as the `$MailFlagBit0/1/2` keyword bitfield Mail.app uses on the
 *  wire. `\Flagged` alone is colorless, but the bits ride alongside it, so a smart
 *  mailbox keyed on flag color matches either way. */
const FLAG_COLOR_INDEX: Record<string, number> = {
  red: 0,
  orange: 1,
  yellow: 2,
  green: 3,
  blue: 4,
  purple: 5,
  gray: 6,
  grey: 6,
};
const FLAG_COLOR_SCHEMA = z
  .enum(["red", "orange", "yellow", "green", "blue", "purple", "gray", "grey"])
  .optional()
  .describe(
    "Optional flag color (Apple Mail palette: red, orange, yellow, green, blue, purple, gray — 'grey' accepted). Omit for Mail's default flag. The color is applied on both routes: AppleScript sets the flag index, and IMAP writes the equivalent $MailFlagBit0/1/2 keywords Mail.app reads — so a smart mailbox keyed on flag color matches either way."
  );

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
        filename: z.string().min(1).max(255).describe("Filename to give the attachment"),
        contentBase64: z
          .string()
          .min(1)
          .max(
            MAX_INLINE_ATTACHMENT_BASE64_INPUT_CHARS,
            "Inline attachment exceeds the 25 MiB decoded size limit"
          )
          .refine(
            isInlineAttachmentBase64WithinLimit,
            "Inline attachment exceeds the 25 MiB decoded size limit"
          )
          .describe("Base64-encoded file content (maximum 25 MiB decoded)"),
      }),
    ])
  )
  .max(20, "Cannot attach more than 20 files")
  .optional()
  .describe(
    "Files to attach: absolute paths (e.g. '/Users/me/report.pdf') and/or " +
      "inline {filename, contentBase64} objects up to 25 MiB decoded each."
  );

// =============================================================================
// Shared Output Schemas (MCP outputSchema)
//
// Every tool below declares an MCP `outputSchema` so clients can know and
// validate the output shape. The SDK requires `structuredContent` on every
// success result once an outputSchema is present and validates it against the
// schema, so these schemas are intentionally PERMISSIVE — fields are optional
// unless they are provably always present on every success path, no `.strict()`
// is used (extra keys pass), and rows that vary across the AppleScript and IMAP
// backends use loose element types. Error responses are exempt from validation.
// =============================================================================

/** A message row in a list/search result. Loose: the AppleScript path emits a
 *  messageSummary while the IMAP path emits its own record, so allow any keys. */
const MESSAGE_ROW_SCHEMA = z.object({}).passthrough();

/** Shape returned by list/search style tools (messages + count + optional
 *  partial-coverage diagnostics). Diagnostics only appear on the AppleScript
 *  path, so they are optional. */
const LIST_OUTPUT_SCHEMA = {
  messages: z.array(MESSAGE_ROW_SCHEMA).optional(),
  count: z.number().optional(),
  partial: z.boolean().optional(),
  skippedLargeMailboxes: z.array(z.string()).optional(),
  notSearchedMailboxes: z.array(z.string()).optional(),
  timedOutAccounts: z.array(z.string()).optional(),
};

/** Shape returned by the batch count tools. */
const BATCH_COUNT_OUTPUT_SCHEMA = {
  ok: z.boolean().optional(),
  success: z.number().optional(),
  failed: z.number().optional(),
  mailbox: z.string().optional(),
};

/** A health/doctor check item — loose to accept both health-check
 *  ({name, passed, message}) and doctor ({name, status, detail}) items. */
const CHECK_ITEM_SCHEMA = z.object({}).passthrough();

// Read version from package.json to keep it in sync
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

/** An empty SearchDiagnostics (complete coverage). */
function emptyDiagnostics(): SearchDiagnostics {
  return {
    partial: false,
    timedOutAccounts: [],
    skippedLargeMailboxes: [],
    notSearchedMailboxes: [],
  };
}

/** Merge two diagnostics objects (union the lists, OR the partial flag). */
function mergeDiagnostics(a: SearchDiagnostics, b: SearchDiagnostics): SearchDiagnostics {
  return {
    partial: a.partial || b.partial,
    timedOutAccounts: [...a.timedOutAccounts, ...b.timedOutAccounts],
    skippedLargeMailboxes: [...a.skippedLargeMailboxes, ...b.skippedLargeMailboxes],
    notSearchedMailboxes: [...a.notSearchedMailboxes, ...b.notSearchedMailboxes],
  };
}

/** Result of the partitioned AppleScript scan: structured rows + merged diagnostics. */
interface AppleScan {
  rows: MessageRow[];
  diagnostics: SearchDiagnostics;
}

/**
 * Run a per-account AppleScript scan over ONLY the given accounts (the ones no
 * IMAP config covers), concatenating their rows and merging diagnostics. The IMAP
 * fan-out already covers the IMAP accounts, so this avoids scanning them on the
 * AppleScript side — which, for an all-IMAP user, means ZERO AppleScript work and
 * therefore no reliance on the fragile composite dedup. `scan` runs one account.
 */
function appleScanForAccounts(
  accounts: Account[],
  scan: (accountName: string) => SearchResult
): AppleScan {
  const rows: MessageRow[] = [];
  let diagnostics = emptyDiagnostics();
  for (const acct of accounts) {
    const res = scan(acct.name);
    rows.push(...res.messages.map(messageSummary));
    diagnostics = mergeDiagnostics(diagnostics, res.diagnostics);
  }
  return { rows, diagnostics };
}

/**
 * Build the success response for a no-account, prefer-IMAP MERGED message list
 * (search-messages / list-messages — v2.6.0). Concatenates the IMAP fan-out rows
 * with the (already partitioned) AppleScript rows, de-dups (IMAP copy wins — a
 * safety net for heuristic misses + IMAP-vs-IMAP dupes, no longer load-bearing
 * for matched accounts), sorts newest-first, applies `limit`, and preserves the
 * partial-coverage diagnostics (AppleScript scan + any failed IMAP fan-out).
 *
 * @param verb "matched" (search) or "listed" (list) — only affects empty-state text.
 */
function mergedMessageResponse(
  fan: { rows: MessageRow[]; accountsQueried: string[]; accountsFailed: string[] },
  apple: AppleScan,
  limit: number,
  verb: "matched" | "listed"
) {
  const merged = mergeMessages(fan.rows, apple.rows, limit);
  // Surface IMAP fan-out failures alongside the AppleScript diagnostics so a
  // partial merge is never mistaken for a confirmed "no such mail".
  const diagnostics: SearchDiagnostics = {
    ...apple.diagnostics,
    partial: apple.diagnostics.partial || fan.accountsFailed.length > 0,
    timedOutAccounts: [...apple.diagnostics.timedOutAccounts, ...fan.accountsFailed],
  };
  const structured = {
    messages: merged,
    count: merged.length,
    partial: diagnostics.partial,
    skippedLargeMailboxes: diagnostics.skippedLargeMailboxes,
    notSearchedMailboxes: diagnostics.notSearchedMailboxes,
    timedOutAccounts: diagnostics.timedOutAccounts,
  };
  const coverageBlock = partialCoverageBlock(diagnostics);
  if (merged.length === 0) {
    const base = diagnostics.partial
      ? `No messages found in the portions that were ${verb === "matched" ? "searched" : "listed"}.`
      : "No messages found";
    return successResponse(`${base}${coverageBlock}`, structured);
  }
  const parts: string[] = [];
  if (fan.accountsQueried.length > 0)
    parts.push(`IMAP account(s): ${fan.accountsQueried.join(", ")}`);
  if (apple.rows.length > 0) parts.push("AppleScript");
  const accountsNote = parts.length > 0 ? ` (merged across ${parts.join(" + ")})` : "";
  return successResponse(
    `Found ${merged.length} message(s)${accountsNote}:\n${formatMergedRows(merged)}${coverageBlock}`,
    structured
  );
}

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

/**
 * Split a batch of ids into numeric (AppleScript) and imap: (IMAP) groups, run
 * each path, and merge into success/fail counts (I2). imap: ids apply in a
 * single UID command per mailbox; numeric ids use the existing AppleScript batch.
 */
async function hybridBatchCounts(
  ids: string[],
  appleFn: (numericIds: string[]) => { success: boolean }[],
  imapFn: (imapIds: string[]) => Promise<ImapBatchResult>
): Promise<{ success: number; fail: number; errors: string[] }> {
  const imapIds = ids.filter((i) => i.startsWith("imap:"));
  const numericIds = ids.filter((i) => !i.startsWith("imap:"));
  let success = 0;
  let fail = 0;
  const errors: string[] = [];
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

server.registerTool(
  "search-messages",
  {
    description:
      "Use when: finding messages by query/sender/subject/date/read/flag filters and you need their ids for follow-up operations.\nReturns: matching messages with id, date, subject, sender, and read state (plus partial-coverage diagnostics when some mailboxes were skipped).\nDo not use when: you want a plain mailbox listing without filters (use list-messages), already have an id and want the body (use get-message), or want a whole conversation (use get-thread).\nPrefer this first to obtain the message ids that get-message/mark-as-read/delete-message/move-message and the batch tools require.",
    inputSchema: {
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
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of results (default: 50, max: 500)"),
    },
    outputSchema: LIST_OUTPUT_SCHEMA,
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
      // IMAP backend: prefer direct IMAP whenever IMAP is configured (v2.6.0).
      //   - explicit IMAP account → single-account IMAP (fast path);
      //   - no account + IMAP configured → MERGE: IMAP fans out over every
      //     configured account; AppleScript scans ONLY the accounts no IMAP
      //     config covers (partitioned — so an all-IMAP user runs ZERO
      //     AppleScript and never relies on the composite dedup);
      //   - explicit non-IMAP account (or IMAP unconfigured) → AppleScript below.
      if (shouldUseImap(account)) {
        const imapArgs = {
          query,
          mailbox,
          limit,
          dateFrom,
          dateTo,
          from,
          subject,
          isRead,
          isFlagged,
        };
        if (account !== undefined) {
          const r = await imapSearchMessages({ ...imapArgs, account });
          return successResponse(r.text, {
            messages: r.messages,
            count: r.count,
            partial: r.partial,
          });
        }
        const fan = await fanOutImapMessages(imapArgs, "search");
        const { appleScriptOnly } = partitionAccountsForCounts(
          mailManager.listAccounts(),
          resolveImapConfigs()
        );
        const apple = appleScanForAccounts(appleScriptOnly, (acctName) =>
          mailManager.searchMessagesWithDiagnostics(
            query,
            mailbox,
            acctName,
            limit,
            dateFrom,
            dateTo,
            from,
            subject,
            isRead,
            isFlagged
          )
        );
        return mergedMessageResponse(fan, apple, limit, "matched");
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

server.registerTool(
  "get-message",
  {
    description:
      'Use when: reading the full body of one message whose id you already have (numeric or imap:…); set preferHtml to get the HTML body instead of plain text.\nReturns: the message subject, body (plain text by default, HTML when preferHtml is true), and its stable RFC Message-ID (rfcMessageId) for dedup/threading.\nTip: pass the mailbox+account you got the id from (e.g. from search-messages) to fetch it directly — required for reliable reads of large folders like "Sent Items", which otherwise time out.\nDo not use when: you don\'t yet have an id (use search-messages or list-messages first), or you want the whole conversation (use get-thread).',
    inputSchema: {
      id: MESSAGE_ID_SCHEMA,
      preferHtml: z
        .boolean()
        .optional()
        .describe("Return the HTML body (extracted from the message source) instead of plain text"),
      mailbox: z
        .string()
        .optional()
        .describe(
          'Mailbox that holds the message (e.g. "Sent Items"). Numeric ids are unique per mailbox; supplying this (with account) opens that mailbox directly instead of scanning every mailbox, which is required to read large folders like Sent Items without timing out.'
        ),
      account: z
        .string()
        .optional()
        .describe(
          "Account that holds the message. Pair with `mailbox` for a direct, scan-free fetch."
        ),
    },
    outputSchema: {
      id: z.string().optional(),
      subject: z.string().optional(),
      body: z.string().optional(),
      isHtml: z.boolean().optional(),
      rfcMessageId: z
        .string()
        .optional()
        .describe(
          "Stable RFC 5322 Message-ID (angle brackets stripped); empty when the message has none"
        ),
    },
  },
  withErrorHandling(
    ({ id, preferHtml, mailbox, account }) =>
      routeMessage(id, {
        // IMAP id (imap:…) → fetch via IMAP (#43 Phase 3); else AppleScript.
        imap: () => imapGetMessage(id, preferHtml === true),
        // IMAP path: parse subject/body out of the returned source so the
        // structuredContent matches the AppleScript branch's shape.
        structuredFromResult: (r) => {
          if (!r.info) return undefined;
          const sep = r.info.indexOf("\n\n");
          return {
            id,
            subject: subjectFromGetMessage(r.info),
            body: sep >= 0 ? r.info.slice(sep + 2) : r.info,
            isHtml: preferHtml === true,
            rfcMessageId: extractRfcMessageIdFromSource(r.info),
          };
        },
        apple: () => {
          // Only fetch/parse the raw source when HTML is actually requested (#32).
          // A mailbox+account hint (from the caller, else the id→location index)
          // scopes the fetch so large folders like Sent Items resolve instead of
          // timing out on a full-mailbox scan.
          const content = mailManager.getMessageContent(id, preferHtml === true, {
            account,
            mailbox,
          });
          if (!content) return errorResponse(`Message with ID "${id}" not found`);
          const isHtml = preferHtml === true && !!content.htmlContent;
          const body = isHtml ? content.htmlContent! : content.plainText;
          return successResponse(`Subject: ${content.subject}\n\n${body}`, {
            id,
            subject: content.subject,
            body,
            isHtml,
            rfcMessageId: content.rfcMessageId ?? "",
          });
        },
        ok: "",
        fail: `Message with ID "${id}" not found`,
      }),
    "Error retrieving message"
  )
);

// --- get-thread ---

server.registerTool(
  "get-thread",
  {
    description:
      "Use when: you have one message id and want the whole conversation it belongs to, oldest-first. With an imap: id it threads by References/Message-ID; otherwise it groups by normalized subject.\nReturns: the thread's normalized subject and its messages (id, date, subject, sender, read state).\nDo not use when: you only need the single message (use get-message) or are searching by arbitrary criteria (use search-messages).",
    inputSchema: {
      id: MESSAGE_ID_SCHEMA.describe("A message ID in the conversation (numeric or imap:…)"),
      account: z.string().optional().describe("Account to search (omit to search all)"),
      mailbox: z.string().optional().describe("Mailbox to search (omit to search all)"),
      limit: z.number().optional().describe("Max messages in the thread (default 50)"),
    },
    outputSchema: {
      subject: z.string().optional(),
      messages: z.array(MESSAGE_ROW_SCHEMA).optional(),
      count: z.number().optional(),
      partial: z.boolean().optional(),
    },
  },
  withErrorHandling(async ({ id, account, mailbox, limit = 50 }) => {
    // True threading via References/Message-ID when we have an imap: id (I5);
    // falls through to subject grouping if the server lacks HEADER search or
    // nothing References-linked is found.
    if (id.startsWith("imap:")) {
      const t = await imapThread(id, { account }, limit);
      if (t && t.count > 1) return successResponse(t.text, { ...t.structured });
    }

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

    // IMAP backend: server-side subject search (prefer-IMAP, v2.6.0).
    //   - explicit IMAP account → single-account IMAP subject search;
    //   - no account + IMAP configured → MERGE: IMAP fan-out subject search over
    //     every configured account + AppleScript subject search over ONLY the
    //     accounts no IMAP config covers (partitioned), then re-order oldest-
    //     first for natural thread reading.
    if (shouldUseImap(account)) {
      if (account !== undefined) {
        const r = await imapSearchMessages({ subject: base, mailbox, account, limit });
        return successResponse(`Thread "${base}":\n${r.text}`, {
          subject: base,
          messages: r.messages,
          count: r.count,
          partial: r.partial,
        });
      }
      const fan = await fanOutImapMessages({ subject: base, mailbox, limit }, "search");
      const { appleScriptOnly } = partitionAccountsForCounts(
        mailManager.listAccounts(),
        resolveImapConfigs()
      );
      const apple = appleScanForAccounts(appleScriptOnly, (acctName) =>
        mailManager.searchMessagesWithDiagnostics(
          undefined,
          mailbox,
          acctName,
          limit,
          undefined,
          undefined,
          undefined,
          base
        )
      );
      // Merge + de-dup (IMAP wins), then sort OLDEST-first for thread order.
      const mergedNewestFirst = mergeMessages(fan.rows, apple.rows, limit);
      const orderedRows = mergedNewestFirst
        .slice()
        .reverse() // mergeMessages returns newest-first; threads read oldest-first
        .sort(
          (a, b) =>
            (a.dateReceived ? new Date(a.dateReceived as string).getTime() : 0) -
            (b.dateReceived ? new Date(b.dateReceived as string).getTime() : 0)
        );
      const partial = apple.diagnostics.partial || fan.accountsFailed.length > 0;
      const coverage = partialCoverageBlock({
        ...apple.diagnostics,
        partial,
        timedOutAccounts: [...apple.diagnostics.timedOutAccounts, ...fan.accountsFailed],
      });
      const structured = {
        subject: base,
        messages: orderedRows,
        count: orderedRows.length,
        partial,
      };
      if (orderedRows.length === 0) {
        return successResponse(`No messages found in thread "${base}".${coverage}`, structured);
      }
      return successResponse(
        `Thread "${base}" — ${orderedRows.length} message(s), oldest first:\n${formatMergedRows(orderedRows)}${coverage}`,
        structured
      );
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

server.registerTool(
  "list-messages",
  {
    description:
      "Use when: browsing a mailbox's recent messages (optionally filtered by sender or unread-only) with pagination via limit/offset, and you need their ids.\nReturns: messages with id, date, subject, and sender (plus partial-coverage diagnostics when some mailboxes were skipped).\nDo not use when: you have specific search criteria like subject/date/flags (use search-messages) or already have an id and want the body (use get-message).\nLike search-messages, use this to obtain the ids that read/mark/delete/move and batch tools require.",
    inputSchema: {
      mailbox: z
        .string()
        .optional()
        .describe("Mailbox to list messages from. Omit to list from all mailboxes."),
      account: z.string().optional().describe("Account to list messages from"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of messages (default: 50, max: 500)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of messages to skip (for pagination)"),
      from: z.string().optional().describe("Filter by sender email address or name"),
      unreadOnly: z.boolean().optional().describe("Only show unread messages"),
    },
    outputSchema: LIST_OUTPUT_SCHEMA,
  },
  withErrorHandling(async ({ mailbox, account, limit = 50, offset = 0, from, unreadOnly }) => {
    // IMAP backend: prefer direct IMAP whenever IMAP is configured (v2.6.0).
    //   - explicit IMAP account → single-account IMAP listing (fast path);
    //   - no account + IMAP configured → MERGE: IMAP fans out over every
    //     configured account; AppleScript lists ONLY the accounts no IMAP config
    //     covers (partitioned — all-IMAP user runs ZERO AppleScript). NOTE:
    //     pagination via `offset` is applied PER-BACKEND before the merge, so
    //     deep offsets in a merged multi-account list are approximate — recommend
    //     scoping with an `account` for exact pagination.
    if (shouldUseImap(account)) {
      if (account !== undefined) {
        const r = await imapListMessages({ mailbox, account, limit, offset, from, unreadOnly });
        return successResponse(r.text, {
          messages: r.messages,
          count: r.count,
          partial: r.partial,
        });
      }
      const fan = await fanOutImapMessages({ mailbox, limit, offset, from, unreadOnly }, "list");
      const { appleScriptOnly } = partitionAccountsForCounts(
        mailManager.listAccounts(),
        resolveImapConfigs()
      );
      const apple = appleScanForAccounts(appleScriptOnly, (acctName) =>
        mailManager.listMessagesWithDiagnostics(mailbox, acctName, limit, from, offset)
      );
      return mergedMessageResponse(fan, apple, limit, "listed");
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

server.registerTool(
  "send-email",
  {
    description:
      "Use when: the user has explicitly confirmed they want to send a single email now to the given recipients (to/cc/bcc are arrays), optionally with attachments and a chosen transport.\nReturns: a confirmation naming the recipients and attachment count.\nDo not use when: the user wants to review first (use create-draft), is replying to or forwarding an existing message (use reply-to-message / forward-message), or wants per-recipient personalized copies (use send-serial-email).\nSafety: this SENDS real email immediately and it cannot be unsent — require explicit user confirmation of the exact recipients, subject, and body before calling. Prefer create-draft when there is any doubt.",
    inputSchema: {
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
          "Send transport. 'smtp' submits clean MIME directly via SMTP, avoiding " +
            "the macOS 15+ Mail.app <blockquote> wrapping (issue #12); requires " +
            "APPLE_MAIL_MCP_SMTP_* env config. 'applescript' sends through Mail.app. " +
            "If omitted, SMTP is used automatically when APPLE_MAIL_MCP_SMTP_* is " +
            "configured, otherwise AppleScript."
        ),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      recipients: z.array(z.string()).optional(),
      attachmentCount: z.number().optional(),
      transport: z.string().optional(),
    },
  },
  withErrorHandling(async ({ to, subject, body, cc, bcc, account, attachments, transport }) => {
    const attachInfo = attachments?.length ? ` with ${attachments.length} attachment(s)` : "";

    const attachmentCount = attachments?.length ?? 0;

    // Prefer SMTP when explicitly requested, or automatically when it is
    // configured and no transport was specified — except when a non-email
    // `account` label requests Mail.app account selection (see shouldUseSmtp).
    // Explicit transport:"applescript" always forces the Mail.app path.
    if (shouldUseSmtp(transport, account)) {
      // `account` is a Mail.app account label for the AppleScript path; for SMTP
      // it only makes sense as a From override when it is an actual address.
      // A bare label (only possible here via explicit transport:"smtp") must not
      // corrupt the From — fall back to the configured SMTP From in that case.
      const smtpFrom = account?.includes("@") ? account : undefined;
      const result = await sendViaSmtp({ to, subject, body, cc, bcc, from: smtpFrom, attachments });
      if (!result.success) {
        return errorResponse(result.error ?? "Failed to send email via SMTP.");
      }
      return successResponse(`Email sent via SMTP to ${to.join(", ")}${attachInfo}`, {
        ok: true,
        recipients: to,
        attachmentCount,
        transport: "smtp",
      });
    }

    const success = mailManager.sendEmail(to, subject, body, cc, bcc, account, attachments);

    if (!success) {
      return errorResponse("Failed to send email. Check Mail.app configuration.");
    }

    return successResponse(`Email sent to ${to.join(", ")}${attachInfo}`, {
      ok: true,
      recipients: to,
      attachmentCount,
      transport: "applescript",
    });
  }, "Error sending email")
);

// --- send-serial-email ---

server.registerTool(
  "send-serial-email",
  {
    description:
      "Use when: the user has confirmed a mail-merge — sending individually personalized copies to many recipients (max 100), with {{Key}} placeholders in subject/body replaced per-recipient from each recipient's variables. Recipients do not see each other.\nReturns: a per-recipient sent/failed report with counts.\nDo not use when: sending one message to a shared recipient list (use send-email) or saving for review (use create-draft).\nSafety: this SENDS many real emails immediately and they cannot be unsent — require explicit user confirmation of the recipient list, the subject/body template, and the placeholder substitutions before calling.",
    inputSchema: {
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
    outputSchema: {
      ok: z.boolean().optional(),
      sent: z.number().optional(),
      failed: z.number().optional(),
      results: z
        .array(
          z
            .object({
              email: z.string().optional(),
              success: z.boolean().optional(),
              error: z.string().optional(),
            })
            .passthrough()
        )
        .optional(),
    },
  },
  withErrorHandling(async ({ recipients, subject, body, account, delayMs }) => {
    // 2.5.0: prefer direct SMTP for mail-merge when configured (and not targeting
    // a bare Mail.app account label); Mail.app fallback when not configured.
    const smtpCfg = shouldUseSmtp(undefined, account) ? resolveSmtpOrFallback() : null;
    const results = smtpCfg
      ? await sendSerialViaSmtp(recipients, subject, body, smtpCfg, { delayMs })
      : mailManager.sendSerialEmail(recipients, subject, body, account, delayMs);
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    const details = results
      .map((r) => `  - ${r.email}: ${r.success ? "sent" : `FAILED (${r.error})`}`)
      .join("\n");

    const structured = {
      ok: failCount === 0,
      sent: successCount,
      failed: failCount,
      results: results.map((r) => ({ email: r.email, success: r.success, error: r.error })),
    };

    if (failCount === 0) {
      return successResponse(`Successfully sent ${successCount} email(s):\n${details}`, structured);
    } else if (successCount === 0) {
      return errorResponse(`Failed to send all ${failCount} email(s):\n${details}`);
    } else {
      return successResponse(
        `Sent ${successCount} of ${results.length} email(s), ${failCount} failed:\n${details}`,
        structured
      );
    }
  }, "Error sending serial emails")
);

// --- create-draft ---

server.registerTool(
  "create-draft",
  {
    description:
      "Use when: composing an email the user should review in Mail.app before sending — the safe default for any new message (to/cc/bcc are arrays, optional attachments).\nReturns: a confirmation that the draft was created, with recipients and attachment count.\nDo not use when: the user has already confirmed they want it sent now (use send-email).\nSafety: low risk — creates a draft only and sends nothing; the user must open Mail.app and send it themselves.",
    inputSchema: {
      to: z.array(z.string()).min(1, "At least one recipient is required"),
      subject: z.string().min(1, "Subject is required"),
      body: z.string().min(1, "Body is required"),
      cc: z.array(z.string()).optional().describe("CC recipients"),
      bcc: z.array(z.string()).optional().describe("BCC recipients"),
      account: z.string().optional().describe("Account to create draft in"),
      attachments: ATTACHMENTS_SCHEMA,
    },
    outputSchema: {
      ok: z.boolean().optional(),
      recipients: z.array(z.string()).optional(),
      attachmentCount: z.number().optional(),
    },
  },
  withErrorHandling(({ to, subject, body, cc, bcc, account, attachments }) => {
    const success = mailManager.createDraft(to, subject, body, cc, bcc, account, attachments);

    if (!success) {
      return errorResponse("Failed to create draft. Check Mail.app configuration.");
    }

    const attachmentCount = attachments?.length ?? 0;
    const attachInfo = attachmentCount ? ` with ${attachmentCount} attachment(s)` : "";
    return successResponse(`Draft created for ${to.join(", ")}${attachInfo}`, {
      ok: true,
      recipients: to,
      attachmentCount,
    });
  }, "Error creating draft")
);

/**
 * Outcome of a direct-SMTP reply/forward attempt (2.5.0 prefer-direct path).
 * - `sent`: the SMTP transaction succeeded.
 * - `fallback`: the direct path could not be used (SMTP not fully configured, the
 *   original couldn't be fetched, or — for replies — it has no `Message-ID` to
 *   thread on); the caller should use the Mail.app AppleScript path instead.
 * - `error` (only with `fallback: false`): the SMTP transaction itself failed —
 *   surface it rather than risk a double-send by also trying Mail.app.
 */
type DirectSendOutcome =
  | { sent: true }
  | { sent: false; fallback: true }
  | { sent: false; fallback: false; error: string };

/** Resolve SMTP config, falling back (host/user set but no password) to Mail.app. */
function resolveSmtpOrFallback(): SmtpConfig | null {
  try {
    return resolveSmtpConfig();
  } catch {
    return null;
  }
}

/** Reply to a message over direct SMTP with RFC 5322 threading headers. */
async function sendReplyViaSmtp(
  id: string,
  body: string,
  replyAll: boolean
): Promise<DirectSendOutcome> {
  const cfg = resolveSmtpOrFallback();
  if (!cfg) return { sent: false, fallback: true };

  const raw = mailManager.getRawSource(id);
  if (!raw) return { sent: false, fallback: true };

  const original = parseOriginalHeaders(raw);
  // Without a Message-ID we can't thread; let Mail.app's reply handle it.
  if (!original.messageId || original.from.length === 0) {
    return { sent: false, fallback: true };
  }

  const content = mailManager.getMessageContent(id);
  const opts = buildReplyOptions({
    original,
    originalPlainText: content?.plainText ?? "",
    body,
    replyAll,
    self: [cfg.from, cfg.user],
    from: cfg.from,
  });

  const result = await sendViaSmtp(opts, cfg);
  if (result.success) return { sent: true };
  return { sent: false, fallback: false, error: result.error ?? "unknown SMTP error" };
}

/** Forward a message over direct SMTP (clean MIME, new thread). */
async function sendForwardViaSmtp(
  id: string,
  to: string[],
  body: string | undefined
): Promise<DirectSendOutcome> {
  const cfg = resolveSmtpOrFallback();
  if (!cfg) return { sent: false, fallback: true };

  const raw = mailManager.getRawSource(id);
  if (!raw) return { sent: false, fallback: true };

  const original = parseOriginalHeaders(raw);
  const content = mailManager.getMessageContent(id);
  const opts = buildForwardOptions({
    original,
    originalPlainText: content?.plainText ?? "",
    to,
    body,
    from: cfg.from,
  });

  const result = await sendViaSmtp(opts, cfg);
  if (result.success) return { sent: true };
  return { sent: false, fallback: false, error: result.error ?? "unknown SMTP error" };
}

// --- reply-to-message ---

server.registerTool(
  "reply-to-message",
  {
    description:
      "Use when: replying to an existing message by id, preserving its threading headers. Set replyAll for all recipients; set send=false to save as a draft instead of sending.\nReturns: a confirmation that the reply was sent or saved as a draft.\nDo not use when: composing a brand-new message (use send-email / create-draft) or forwarding to new recipients (use forward-message).\nSafety: with the default send=true this SENDS real email immediately and cannot be unsent — require explicit user confirmation of the recipients and body, or pass send=false to let the user review.",
    inputSchema: {
      id: MESSAGE_ID_SCHEMA,
      body: z.string().min(1, "Reply body is required"),
      replyAll: z.boolean().optional().default(false).describe("Reply to all recipients"),
      send: z
        .boolean()
        .optional()
        .default(true)
        .describe("Send immediately (false = save as draft)"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      sent: z.boolean().optional(),
      id: z.string().optional(),
    },
  },
  withErrorHandling(async ({ id, body, replyAll, send }) => {
    // 2.5.0: prefer direct SMTP (clean, correctly threaded MIME) when configured
    // and actually sending. Drafts (send=false) and the not-configured /
    // unthreadable cases fall through to the Mail.app AppleScript path.
    if (send && isSmtpConfigured()) {
      const outcome = await sendReplyViaSmtp(id, body, replyAll);
      if (outcome.sent) {
        return successResponse("Reply sent", { ok: true, sent: true, id });
      }
      if (!outcome.fallback) {
        return errorResponse(`Failed to reply to message "${id}" via SMTP: ${outcome.error}`);
      }
    }

    const success = mailManager.replyToMessage(id, body, replyAll, send);

    if (!success) {
      return errorResponse(`Failed to reply to message "${id}"`);
    }

    return successResponse(send ? "Reply sent" : "Reply saved as draft", {
      ok: true,
      sent: send,
      id,
    });
  }, "Error replying to message")
);

// --- forward-message ---

server.registerTool(
  "forward-message",
  {
    description:
      "Use when: forwarding an existing message (by id) to new recipients (to is an array), with an optional body to prepend. Set send=false to save as a draft.\nReturns: a confirmation that the message was forwarded or saved as a draft.\nDo not use when: replying to the sender/recipients (use reply-to-message) or composing a new message (use send-email / create-draft).\nSafety: with the default send=true this SENDS real email immediately and cannot be unsent — require explicit user confirmation of the recipients and any prepended body, or pass send=false to let the user review.",
    inputSchema: {
      id: MESSAGE_ID_SCHEMA,
      to: z.array(z.string()).min(1, "At least one recipient is required"),
      body: z.string().optional().describe("Optional message to prepend"),
      send: z
        .boolean()
        .optional()
        .default(true)
        .describe("Send immediately (false = save as draft)"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      sent: z.boolean().optional(),
      recipients: z.array(z.string()).optional(),
      id: z.string().optional(),
    },
  },
  withErrorHandling(async ({ id, to, body, send }) => {
    // 2.5.0: prefer direct SMTP (clean MIME) when configured and actually sending.
    if (send && isSmtpConfigured()) {
      const outcome = await sendForwardViaSmtp(id, to, body);
      if (outcome.sent) {
        return successResponse(`Message forwarded to ${to.join(", ")}`, {
          ok: true,
          sent: true,
          recipients: to,
          id,
        });
      }
      if (!outcome.fallback) {
        return errorResponse(`Failed to forward message "${id}" via SMTP: ${outcome.error}`);
      }
    }

    const success = mailManager.forwardMessage(id, to, body, send);

    if (!success) {
      return errorResponse(`Failed to forward message "${id}"`);
    }

    return successResponse(
      send ? `Message forwarded to ${to.join(", ")}` : "Forward saved as draft",
      { ok: true, sent: send, recipients: to, id }
    );
  }, "Error forwarding message")
);

// --- mark-as-read ---

server.registerTool(
  "mark-as-read",
  {
    description:
      "Use when: marking a single message (by id) as read.\nReturns: a confirmation that the message was marked read.\nDo not use when: marking several at once (use batch-mark-as-read) or marking unread (use mark-as-unread). Get the id from search-messages or list-messages first.",
    inputSchema: {
      id: MESSAGE_ID_SCHEMA,
    },
    outputSchema: { ok: z.boolean().optional(), id: z.string().optional() },
  },
  withErrorHandling(
    ({ id }) =>
      routeMessage(id, {
        imap: () => imapMarkRead(id),
        apple: () =>
          mailManager.markAsRead(id)
            ? successResponse("Message marked as read", { ok: true, id })
            : errorResponse(`Failed to mark message "${id}" as read`),
        ok: "Message marked as read",
        fail: `Failed to mark message "${id}" as read`,
        structured: { ok: true, id },
      }),
    "Error marking message as read"
  )
);

// --- mark-as-unread ---

server.registerTool(
  "mark-as-unread",
  {
    description:
      "Use when: marking a single message (by id) as unread.\nReturns: a confirmation that the message was marked unread.\nDo not use when: marking several at once (use batch-mark-as-unread) or marking read (use mark-as-read). Get the id from search-messages or list-messages first.",
    inputSchema: {
      id: MESSAGE_ID_SCHEMA,
    },
    outputSchema: { ok: z.boolean().optional(), id: z.string().optional() },
  },
  withErrorHandling(
    ({ id }) =>
      routeMessage(id, {
        imap: () => imapMarkUnread(id),
        apple: () =>
          mailManager.markAsUnread(id)
            ? successResponse("Message marked as unread", { ok: true, id })
            : errorResponse(`Failed to mark message "${id}" as unread`),
        ok: "Message marked as unread",
        fail: `Failed to mark message "${id}" as unread`,
        structured: { ok: true, id },
      }),
    "Error marking message as unread"
  )
);

// --- flag-message ---

server.registerTool(
  "flag-message",
  {
    description:
      "Use when: flagging a single message (by id), optionally with a color (red/orange/yellow/green/blue/purple/gray).\nReturns: a confirmation that the message was flagged (and the color, when applied).\nDo not use when: flagging several at once (use batch-flag-messages) or removing a flag (use unflag-message). Get the id from search-messages or list-messages first.\nNote: the color is applied on both routes — AppleScript sets the flag index, IMAP writes the equivalent $MailFlagBit0/1/2 keywords Mail.app reads.",
    inputSchema: {
      id: MESSAGE_ID_SCHEMA,
      color: FLAG_COLOR_SCHEMA,
    },
    outputSchema: {
      ok: z.boolean().optional(),
      id: z.string().optional(),
      color: z.string().optional(),
      colorApplied: z.boolean().optional(),
    },
  },
  withErrorHandling(({ id, color }) => {
    const colorIndex = color ? FLAG_COLOR_INDEX[color] : undefined;
    return routeMessage(id, {
      imap: () => imapFlagMessage(id, colorIndex),
      apple: () =>
        mailManager.flagMessage(id, colorIndex)
          ? successResponse(color ? `Message flagged (${color})` : "Message flagged", {
              ok: true,
              id,
              ...(color ? { color, colorApplied: true } : {}),
            })
          : errorResponse(`Failed to flag message "${id}"`),
      // IMAP path: imapFlagMessage writes the color as $MailFlagBit0/1/2 keywords,
      // so the outcome matches the AppleScript route above.
      ok: color ? `Message flagged (${color})` : "Message flagged",
      fail: `Failed to flag message "${id}"`,
      structured: color ? { ok: true, id, color, colorApplied: true } : { ok: true, id },
    });
  }, "Error flagging message")
);

// --- unflag-message ---

server.registerTool(
  "unflag-message",
  {
    description:
      "Use when: removing the flag from a single message (by id).\nReturns: a confirmation that the message was unflagged.\nDo not use when: unflagging several at once (use batch-unflag-messages) or adding a flag (use flag-message). Get the id from search-messages or list-messages first.",
    inputSchema: {
      id: MESSAGE_ID_SCHEMA,
    },
    outputSchema: { ok: z.boolean().optional(), id: z.string().optional() },
  },
  withErrorHandling(
    ({ id }) =>
      routeMessage(id, {
        imap: () => imapUnflagMessage(id),
        apple: () =>
          mailManager.unflagMessage(id)
            ? successResponse("Message unflagged", { ok: true, id })
            : errorResponse(`Failed to unflag message "${id}"`),
        ok: "Message unflagged",
        fail: `Failed to unflag message "${id}"`,
        structured: { ok: true, id },
      }),
    "Error unflagging message"
  )
);

// --- delete-message ---

server.registerTool(
  "delete-message",
  {
    description:
      "Use when: deleting a single message by id (moves it to Trash).\nReturns: a confirmation that the message was deleted.\nDo not use when: deleting several at once (use batch-delete-messages) or just filing it away (use move-message).\nSafety: destructive — require explicit user confirmation, and search-messages/list-messages first to confirm you have the right id before deleting.",
    inputSchema: {
      id: MESSAGE_ID_SCHEMA,
    },
    outputSchema: { ok: z.boolean().optional(), id: z.string().optional() },
  },
  withErrorHandling(
    ({ id }) =>
      routeMessage(id, {
        imap: () => imapDeleteMessageById(id),
        apple: () => {
          const { success, error } = mailManager.deleteMessage(id);
          return success
            ? successResponse("Message deleted", { ok: true, id })
            : errorResponse(error || `Failed to delete message "${id}"`);
        },
        ok: "Message deleted",
        fail: `Failed to delete message "${id}"`,
        structured: { ok: true, id },
      }),
    "Error deleting message"
  )
);

// --- move-message ---

server.registerTool(
  "move-message",
  {
    description:
      "Use when: moving a single message (by id) into another mailbox/folder, e.g. archiving or filing.\nReturns: a confirmation naming the destination mailbox.\nDo not use when: moving several at once (use batch-move-messages) or deleting (use delete-message). Use list-mailboxes to confirm the destination name exists.\nSafety: moves a real message between folders — confirm the destination mailbox, and search-messages/list-messages first to confirm the id.",
    inputSchema: {
      id: MESSAGE_ID_SCHEMA,
      mailbox: z.string().min(1, "Destination mailbox is required"),
      account: z.string().optional().describe("Account containing the destination mailbox"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      id: z.string().optional(),
      mailbox: z.string().optional(),
    },
  },
  withErrorHandling(
    ({ id, mailbox, account }) =>
      routeMessage(id, {
        imap: () => imapMoveMessageById(id, mailbox),
        apple: () => {
          const { success, error } = mailManager.moveMessage(id, mailbox, account);
          return success
            ? successResponse(`Message moved to "${mailbox}"`, { ok: true, id, mailbox })
            : errorResponse(error || `Failed to move message to "${mailbox}"`);
        },
        ok: `Message moved to "${mailbox}"`,
        fail: `Failed to move message to "${mailbox}"`,
        structured: { ok: true, id, mailbox },
      }),
    "Error moving message"
  )
);

// --- batch-delete-messages ---

server.registerTool(
  "batch-delete-messages",
  {
    description:
      "Use when: deleting multiple messages in one call (1–100 ids; moves them to Trash).\nReturns: counts of how many were deleted and how many failed.\nDo not use when: deleting just one (use delete-message) or filing messages away (use batch-move-messages).\nSafety: destructive and applies to many messages at once — require explicit user confirmation, and search-messages/list-messages first to confirm every id is correct before deleting.",
    inputSchema: {
      ids: BATCH_IDS_SCHEMA,
    },
    outputSchema: BATCH_COUNT_OUTPUT_SCHEMA,
  },
  withErrorHandling(async ({ ids }) => {
    const { success: successCount, fail: failCount } = await hybridBatchCounts(
      ids,
      (n) => mailManager.batchDeleteMessages(n),
      (im) => imapBatchDelete(im)
    );
    const structured = { ok: failCount === 0, success: successCount, failed: failCount };

    if (failCount === 0) {
      return successResponse(`Successfully deleted ${successCount} message(s)`, structured);
    } else if (successCount === 0) {
      return errorResponse(`Failed to delete all ${failCount} message(s)`);
    } else {
      return successResponse(`Deleted ${successCount} message(s), ${failCount} failed`, structured);
    }
  }, "Error batch deleting messages")
);

// --- batch-move-messages ---

server.registerTool(
  "batch-move-messages",
  {
    description:
      "Use when: moving multiple messages (1–100 ids) into the same destination mailbox/folder in one call, e.g. bulk archiving.\nReturns: counts of how many were moved and how many failed.\nDo not use when: moving just one (use move-message) or deleting (use batch-delete-messages). Use list-mailboxes to confirm the destination name exists.\nSafety: moves many real messages at once — confirm the destination mailbox, and search-messages/list-messages first to confirm the ids.",
    inputSchema: {
      ids: BATCH_IDS_SCHEMA,
      mailbox: z.string().min(1, "Destination mailbox is required"),
      account: z.string().optional().describe("Account containing the destination mailbox"),
    },
    outputSchema: BATCH_COUNT_OUTPUT_SCHEMA,
  },
  withErrorHandling(async ({ ids, mailbox, account }) => {
    const { success: successCount, fail: failCount } = await hybridBatchCounts(
      ids,
      (n) => mailManager.batchMoveMessages(n, mailbox, account),
      (im) => imapBatchMove(im, mailbox, { account })
    );
    const structured = { ok: failCount === 0, success: successCount, failed: failCount, mailbox };

    if (failCount === 0) {
      return successResponse(
        `Successfully moved ${successCount} message(s) to "${mailbox}"`,
        structured
      );
    } else if (successCount === 0) {
      return errorResponse(`Failed to move all ${failCount} message(s)`);
    } else {
      return successResponse(
        `Moved ${successCount} message(s) to "${mailbox}", ${failCount} failed`,
        structured
      );
    }
  }, "Error batch moving messages")
);

// --- batch-mark-as-read ---

server.registerTool(
  "batch-mark-as-read",
  {
    description:
      "Use when: marking multiple messages (1–100 ids) as read in one call.\nReturns: counts of how many were marked read and how many failed.\nDo not use when: marking just one (use mark-as-read) or marking unread (use batch-mark-as-unread). Get the ids from search-messages or list-messages first.",
    inputSchema: {
      ids: BATCH_IDS_SCHEMA,
    },
    outputSchema: BATCH_COUNT_OUTPUT_SCHEMA,
  },
  withErrorHandling(async ({ ids }) => {
    const { success: successCount, fail: failCount } = await hybridBatchCounts(
      ids,
      (n) => mailManager.batchMarkAsRead(n),
      (im) => imapBatchMarkRead(im)
    );
    const structured = { ok: failCount === 0, success: successCount, failed: failCount };

    if (failCount === 0) {
      return successResponse(`Successfully marked ${successCount} message(s) as read`, structured);
    } else if (successCount === 0) {
      return errorResponse(`Failed to mark all ${failCount} message(s) as read`);
    } else {
      return successResponse(
        `Marked ${successCount} message(s) as read, ${failCount} failed`,
        structured
      );
    }
  }, "Error batch marking messages as read")
);

// --- batch-mark-as-unread ---

server.registerTool(
  "batch-mark-as-unread",
  {
    description:
      "Use when: marking multiple messages (1–100 ids) as unread in one call.\nReturns: counts of how many were marked unread and how many failed.\nDo not use when: marking just one (use mark-as-unread) or marking read (use batch-mark-as-read). Get the ids from search-messages or list-messages first.",
    inputSchema: {
      ids: BATCH_IDS_SCHEMA,
    },
    outputSchema: BATCH_COUNT_OUTPUT_SCHEMA,
  },
  withErrorHandling(async ({ ids }) => {
    const { success: successCount, fail: failCount } = await hybridBatchCounts(
      ids,
      (n) => mailManager.batchMarkAsUnread(n),
      (im) => imapBatchMarkUnread(im)
    );
    const structured = { ok: failCount === 0, success: successCount, failed: failCount };

    if (failCount === 0) {
      return successResponse(
        `Successfully marked ${successCount} message(s) as unread`,
        structured
      );
    } else if (successCount === 0) {
      return errorResponse(`Failed to mark all ${failCount} message(s) as unread`);
    } else {
      return successResponse(
        `Marked ${successCount} message(s) as unread, ${failCount} failed`,
        structured
      );
    }
  }, "Error batch marking messages as unread")
);

// --- batch-flag-messages ---

server.registerTool(
  "batch-flag-messages",
  {
    description:
      "Use when: flagging multiple messages (1–100 ids) in one call, optionally with a color (red/orange/yellow/green/blue/purple/gray).\nReturns: counts of how many were flagged and how many failed.\nDo not use when: flagging just one (use flag-message) or removing flags (use batch-unflag-messages). Get the ids from search-messages or list-messages first.\nNote: the color is applied on both routes — AppleScript sets the flag index, IMAP writes the equivalent $MailFlagBit0/1/2 keywords Mail.app reads — so a mixed batch of numeric and `imap:` ids all end up colored.",
    inputSchema: {
      ids: BATCH_IDS_SCHEMA,
      color: FLAG_COLOR_SCHEMA,
    },
    outputSchema: BATCH_COUNT_OUTPUT_SCHEMA,
  },
  withErrorHandling(async ({ ids, color }) => {
    const colorIndex = color ? FLAG_COLOR_INDEX[color] : undefined;
    const { success: successCount, fail: failCount } = await hybridBatchCounts(
      ids,
      (n) => mailManager.batchFlagMessages(n, colorIndex),
      (im) => imapBatchFlag(im, colorIndex)
    );
    const structured = { ok: failCount === 0, success: successCount, failed: failCount };

    if (failCount === 0) {
      return successResponse(`Successfully flagged ${successCount} message(s)`, structured);
    } else if (successCount === 0) {
      return errorResponse(`Failed to flag all ${failCount} message(s)`);
    } else {
      return successResponse(`Flagged ${successCount} message(s), ${failCount} failed`, structured);
    }
  }, "Error batch flagging messages")
);

// --- batch-unflag-messages ---

server.registerTool(
  "batch-unflag-messages",
  {
    description:
      "Use when: removing flags from multiple messages (1–100 ids) in one call.\nReturns: counts of how many were unflagged and how many failed.\nDo not use when: unflagging just one (use unflag-message) or adding flags (use batch-flag-messages). Get the ids from search-messages or list-messages first.",
    inputSchema: {
      ids: BATCH_IDS_SCHEMA,
    },
    outputSchema: BATCH_COUNT_OUTPUT_SCHEMA,
  },
  withErrorHandling(async ({ ids }) => {
    const { success: successCount, fail: failCount } = await hybridBatchCounts(
      ids,
      (n) => mailManager.batchUnflagMessages(n),
      (im) => imapBatchUnflag(im)
    );
    const structured = { ok: failCount === 0, success: successCount, failed: failCount };

    if (failCount === 0) {
      return successResponse(`Successfully unflagged ${successCount} message(s)`, structured);
    } else if (successCount === 0) {
      return errorResponse(`Failed to unflag all ${failCount} message(s)`);
    } else {
      return successResponse(
        `Unflagged ${successCount} message(s), ${failCount} failed`,
        structured
      );
    }
  }, "Error batch unflagging messages")
);

// --- resolve-message-id ---

server.registerTool(
  "resolve-message-id",
  {
    description:
      "Use when: you have `imap:` message id(s) and genuinely need the numeric Mail.app id(s) — e.g. for reply-to-message/forward-message, which are numeric-id only. NOTE: as of 2.10.0 you no longer need this to apply a flag COLOR — flag-message/batch-flag-messages write the color over IMAP directly via Mail.app's $MailFlagBit0/1/2 keywords, so a smart mailbox keyed on flag color matches an IMAP-flagged message. Each imap: id is resolved via its RFC822 Message-ID.\nReturns: for each input id, its `numericId` (the AppleScript id) or null when it can't be resolved, plus the `messageId` used; and a `resolvedCount`.\nDo not use when: your ids are already numeric (they pass straight through), or you don't need a color — flag/move/mark tools operate on `imap:` ids directly.",
    inputSchema: {
      ids: BATCH_IDS_SCHEMA,
    },
    outputSchema: {
      resolved: z
        .array(
          z.object({
            id: z.string(),
            numericId: z.string().nullable(),
            messageId: z.string().nullable(),
          })
        )
        .optional(),
      count: z.number().optional(),
      resolvedCount: z.number().optional(),
    },
  },
  withErrorHandling(async ({ ids }) => {
    const resolved: { id: string; numericId: string | null; messageId: string | null }[] = [];
    for (const id of ids) {
      const ref = decodeImapId(id);
      if (!ref) {
        // Already a numeric AppleScript id — pass through unchanged.
        resolved.push({ id, numericId: id, messageId: null });
        continue;
      }
      const messageId = await imapFetchMessageId(id);
      const numericId = messageId
        ? mailManager.findNumericIdByMessageId(messageId, ref.account)
        : null;
      resolved.push({ id, numericId, messageId });
    }
    const resolvedCount = resolved.filter((r) => r.numericId !== null).length;
    return successResponse(
      `Resolved ${resolvedCount}/${ids.length} message id(s) to numeric Mail.app id(s)`,
      { resolved, count: ids.length, resolvedCount }
    );
  }, "Error resolving message ids")
);

// --- list-attachments ---

server.registerTool(
  "list-attachments",
  {
    description:
      "Use when: enumerating a message's attachments (by id) to discover their names, MIME types, and sizes — typically before saving or fetching one.\nReturns: each attachment's name, MIME type, and size, plus a count.\nDo not use when: you want the bytes (use fetch-attachment for inline base64, or save-attachment to write to disk). Get the message id from search-messages or list-messages first.",
    inputSchema: {
      id: MESSAGE_ID_SCHEMA,
    },
    outputSchema: {
      attachments: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
    },
  },
  withErrorHandling(async ({ id }) => {
    // IMAP (I1): BODYSTRUCTURE enumerates parts (incl. MIME attachments
    // AppleScript can't see) without downloading the message.
    const attachments = id.startsWith("imap:")
      ? await (async () => {
          const r = await imapListAttachments(id);
          if (!r.success) throw new Error(r.error || "Failed to list attachments via IMAP");
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

    return successResponse(
      `Found ${attachments.length} attachment(s):\n${attachmentList}`,
      structured
    );
  }, "Error listing attachments")
);

// --- save-attachment ---

server.registerTool(
  "save-attachment",
  {
    description:
      "Use when: writing one of a message's attachments to disk, by message id and attachmentName, into the savePath directory (saved as savePath/attachmentName).\nReturns: a confirmation of the saved file path.\nDo not use when: you don't know the attachment name (use list-attachments first) or want the bytes inline rather than on disk (use fetch-attachment).\nSafety: writes a file to disk — savePath must be a directory inside the configured allowed roots, and attachmentName may not contain path separators or '..'; calls outside those constraints are rejected.",
    inputSchema: {
      id: MESSAGE_ID_SCHEMA,
      attachmentName: z.string().min(1, "Attachment name is required"),
      savePath: z.string().min(1, "Save directory path is required"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      attachmentName: z.string().optional(),
      savedPath: z.string().optional(),
    },
  },
  withErrorHandling(async ({ id, attachmentName, savePath }) => {
    // IMAP (I1): fetch the part's bytes via IMAP, then write into savePath (a
    // directory) as savePath/attachmentName — mirroring the AppleScript path,
    // with the same name + allowed-roots validation.
    if (id.startsWith("imap:")) {
      if (/[/\\\0]/.test(attachmentName) || attachmentName.includes("..")) {
        return errorResponse(`Invalid attachment name: "${attachmentName}"`);
      }
      let target: { saveDirectory: string; savedPath: string };
      try {
        target = resolveAttachmentSaveTarget(savePath, attachmentName);
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
      }
      const r = await imapFetchAttachment(id, attachmentName);
      if (!r.success || !r.base64) {
        return errorResponse(r.error || `Failed to fetch attachment "${attachmentName}"`);
      }
      writeFileSync(target.savedPath, Buffer.from(r.base64, "base64"));
      return successResponse(`Attachment "${attachmentName}" saved to ${savePath}`, {
        ok: true,
        attachmentName,
        savedPath: target.savedPath,
      });
    }

    const success = mailManager.saveAttachment(id, attachmentName, savePath);

    if (!success) {
      return errorResponse(`Failed to save attachment "${attachmentName}"`);
    }

    return successResponse(`Attachment "${attachmentName}" saved to ${savePath}`, {
      ok: true,
      attachmentName,
      savedPath: joinPath(savePath, attachmentName),
    });
  }, "Error saving attachment")
);

// --- fetch-attachment ---

server.registerTool(
  "fetch-attachment",
  {
    description:
      "Use when: retrieving an attachment's raw bytes inline as base64 (by message id and attachmentName), e.g. to process its contents without touching disk.\nReturns: the attachment's bytes base64-encoded, with its size and (for IMAP) MIME type.\nDo not use when: you don't know the attachment name (use list-attachments first) or you just want it saved to disk (use save-attachment).",
    inputSchema: {
      id: MESSAGE_ID_SCHEMA,
      attachmentName: z.string().min(1, "Attachment name is required"),
    },
    outputSchema: {
      attachmentName: z.string().optional(),
      bytes: z.number().optional(),
      mimeType: z.string().optional(),
      contentBase64: z.string().optional(),
    },
  },
  withErrorHandling(async ({ id, attachmentName }) => {
    // Returns the attachment bytes as base64 (B4) — the read counterpart to
    // sending inline base64 content. IMAP (I1) fetches the part directly; numeric
    // ids fall back to the AppleScript/MIME path.
    if (id.startsWith("imap:")) {
      const r = await imapFetchAttachment(id, attachmentName);
      if (!r.success || !r.base64) {
        return errorResponse(r.error || `Failed to fetch attachment "${attachmentName}"`);
      }
      return successResponse(
        `Fetched "${attachmentName}" (${r.bytes} bytes, base64-encoded below).\n\n${r.base64}`,
        { attachmentName, bytes: r.bytes, mimeType: r.mimeType, contentBase64: r.base64 }
      );
    }
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

server.registerTool(
  "list-mailboxes",
  {
    description:
      "Use when: discovering the mailbox/folder names (and unread/message counts) available in an account, e.g. before moving messages or searching a specific mailbox.\nReturns: each mailbox's name with its unread (and, for IMAP, total message) count, plus a count.\nDo not use when: you want the messages inside a mailbox (use list-messages or search-messages) or the list of accounts (use list-accounts).",
    inputSchema: {
      account: z.string().optional().describe("Account to list mailboxes from"),
    },
    outputSchema: {
      mailboxes: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
    },
  },
  withErrorHandling(async ({ account }) => {
    // IMAP (I6): LIST + per-mailbox STATUS — sees the true server hierarchy and
    // authoritative counts. Prefer-IMAP (v2.6.0):
    //   - explicit IMAP account → that account's IMAP mailboxes;
    //   - no account + IMAP configured → concatenate every configured IMAP
    //     account's mailboxes (each name prefixed with its account label to
    //     disambiguate identical mailbox names across accounts) PLUS the
    //     AppleScript mailboxes of every account NOT covered by IMAP.
    if (shouldUseImap(account)) {
      if (account !== undefined) {
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
      const configs = resolveImapConfigs();
      const rows: { name: string; account: string; unreadCount: number; messageCount: number }[] =
        [];
      for (const config of configs) {
        try {
          const boxes = await imapListMailboxes({ config });
          for (const b of boxes) {
            // Prefix with the account label so "INBOX" from two accounts is
            // distinguishable; keep the raw path available via the structured row.
            rows.push({
              name: `${config.accountLabel}/${b.path}`,
              account: config.accountLabel,
              unreadCount: b.unseen,
              messageCount: b.messages,
            });
          }
        } catch (e) {
          console.error(`IMAP list-mailboxes failed for "${config.accountLabel}": ${String(e)}`);
        }
      }
      // AppleScript for the accounts IMAP doesn't cover (no double-listing).
      const { appleScriptOnly } = partitionAccountsForCounts(mailManager.listAccounts(), configs);
      for (const acct of appleScriptOnly) {
        for (const mb of mailManager.listMailboxes(acct.name)) {
          rows.push({
            name: `${acct.name}/${mb.name}`,
            account: acct.name,
            unreadCount: mb.unreadCount,
            messageCount: mb.messageCount,
          });
        }
      }
      const structured = { mailboxes: rows, count: rows.length };
      if (rows.length === 0) return successResponse("No mailboxes found", structured);
      const list = rows.map((b) => `  - ${b.name} (${b.unreadCount} unread)`).join("\n");
      return successResponse(`Found ${rows.length} mailbox(es):\n${list}`, structured);
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

server.registerTool(
  "get-unread-count",
  {
    description:
      "Use when: you only need the number of unread messages — INBOX by default, or scoped to one mailbox and/or account — without listing the messages themselves.\nReturns: the unread count for the requested scope (INBOX when no mailbox is given).\nDo not use when: you need the actual unread messages and their ids (use list-messages with unreadOnly, or search-messages with isRead=false) or broader totals across every mailbox (use get-mail-stats).",
    inputSchema: {
      mailbox: z.string().optional().describe("Mailbox to check (default: INBOX)"),
      account: z.string().optional().describe("Account to check"),
    },
    outputSchema: {
      unread: z.number().optional(),
      mailbox: z.string().optional(),
      account: z.string().optional(),
    },
  },
  withErrorHandling(async ({ mailbox, account }) => {
    // IMAP (I4): STATUS (UNSEEN) is authoritative and fast even on huge
    // mailboxes. Prefer-IMAP (v2.6.0). No mailbox → each account's INBOX (the
    // meaningful "unread" figure; summing every mailbox was slow and, on Gmail,
    // counted one unread message once per label + All Mail). Counts are
    // ACCOUNT-CENTRIC so each account is counted exactly once even if the
    // coverage heuristic mis-matches:
    //   - explicit IMAP account → IMAP UNSEEN for that account;
    //   - no account + IMAP configured → planCountSources assigns each account
    //     ONE source (its matching IMAP config, else AppleScript) and counts any
    //     config that matched no account once via IMAP — no double-counting;
    //   - explicit non-IMAP account (or IMAP unconfigured) → AppleScript.
    let count: number;
    if (shouldUseImap(account)) {
      if (account !== undefined) {
        count = await imapUnreadCount(mailbox, { account });
      } else {
        const sources = planCountSources(mailManager.listAccounts(), resolveImapConfigs());
        let total = 0;
        for (const src of sources) {
          if (src.kind === "imap") {
            try {
              total += await imapUnreadCount(mailbox, { config: src.config });
            } catch (e) {
              console.error(`IMAP unread-count failed for "${src.label}": ${String(e)}`);
            }
          } else {
            total += mailManager.getUnreadCount(mailbox, src.account.name);
          }
        }
        count = total;
      }
    } else {
      count = mailManager.getUnreadCount(mailbox, account);
    }
    const location = mailbox ? ` in "${mailbox}"` : "";

    return successResponse(`${count} unread message(s)${location}`, {
      unread: count,
      mailbox,
      account,
    });
  }, "Error getting unread count")
);

// --- create-mailbox ---

server.registerTool(
  "create-mailbox",
  {
    description:
      "Use when: creating a new mailbox/folder in an account.\nReturns: a confirmation that the mailbox was created.\nDo not use when: renaming an existing one (use rename-mailbox) or deleting one (use delete-mailbox). Use list-mailboxes to see what already exists.\nSafety: creates a real folder in the mail account — confirm the name and target account first.",
    inputSchema: {
      name: z.string().min(1, "Mailbox name is required"),
      account: z.string().optional().describe("Account to create the mailbox in"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      name: z.string().optional(),
    },
  },
  withErrorHandling(async ({ name, account }) => {
    // IMAP backend (issue #43, Phase 2): server-side folder op when this account
    // is IMAP-configured; otherwise AppleScript.
    if (isImapAccount(account)) {
      const r = await imapCreateMailbox(name, { account });
      if (!r.success) return errorResponse(r.error || `Failed to create mailbox "${name}"`);
      return successResponse(r.info || `Mailbox "${name}" created`, { ok: true, name });
    }

    const { success, error } = mailManager.createMailbox(name, account);

    if (!success) {
      return errorResponse(error || `Failed to create mailbox "${name}"`);
    }

    return successResponse(`Mailbox "${name}" created`, { ok: true, name });
  }, "Error creating mailbox")
);

// --- delete-mailbox ---

server.registerTool(
  "delete-mailbox",
  {
    description:
      "Use when: deleting a mailbox/folder from an account.\nReturns: a confirmation that the mailbox was deleted.\nDo not use when: renaming it (use rename-mailbox) or deleting messages within it (use delete-message / batch-delete-messages).\nSafety: destructive — deleting a mailbox removes the folder and any messages it contains. Require explicit user confirmation and use list-mailboxes first to confirm the exact name.",
    inputSchema: {
      name: z.string().min(1, "Mailbox name is required"),
      account: z.string().optional().describe("Account containing the mailbox"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      name: z.string().optional(),
    },
  },
  withErrorHandling(async ({ name, account }) => {
    if (isImapAccount(account)) {
      const r = await imapDeleteMailbox(name, { account });
      if (!r.success) return errorResponse(r.error || `Failed to delete mailbox "${name}"`);
      return successResponse(r.info || `Mailbox "${name}" deleted`, { ok: true, name });
    }

    const { success, error } = mailManager.deleteMailbox(name, account);

    if (!success) {
      return errorResponse(error || `Failed to delete mailbox "${name}"`);
    }

    return successResponse(`Mailbox "${name}" deleted`, { ok: true, name });
  }, "Error deleting mailbox")
);

// --- rename-mailbox ---

server.registerTool(
  "rename-mailbox",
  {
    description:
      "Use when: renaming an existing mailbox/folder from oldName to newName within an account.\nReturns: a confirmation naming the old and new mailbox names.\nDo not use when: creating a new folder (use create-mailbox) or deleting one (use delete-mailbox). Use list-mailboxes to confirm the current name.\nSafety: renames a real folder in the mail account — confirm oldName matches exactly (case-sensitive) before calling.",
    inputSchema: {
      oldName: z.string().min(1, "Current mailbox name is required"),
      newName: z.string().min(1, "New mailbox name is required"),
      account: z.string().optional().describe("Account containing the mailbox"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      oldName: z.string().optional(),
      newName: z.string().optional(),
    },
  },
  withErrorHandling(async ({ oldName, newName, account }) => {
    if (isImapAccount(account)) {
      const r = await imapRenameMailbox(oldName, newName, { account });
      if (!r.success) {
        return errorResponse(r.error || `Failed to rename mailbox "${oldName}" to "${newName}"`);
      }
      return successResponse(r.info || `Mailbox renamed from "${oldName}" to "${newName}"`, {
        ok: true,
        oldName,
        newName,
      });
    }

    const { success, error } = mailManager.renameMailbox(oldName, newName, account);

    if (!success) {
      return errorResponse(error || `Failed to rename mailbox "${oldName}" to "${newName}"`);
    }

    return successResponse(`Mailbox renamed from "${oldName}" to "${newName}"`, {
      ok: true,
      oldName,
      newName,
    });
  }, "Error renaming mailbox")
);

// --- list-smart-mailboxes (intelligente Postfächer) ---

server.registerTool(
  "list-smart-mailboxes",
  {
    description:
      "Use when: listing Apple Mail smart mailboxes (criteria-based virtual views), including on German-localized macOS where AppleScript's smart-mailbox terms do not compile.\nReturns: each smart mailbox's name and a short criteria summary.\nDo not use when: listing real folders/mailboxes (use list-mailboxes).",
    inputSchema: {},
    outputSchema: {
      count: z.number().optional(),
      smartMailboxes: z
        .array(
          z.object({
            name: z.string(),
            id: z.string().optional(),
            criteriaSummary: z.string().optional(),
          })
        )
        .optional(),
    },
  },
  withErrorHandling(() => {
    const list = mailManager.listSmartMailboxes();
    if (list.length === 0) {
      return successResponse("No smart mailboxes found", { count: 0, smartMailboxes: [] });
    }
    const lines = list
      .map((s) => `  - ${s.name}${s.criteriaSummary ? ` (${s.criteriaSummary})` : ""}`)
      .join("\n");
    return successResponse(`Found ${list.length} smart mailbox(es):\n${lines}`, {
      count: list.length,
      smartMailboxes: list.map((s) => ({
        name: s.name,
        id: s.id,
        criteriaSummary: s.criteriaSummary,
      })),
    });
  }, "Error listing smart mailboxes")
);

// --- create-smart-mailbox ---

server.registerTool(
  "create-smart-mailbox",
  {
    description:
      "Use when: creating an Apple Mail smart mailbox (a criteria-based virtual view) that matches a sender, subject, or body substring — works on German-localized macOS where AppleScript's smart-mailbox terms fail.\nReturns: confirmation of creation, or a note that a smart mailbox with that name already existed.\nDo not use when: creating a real folder (use create-mailbox).\nSafety: edits Apple Mail's SyncedSmartMailboxes.plist directly. It backs the file up (.bak) and writes atomically, and never rewrites your existing smart mailboxes. It does not quit Mail — quit Mail first for reliable results, since a running Mail may not show the new smart mailbox until relaunched and can overwrite plist edits it did not make.",
    inputSchema: {
      name: z.string().min(1, "Smart mailbox name is required"),
      fromContains: z.string().optional().describe("Match sender (From contains)"),
      subjectContains: z.string().optional().describe("Match subject (contains)"),
      bodyContains: z.string().optional().describe("Match body (contains)"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      name: z.string().optional(),
      alreadyExisted: z.boolean().optional(),
    },
  },
  withErrorHandling(({ name, fromContains, subjectContains, bodyContains }) => {
    if (!fromContains && !subjectContains && !bodyContains) {
      return errorResponse("Provide at least one of fromContains / subjectContains / bodyContains");
    }
    const r = mailManager.createSmartMailbox(
      name,
      fromContains || "",
      subjectContains || "",
      bodyContains || ""
    );
    if (r.alreadyExisted) {
      return successResponse(`Smart mailbox "${name}" already exists`, {
        ok: true,
        name,
        alreadyExisted: true,
      });
    }
    if (!r.created) {
      return errorResponse(r.error || `Failed to create smart mailbox "${name}"`);
    }
    return successResponse(`Smart mailbox "${name}" created. Quit and reopen Mail to see it.`, {
      ok: true,
      name,
      alreadyExisted: false,
    });
  }, "Error creating smart mailbox")
);

// --- delete-smart-mailbox ---

server.registerTool(
  "delete-smart-mailbox",
  {
    description:
      "Use when: deleting an Apple Mail smart mailbox (virtual view) by name.\nReturns: confirmation of deletion.\nDo not use when: deleting a real folder (use delete-mailbox) or messages (use delete-message / batch-delete-messages).\nSafety: destructive — removes the smart mailbox from Apple Mail's SyncedSmartMailboxes.plist. It backs the file up (.bak) and writes atomically, preserving every other smart mailbox, but the removal is not undoable in-app. Confirm the exact name with list-smart-mailboxes first, and quit Mail first for reliable results.",
    inputSchema: {
      name: z.string().min(1, "Smart mailbox name is required"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      name: z.string().optional(),
    },
  },
  withErrorHandling(({ name }) => {
    const r = mailManager.deleteSmartMailbox(name);
    if (!r.deleted) {
      return errorResponse(r.error || `Failed to delete smart mailbox "${name}"`);
    }
    return successResponse(`Smart mailbox "${name}" deleted. Quit and reopen Mail to refresh.`, {
      ok: true,
      name,
    });
  }, "Error deleting smart mailbox")
);

// --- create-newsletter-smart-mailboxes (the main use-case: from Inbox) ---

server.registerTool(
  "create-newsletter-smart-mailboxes",
  {
    description:
      'Use when: auto-discovering newsletter/bulk senders in your INBOX(es) and (optionally) creating a dedicated smart mailbox per sender (named "NL: <sender>"). Defaults to a safe dry run that only proposes.\nReturns: the proposed or created smart mailboxes with their match scores.\nDo not use when: you already know the exact sender (use create-smart-mailbox) or want real folders (use create-mailbox).\nSafety: with dryRun=false it edits Apple Mail\'s SyncedSmartMailboxes.plist (backed up, atomic, existing entries preserved) and can create many smart mailboxes at once — review a dryRun first. It scans up to ~400 recent messages per inbox via AppleScript, which can be slow on large mailboxes.',
    inputSchema: {
      dryRun: z
        .boolean()
        .default(true)
        .describe("If true (default), only propose; if false, actually create"),
      minCount: z
        .number()
        .int()
        .min(1)
        .default(3)
        .describe("Minimum messages from sender in the period"),
      days: z.number().int().min(1).default(90).describe("Look back this many days in INBOXes"),
    },
    outputSchema: {
      dryRun: z.boolean().optional(),
      count: z.number().optional(),
    },
  },
  withErrorHandling(({ dryRun, minCount, days }) => {
    const result = mailManager.createNewsletterSmartMailboxes(!!dryRun, minCount, days);
    const lines = result.createdOrProposed
      .map(
        (c: any) =>
          `  - ${c.name || c.suggestedName || c.email} (score ${c.score ?? "?"}${c.wouldCreate ? ", dry-run" : c.alreadyExisted ? ", already existed" : c.error ? `, error: ${c.error}` : ""})`
      )
      .join("\n");
    const prefix = result.dryRun ? "DRY RUN - would create" : "Created";
    return successResponse(
      `${prefix} ${result.count} newsletter smart mailbox(es):\n${lines || "  (none met the threshold)"}`,
      { dryRun: result.dryRun, count: result.count }
    );
  }, "Error creating newsletter smart mailboxes")
);

// =============================================================================
// Account Tools
// =============================================================================

// --- list-accounts ---

server.registerTool(
  "list-accounts",
  {
    description:
      "Use when: discovering the configured Mail accounts (e.g. iCloud, Gmail) so you can pass an exact account name to other tools.\nReturns: the account names and a count.\nDo not use when: you want the folders within an account (use list-mailboxes) or messages (use list-messages / search-messages).",
    inputSchema: {},
    outputSchema: {
      accounts: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
    },
  },
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

server.registerTool(
  "list-rules",
  {
    description:
      "Use when: discovering the Mail rules that exist and whether each is enabled or disabled, e.g. before enabling/disabling/deleting one.\nReturns: each rule's name and enabled/disabled state.\nDo not use when: you want to change a rule (use enable-rule / disable-rule / create-rule / delete-rule).",
    inputSchema: {},
    outputSchema: {
      rules: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
    },
  },
  withErrorHandling(() => {
    const rules = mailManager.listRules();
    const structured = {
      rules: rules.map((r) => ({ name: r.name, enabled: r.enabled })),
      count: rules.length,
    };

    if (rules.length === 0) {
      return successResponse("No mail rules found", structured);
    }

    const ruleList = rules
      .map((r) => `  - ${r.name} [${r.enabled ? "enabled" : "disabled"}]`)
      .join("\n");

    return successResponse(`Found ${rules.length} rule(s):\n${ruleList}`, structured);
  }, "Error listing rules")
);

// --- enable-rule ---

server.registerTool(
  "enable-rule",
  {
    description:
      "Use when: turning on an existing Mail rule by name.\nReturns: a confirmation that the rule was enabled.\nDo not use when: turning a rule off (use disable-rule), creating one (use create-rule), or deleting one (use delete-rule). Use list-rules to confirm the exact rule name.",
    inputSchema: {
      name: z.string().min(1, "Rule name is required"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      name: z.string().optional(),
      enabled: z.boolean().optional(),
    },
  },
  withErrorHandling(({ name }) => {
    const success = mailManager.setRuleEnabled(name, true);

    if (!success) {
      return errorResponse(`Failed to enable rule "${name}"`);
    }

    return successResponse(`Rule "${name}" enabled`, { ok: true, name, enabled: true });
  }, "Error enabling rule")
);

// --- disable-rule ---

server.registerTool(
  "disable-rule",
  {
    description:
      "Use when: turning off an existing Mail rule by name (without deleting it).\nReturns: a confirmation that the rule was disabled.\nDo not use when: turning a rule on (use enable-rule), creating one (use create-rule), or removing it permanently (use delete-rule). Use list-rules to confirm the exact rule name.",
    inputSchema: {
      name: z.string().min(1, "Rule name is required"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      name: z.string().optional(),
      enabled: z.boolean().optional(),
    },
  },
  withErrorHandling(({ name }) => {
    const success = mailManager.setRuleEnabled(name, false);

    if (!success) {
      return errorResponse(`Failed to disable rule "${name}"`);
    }

    return successResponse(`Rule "${name}" disabled`, { ok: true, name, enabled: false });
  }, "Error disabling rule")
);

// --- create-rule ---

server.registerTool(
  "create-rule",
  {
    description:
      "Use when: creating a new Mail rule with one or more conditions (field/operator/value) and at least one action (markRead, markFlagged, delete, or moveTo). Set matchAll to require all conditions vs. any.\nReturns: a confirmation naming the rule and its condition count.\nDo not use when: toggling an existing rule (use enable-rule / disable-rule) or removing one (use delete-rule). Use list-rules to avoid duplicating an existing rule.\nSafety: creates a rule that automatically acts on real mail (including delete/move actions) on an ongoing basis — confirm the conditions and actions with the user before calling.",
    inputSchema: {
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
    outputSchema: {
      name: z.string().optional(),
      created: z.boolean().optional(),
    },
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

server.registerTool(
  "delete-rule",
  {
    description:
      "Use when: permanently removing a Mail rule by name.\nReturns: a confirmation that the rule was deleted.\nDo not use when: you only want to pause it (use disable-rule) or create one (use create-rule).\nSafety: destructive — the rule is removed permanently. Require explicit user confirmation and use list-rules first to confirm the exact name.",
    inputSchema: {
      name: z.string().min(1, "Rule name is required"),
    },
    outputSchema: {
      name: z.string().optional(),
      deleted: z.boolean().optional(),
    },
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

server.registerTool(
  "search-contacts",
  {
    description:
      "Use when: looking up a person in Contacts by name, organization, nickname, or email to find their email address(es)/phone(s) before composing or sending mail. Reads the macOS Contacts database directly (needs Full Disk Access; does NOT require Contacts.app to be running or an Automation / Apple-Events grant).\nReturns: matching contacts with their names, email addresses, and phone numbers.\nDo not use when: searching email messages (use search-messages) — this queries Contacts, not the mailbox.",
    inputSchema: {
      query: z.string().min(1, "Search query is required"),
    },
    outputSchema: {
      contacts: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
    },
  },
  withErrorHandling(({ query }) => {
    const contacts = mailManager.searchContacts(query);
    // Phones are read by the same query that reads emails (contactsDb PHONES_SQL),
    // so surfacing them costs nothing — and the tool description, README and
    // CLAUDE.md have always promised them.
    const structured = {
      contacts: contacts.map((c) => ({ name: c.name, emails: c.emails, phones: c.phones })),
      count: contacts.length,
    };

    if (contacts.length === 0) {
      return successResponse("No contacts found", structured);
    }

    const contactList = contacts
      .map((c) => {
        const emails = c.emails.length > 0 ? c.emails.join(", ") : "no email";
        const phones = c.phones.length > 0 ? `; ${c.phones.join(", ")}` : "";
        return `  - ${c.name} (${emails}${phones})`;
      })
      .join("\n");

    return successResponse(`Found ${contacts.length} contact(s):\n${contactList}`, structured);
  }, "Error searching contacts")
);

// =============================================================================
// Email Template Tools
// =============================================================================

// --- save-template ---

server.registerTool(
  "save-template",
  {
    description:
      "Use when: creating a reusable email template (name, subject, body, optional default to/cc), or updating one by passing its existing id. Subject/body may contain placeholders for later use.\nReturns: the saved template's name and id (reuse the id with use-template / get-template / delete-template).\nDo not use when: composing a one-off message (use create-draft / send-email) or filling in a template to send (use use-template).\nSafety: writes the template to the on-disk templates store (APPLE_MAIL_MCP_TEMPLATES_FILE) and persists across restarts; passing an existing id overwrites that template.",
    inputSchema: {
      name: z.string().min(1, "Template name is required"),
      subject: z.string().min(1, "Subject is required"),
      body: z.string().min(1, "Body is required"),
      to: z.array(z.string()).optional().describe("Default recipients"),
      cc: z.array(z.string()).optional().describe("Default CC recipients"),
      id: z.string().optional().describe("Template ID (for updating existing template)"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
    },
  },
  withErrorHandling(({ name, subject, body, to, cc, id }) => {
    const template = mailManager.saveTemplate(name, subject, body, to, cc, id);

    return successResponse(`Template "${template.name}" saved with ID: ${template.id}`, {
      ok: true,
      id: template.id,
      name: template.name,
    });
  }, "Error saving template")
);

// --- list-templates ---

server.registerTool(
  "list-templates",
  {
    description:
      "Use when: discovering the saved email templates and their ids, e.g. before using or editing one.\nReturns: each template's id, name, and subject.\nDo not use when: you want a single template's full body (use get-template) or want to apply one (use use-template).",
    inputSchema: {},
    outputSchema: {
      templates: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
    },
  },
  withErrorHandling(() => {
    const templates = mailManager.listTemplates();
    const structured = {
      templates: templates.map((t) => ({ id: t.id, name: t.name, subject: t.subject })),
      count: templates.length,
    };

    if (templates.length === 0) {
      return successResponse("No templates saved", structured);
    }

    const templateList = templates
      .map((t) => `  - [${t.id}] ${t.name} — "${t.subject}"`)
      .join("\n");

    return successResponse(`Found ${templates.length} template(s):\n${templateList}`, structured);
  }, "Error listing templates")
);

// --- get-template ---

server.registerTool(
  "get-template",
  {
    description:
      "Use when: reading the full contents of one saved template by id — its name, subject, default to/cc, and body.\nReturns: the template's name, subject, default recipients, and body text.\nDo not use when: you don't have the id (use list-templates first) or want to apply the template into a draft (use use-template).",
    inputSchema: {
      id: z.string().min(1, "Template ID is required"),
    },
    outputSchema: {
      id: z.string().optional(),
      name: z.string().optional(),
      subject: z.string().optional(),
      to: z.array(z.string()).optional(),
      cc: z.array(z.string()).optional(),
      body: z.string().optional(),
    },
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

    return successResponse(lines, {
      id: template.id,
      name: template.name,
      subject: template.subject,
      to: template.to ?? [],
      cc: template.cc ?? [],
      body: template.body,
    });
  }, "Error getting template")
);

// --- delete-template ---

server.registerTool(
  "delete-template",
  {
    description:
      "Use when: permanently removing a saved email template by id.\nReturns: a confirmation that the template was deleted.\nDo not use when: you only want to view it (use get-template) or update it (use save-template with the existing id).\nSafety: destructive — removes the template from the on-disk store permanently. Require explicit user confirmation and use list-templates first to confirm the id.",
    inputSchema: {
      id: z.string().min(1, "Template ID is required"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      id: z.string().optional(),
    },
  },
  withErrorHandling(({ id }) => {
    const success = mailManager.deleteTemplate(id);

    if (!success) {
      return errorResponse(`Template "${id}" not found`);
    }

    return successResponse(`Template "${id}" deleted`, { ok: true, id });
  }, "Error deleting template")
);

// --- use-template ---

server.registerTool(
  "use-template",
  {
    description:
      "Use when: composing a new draft from a saved template (by id), optionally overriding the recipients, subject, or body. Creates a draft in Mail.app for the user to review and send.\nReturns: a confirmation that a draft was created from the template.\nDo not use when: you want to inspect the template without composing (use get-template) or send immediately without a draft (use send-email).",
    inputSchema: {
      id: z.string().min(1, "Template ID is required"),
      to: z.array(z.string()).optional().describe("Override recipients"),
      cc: z.array(z.string()).optional().describe("Override CC recipients"),
      subject: z.string().optional().describe("Override subject"),
      body: z.string().optional().describe("Override body"),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      id: z.string().optional(),
    },
  },
  withErrorHandling(({ id, to, cc, subject, body }) => {
    const success = mailManager.useTemplate(id, { to, cc, subject, body });

    if (!success) {
      return errorResponse(`Failed to use template "${id}". Template not found or no recipients.`);
    }

    return successResponse(`Draft created from template "${id}"`, { ok: true, id });
  }, "Error using template")
);

// =============================================================================
// Diagnostics Tools
// =============================================================================

// --- health-check ---

server.registerTool(
  "health-check",
  {
    description:
      "Use when: doing a quick check that Mail.app is reachable and the server's basic checks pass.\nReturns: an overall healthy/unhealthy status with a pass/fail line per check.\nDo not use when: you need detailed permission/account/IMAP/SMTP diagnostics with remediation steps (use doctor).",
    inputSchema: {},
    outputSchema: {
      healthy: z.boolean().optional(),
      checks: z.array(CHECK_ITEM_SCHEMA).optional(),
    },
  },
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

    return successResponse(`${statusIcon} ${statusText}\n\n${checkLines}`, { ...result });
  }, "Error running health check")
);

// --- doctor ---

server.registerTool(
  "doctor",
  {
    description:
      "Use when: troubleshooting setup problems — diagnoses Mail.app automation permissions, account state, and the IMAP/SMTP backends with actionable remediation messages.\nReturns: a detailed diagnostic report (formatted text plus structured checks).\nDo not use when: you just want a quick up/down status (use health-check) or message counts (use get-mail-stats).",
    inputSchema: {},
    outputSchema: {
      healthy: z.boolean().optional(),
      checks: z.array(CHECK_ITEM_SCHEMA).optional(),
    },
  },
  withErrorHandling(async () => {
    // Diagnoses Mail.app permission, account state, and the IMAP/SMTP backends
    // with actionable messages (C3). structuredContent carries the raw checks.
    const report = await runDoctor(mailManager);
    return successResponse(formatDoctorReport(report), { ...report });
  }, "Error running doctor")
);

// --- get-mail-stats ---

server.registerTool(
  "get-mail-stats",
  {
    description:
      "Use when: you want aggregate mailbox statistics — total and unread message counts, recently-received counts (last 24h/7d/30d), and (for the all-accounts path) a per-account breakdown.\nReturns: totals, unread counts, recent-activity counts, and per-account figures.\nDo not use when: you only need a single unread number (use get-unread-count) or want to list the messages themselves (use list-messages / search-messages).",
    inputSchema: {
      account: z
        .string()
        .optional()
        .describe("Limit to one account; uses fast IMAP STATUS if that account is IMAP-configured"),
    },
    outputSchema: {
      account: z.string().optional(),
      totalMessages: z.number().optional(),
      totalUnread: z.number().optional(),
      accounts: z.array(z.object({}).passthrough()).optional(),
      recentlyReceived: z.object({}).passthrough().optional(),
      recent: z.object({}).passthrough().optional(),
    },
  },
  withErrorHandling(async ({ account }) => {
    // IMAP (I3): for a named IMAP account, STATUS gives authoritative counts and
    // SEARCH SINCE gives recent activity — fast even on huge mailboxes.
    //   - explicit IMAP account → IMAP STATUS for that account (today's path);
    //   - explicit non-IMAP account → AppleScript all-accounts stats below;
    //   - no account + IMAP configured → MERGE: sum IMAP STATUS over every
    //     configured account + AppleScript per-account stats for the accounts
    //     IMAP does NOT cover (partitioned so no account is double-counted).
    if (account !== undefined && isImapAccount(account)) {
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

    if (account === undefined && shouldUseImap(account)) {
      let totalMessages = 0;
      let totalUnread = 0;
      const recent = { last24h: 0, last7d: 0, last30d: 0 };
      const perAccount: {
        name: string;
        totalMessages: number;
        unreadMessages: number;
        backend: string;
      }[] = [];
      // ACCOUNT-CENTRIC: each account counted via exactly ONE source so a
      // heuristic mis-match can't double-count. IMAP sources use STATUS; the
      // AppleScript sources are built from listMailboxes (same source
      // getMailStats uses) — never getMailStats(), which is all-accounts and
      // would re-count the IMAP-covered ones. Recently-received from AppleScript
      // is INBOX-wide (not per-account), so it's omitted for AppleScript sources;
      // IMAP's per-account recent IS included.
      const sources = planCountSources(mailManager.listAccounts(), resolveImapConfigs());
      for (const src of sources) {
        if (src.kind === "imap") {
          try {
            const s = await imapMailStats({ config: src.config });
            totalMessages += s.totalMessages;
            totalUnread += s.totalUnread;
            recent.last24h += s.recent.last24h;
            recent.last7d += s.recent.last7d;
            recent.last30d += s.recent.last30d;
            perAccount.push({
              name: src.label,
              totalMessages: s.totalMessages,
              unreadMessages: s.totalUnread,
              backend: "imap",
            });
          } catch (e) {
            console.error(`IMAP mail-stats failed for "${src.label}": ${String(e)}`);
          }
        } else {
          let m = 0;
          let u = 0;
          for (const mb of mailManager.listMailboxes(src.account.name)) {
            m += mb.messageCount;
            u += mb.unreadCount;
          }
          totalMessages += m;
          totalUnread += u;
          perAccount.push({
            name: src.label,
            totalMessages: m,
            unreadMessages: u,
            backend: "applescript",
          });
        }
      }
      const lines = [
        `📊 Mail Statistics (merged: IMAP + AppleScript)`,
        `══════════════════`,
        `Total messages: ${totalMessages}`,
        `Unread messages: ${totalUnread}`,
        ``,
        `📥 Recently Received (IMAP INBOXes):`,
        `  Last 24 hours: ${recent.last24h}`,
        `  Last 7 days: ${recent.last7d}`,
        `  Last 30 days: ${recent.last30d}`,
        ``,
        `📁 By Account:`,
        ...perAccount.map(
          (a) =>
            `  ${a.name}: ${a.totalMessages} messages (${a.unreadMessages} unread) [${a.backend}]`
        ),
      ];
      return successResponse(lines.join("\n"), {
        totalMessages,
        totalUnread,
        accounts: perAccount,
        recent,
      });
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

server.registerTool(
  "get-sync-status",
  {
    description:
      "Use when: checking whether Mail.app is running and actively syncing, e.g. to explain why new mail hasn't appeared yet.\nReturns: whether Mail.app is running and whether sync activity was detected.\nDo not use when: you need message counts (use get-mail-stats) or a full setup diagnosis (use doctor).",
    inputSchema: {},
    outputSchema: {
      syncDetected: z.boolean().optional(),
      pendingUpload: z.number().optional(),
      recentActivity: z.boolean().optional(),
      secondsSinceLastChange: z.number().optional(),
      error: z.string().optional(),
    },
  },
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
// Defense-in-depth: a stray EventEmitter "error" (e.g. an idle IMAP/SMTP socket
// drop) or an unhandled rejection must never take down this long-lived MCP
// server. EPIPE on stdout means the MCP client went away — exit cleanly.
process.on("uncaughtException", (err) => {
  if ((err as NodeJS.ErrnoException)?.code === "EPIPE") process.exit(0);
  console.error("[uncaughtException]", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

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

// Clean shutdown: close BOTH the IDLE watcher's connections AND the request
// pool's pooled sockets, so we never leave IMAP connections occupying slots
// against the server's per-account limit. Triggered on SIGINT/SIGTERM (parent
// kills us) AND on stdin EOF (the MCP client/parent went away) — the latter
// prevents this process lingering as an orphan that keeps holding IMAP
// connections after its Claude session is gone, which is how connections piled
// up past Gmail's per-account limit.
let _shuttingDown = false;
const shutdown = (): void => {
  if (_shuttingDown) return;
  _shuttingDown = true;
  // Stop the parent-death watchdog (defined just below) so it can't re-enter.
  clearInterval(orphanWatchdog);
  const force = setTimeout(() => process.exit(0), 2000);
  force.unref?.();
  // Closing the IDLE watcher logs out its dedicated per-account connections
  // (one persistent socket per account when APPLE_MAIL_MCP_IMAP_IDLE=1) and
  // dropAllPools() closes the request pool — together this releases EVERY IMAP
  // socket this instance holds, which is the whole point of the orphan check.
  void Promise.allSettled([idleWatcher?.stop() ?? Promise.resolve(), dropAllPools()]).finally(() =>
    process.exit(0)
  );
};
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, shutdown);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

// Parent-death watchdog (connection-footprint hardening, v2.6.1). The exit
// paths above all rely on a signal or stdin-EOF, but a host (claude-code) that
// is force-quit or crashes delivers neither — leaving this process orphaned and
// still holding its IMAP sockets (the IDLE watcher's per-account connections
// and/or pooled request connections) against Gmail's ~15-per-account cap, which
// can starve Apple Mail of connection slots. On macOS an orphan is reparented to
// launchd (ppid 1), so poll for that and self-shutdown. At normal startup ppid
// is the real parent, so this never misfires; it's unref'd (never keeps the
// event loop alive) and is cleared in shutdown(). `shutdown` only reads this
// binding at runtime (long after it's initialized), so the forward reference is
// safe.
const orphanWatchdog: NodeJS.Timeout = setInterval(() => {
  if (isOrphaned()) shutdown();
}, 30_000);
orphanWatchdog.unref?.();
