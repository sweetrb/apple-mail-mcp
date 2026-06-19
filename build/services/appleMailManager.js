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
import { spawnSync } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { isAbsolute, resolve, sep } from "path";
import { homedir } from "os";
import { executeAppleScript } from "../utils/applescript.js";
import { parseMimeAttachments, extractMimeAttachment, extractHtmlBody } from "../utils/mimeParse.js";
import { TemplateStore } from "../services/templateStore.js";
// =============================================================================
// Search Tuning (issue #24)
// =============================================================================
/**
 * Mailboxes larger than this are skipped during an unscoped (all-mailboxes)
 * search rather than scanned. Apple Mail's AppleScript bridge cannot search a
 * mailbox of this size before the Apple Event timeout fires — empirically even
 * reading the newest 20 messages of a 44k-message Gmail mailbox took ~47s — so
 * attempting it only burns the time budget and yields a misleading empty
 * result. `count of messages` is cheap (Mail keeps it cached), so the guard is
 * effectively free. The skipped mailboxes are reported back to the caller.
 *
 * Override with APPLE_MAIL_MAX_SEARCH_MAILBOX (set to 0 to disable the guard).
 */
function getMailboxScanThreshold() {
    const raw = process.env.APPLE_MAIL_MAX_SEARCH_MAILBOX;
    if (raw !== undefined) {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0)
            return n;
    }
    return 5000;
}
/**
 * Per-account wall-clock budget (seconds) enforced *inside* the AppleScript so
 * a single account can't consume minutes. Kept comfortably below the osascript
 * process timeout (see searchMessages) so the script exits and reports a
 * partial result rather than being SIGKILLed with no diagnostics.
 */
const SEARCH_ACCOUNT_BUDGET_SECONDS = 30;
/** osascript process timeout for a per-account search (ms). */
const SEARCH_ACCOUNT_TIMEOUT_MS = 45000;
/**
 * Result serialization separators (issue #30).
 *
 * AppleScript emits structured results as delimited strings that TS then splits.
 * The original delimiters were printable triple-pipe tokens, so any field value
 * that itself contained one — a subject, sender, attachment filename, or mailbox
 * name with a triple-pipe in it — shifted every subsequent field and silently
 * corrupted the parse. These are now ASCII control characters
 * (Unit/Record/Group Separator) which cannot occur in mail field values, so the
 * collision is structurally impossible. The same constant is used by the
 * AppleScript emitter (interpolated into the script string) and the TS parser,
 * so the two can never drift.
 */
const FIELD_SEP = "\x1f"; // US — between fields within a record
const RECORD_SEP = "\x1e"; // RS — between records
const DIAG_MARKER = "\x1dDIAG\x1d"; // GS-wrapped — payload/diagnostics boundary
const DIAG_FIELD_SEP = "\x1dF\x1d"; // between diagnostics fields
const DIAG_ITEM_SEP = "\x1dM\x1d"; // between diagnostics list items
const CONTENT_MARKER = "\x1dCONTENT\x1d"; // subject/plain-text boundary
const HTML_MARKER = "\x1dHTML\x1d"; // plain-text/source boundary
const BATCH_FATAL = "\x1dFATAL\x1d"; // prefix for a whole-batch failure (e.g. bad destination)
/**
 * Merge a per-account SearchDiagnostics into an aggregate (all-accounts) one.
 *
 * Exported for unit testing.
 */
export function mergeSearchDiagnostics(into, from) {
    into.timedOutAccounts.push(...from.timedOutAccounts);
    into.skippedLargeMailboxes.push(...from.skippedLargeMailboxes);
    into.notSearchedMailboxes.push(...from.notSearchedMailboxes);
    if (from.partial)
        into.partial = true;
}
/**
 * Split a per-account search payload into its message-list portion and parsed
 * diagnostics. The AppleScript appends a trailer of the form (using the
 * control-character separators defined above):
 *
 *   <messages>{DIAG_MARKER}timedOut=true{DIAG_FIELD_SEP}skipped=Foo (9000){DIAG_ITEM_SEP}{DIAG_FIELD_SEP}notSearched=Bar{DIAG_ITEM_SEP}
 *
 * `skipped`/`notSearched` are DIAG_ITEM_SEP-separated mailbox names, each prefixed
 * with the account name on the way out so the aggregate result is unambiguous.
 *
 * Exported (pure, no Mail.app dependency) for unit testing — this is the logic
 * that turns a swallowed timeout into a visible partial result (issue #24).
 */
export function splitSearchDiagnostics(output, account) {
    const markerIdx = output.lastIndexOf(DIAG_MARKER);
    const payload = markerIdx >= 0 ? output.slice(0, markerIdx) : output;
    const trailer = markerIdx >= 0 ? output.slice(markerIdx + DIAG_MARKER.length) : "";
    const diagnostics = {
        partial: false,
        timedOutAccounts: [],
        skippedLargeMailboxes: [],
        notSearchedMailboxes: [],
    };
    if (trailer) {
        const fields = trailer.split(DIAG_FIELD_SEP);
        const getField = (key) => {
            const f = fields.find((x) => x.startsWith(`${key}=`));
            return f ? f.slice(key.length + 1) : "";
        };
        const splitList = (raw) => raw
            .split(DIAG_ITEM_SEP)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        diagnostics.skippedLargeMailboxes = splitList(getField("skipped")).map((mb) => `${account} / ${mb}`);
        diagnostics.notSearchedMailboxes = splitList(getField("notSearched")).map((mb) => `${account} / ${mb}`);
        if (getField("timedOut") === "true")
            diagnostics.partial = true;
    }
    if (diagnostics.skippedLargeMailboxes.length > 0 || diagnostics.notSearchedMailboxes.length > 0) {
        diagnostics.partial = true;
    }
    return { payload, diagnostics };
}
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
/**
 * Roots under which `save-attachment` is permitted to write.
 */
const ALLOWED_SAVE_ROOTS = [homedir(), "/tmp", "/private/tmp", "/Volumes"];
/**
 * True if `resolvedPath` is one of the allowed roots or strictly inside one.
 *
 * Uses a path-segment boundary check rather than a bare `startsWith`, which
 * would let a sibling whose name merely shares the prefix slip through —
 * `/Volumes-evil` startsWith `/Volumes`, `/Users/robother` startsWith
 * `/Users/rob` (audit finding #12). `resolvedPath` must already be absolute
 * (caller passes `resolve(...)` output).
 */
export function isPathWithinAllowedRoots(resolvedPath) {
    return ALLOWED_SAVE_ROOTS.some((root) => {
        const base = root.endsWith(sep) ? root.slice(0, -1) : root;
        return resolvedPath === base || resolvedPath.startsWith(base + sep);
    });
}
/**
 * Pattern in a raw AppleScript error that indicates an operation Mail.app's
 * scripting interface simply cannot perform on this target — most often a
 * server-side (IMAP / Gmail / Workspace / iCloud / Exchange) mailbox or a draft.
 * Mail throws `AppleEvent handler failed` (-10000) for these; the GUI can do
 * them, the scripting bridge cannot. See issue #42 and the audit doc.
 */
const UNSUPPORTED_APPLESCRIPT_OP = /AppleEvent handler failed|-10000/i;
/**
 * Turn a raw mailbox delete/rename failure into an actionable, non-retryable
 * message when it's the known server-side-mailbox limitation (#42); otherwise
 * return the raw error unchanged.
 *
 * Exported for unit testing.
 */
export function describeMailboxOpError(op, raw) {
    const trimmed = (raw || "").trim();
    if (UNSUPPORTED_APPLESCRIPT_OP.test(trimmed)) {
        const verb = op === "delete" ? "Delete" : "Rename";
        return `Mail.app cannot ${op} server-side (IMAP / Gmail / Workspace / iCloud / Exchange) mailboxes via AppleScript — only local "On My Mac" mailboxes support this. ${verb} it in Mail.app directly. (Mail.app error: ${trimmed})`;
    }
    return trimmed || `Failed to ${op} mailbox`;
}
/** Env var to pin the default account (matched by account name or email). */
export const DEFAULT_ACCOUNT_ENV = "APPLE_MAIL_MCP_DEFAULT_ACCOUNT";
/**
 * Choose the account to use when a tool call omits `account`.
 *
 * Priority: explicit `override` (by name or email) → Mail's default-send
 * account *if enabled* → first enabled account → first account → null. The key
 * guarantee (issue #47): a **disabled** account is never chosen implicitly — it
 * can only be selected via an explicit override (deliberate user intent) or as
 * a last resort when no account is enabled. This prevents operations silently
 * landing in a configured-but-disabled account (e.g. an unused iCloud account
 * that's still addressable via AppleScript).
 *
 * Pure/exported for unit testing.
 */
export function chooseDefaultAccount(accounts, opts = {}) {
    const norm = (s) => s.trim().toLowerCase();
    const override = opts.override?.trim();
    if (override) {
        const o = norm(override);
        const m = accounts.find((a) => norm(a.name) === o || norm(a.email) === o);
        if (m)
            return m.name; // honor an explicit pin even if that account is disabled
    }
    if (opts.defaultSendEmail) {
        const e = norm(opts.defaultSendEmail);
        const m = accounts.find((a) => norm(a.email) === e);
        if (m && m.enabled)
            return m.name;
    }
    const firstEnabled = accounts.find((a) => a.enabled);
    if (firstEnabled)
        return firstEnabled.name;
    return accounts[0]?.name ?? null;
}
export function escapeForAppleScript(text) {
    if (!text)
        return "";
    // Escape backslash and double-quote for the AppleScript string literal, and
    // strip ASCII control characters. An AppleScript double-quoted literal cannot
    // contain a raw newline, so an interpolated value with a `\n` (or other
    // control char) would terminate the literal early and could inject a
    // statement; stripping them closes that gap (audit finding #10).
    return (text
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, ""));
}
/**
 * Validates attachment file paths and builds AppleScript commands to attach them.
 *
 * @param attachments - Absolute file paths to attach
 * @returns AppleScript commands to add attachments, or empty string if none
 * @throws Error if any path is not absolute or does not exist
 */
function buildAttachmentCommands(attachments) {
    if (!attachments || attachments.length === 0)
        return "";
    for (const filePath of attachments) {
        if (!isAbsolute(filePath)) {
            throw new Error(`Attachment path must be absolute: "${filePath}"`);
        }
        if (!existsSync(filePath)) {
            throw new Error(`Attachment file not found: "${filePath}"`);
        }
    }
    let commands = "";
    for (const filePath of attachments) {
        const safePath = escapeForAppleScript(filePath);
        commands += `make new attachment with properties {file name:POSIX file "${safePath}"} at after the last paragraph\n`;
    }
    return commands;
}
/**
 * AppleScript snippet that converts a date variable `d` into a
 * locale-independent numeric string: "YYYY-M-D-H-m-s".
 * Use: set d to date received of msg, then inline this snippet.
 */
const AS_DATE_TO_STRING = `((year of d) as string) & "-" & ((month of d as integer) as string) & "-" & ((day of d) as string) & "-" & ((hours of d) as string) & "-" & ((minutes of d) as string) & "-" & ((seconds of d) as string)`;
/**
 * Parses a locale-independent date string "YYYY-M-D-H-m-s"
 * produced by the AppleScript snippet above.
 *
 * Falls back to the locale-dependent `as string` format for
 * backwards compatibility, and finally to current date.
 *
 * @param dateStr - Date string from AppleScript
 * @returns Parsed Date, or current date if parsing fails
 */
function parseAppleScriptDate(dateStr) {
    // Try locale-independent numeric format first: "YYYY-M-D-H-m-s"
    const numParts = dateStr.split("-").map(Number);
    if (numParts.length === 6 && numParts.every((n) => !isNaN(n))) {
        return new Date(numParts[0], numParts[1] - 1, numParts[2], numParts[3], numParts[4], numParts[5]);
    }
    // Fallback: try legacy locale-dependent format
    const withoutPrefix = dateStr.replace(/^date\s+/, "");
    const normalized = withoutPrefix.replace(" at ", " ");
    const parsed = new Date(normalized);
    return isNaN(parsed.getTime()) ? new Date() : parsed;
}
/**
 * Emits AppleScript that builds a date into the variable `varName` from numeric
 * components.
 *
 * This is locale-independent, unlike `date "May 30, 2026"` string coercion,
 * which AppleScript parses using the system locale. On a non-English locale
 * (e.g. pt_PT) the English month name throws "Invalid date and time (-30720)";
 * because the comparison happens inside the per-message `try` in searchMessages,
 * that error is swallowed and every message is skipped, so the search returns
 * zero results even when matches exist. See issue #15.
 *
 * `day` is reset to 1 before assigning month/year so an existing day-of-month
 * (e.g. 31) cannot overflow into the next month when the month is changed.
 *
 * Exported for unit testing.
 */
export function buildAppleScriptDate(varName, d) {
    return [
        `set ${varName} to current date`,
        `set day of ${varName} to 1`,
        `set year of ${varName} to ${d.getFullYear()}`,
        `set month of ${varName} to ${d.getMonth() + 1}`,
        `set day of ${varName} to ${d.getDate()}`,
        `set hours of ${varName} to ${d.getHours()}`,
        `set minutes of ${varName} to ${d.getMinutes()}`,
        `set seconds of ${varName} to ${d.getSeconds()}`,
    ].join("\n      ");
}
/**
 * Builds an AppleScript command scoped to a specific account.
 */
function buildAccountScopedScript(account, command) {
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
function buildAppLevelScript(command) {
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
const MAILBOX_ALIASES = {
    inbox: ["INBOX", "Inbox", "inbox"],
    sent: ["Sent", "Sent Items", "Sent Messages", "SENT", "sent"],
    drafts: ["Drafts", "DRAFTS", "drafts", "Draft"],
    trash: ["Trash", "Deleted Items", "Deleted Messages", "TRASH", "trash"],
    junk: ["Junk", "Junk Email", "Spam", "JUNK", "junk"],
    archive: ["Archive", "ARCHIVE", "archive", "All Mail"],
};
/**
 * Build the AppleScript `whose` clause for searchMessages from a filter set.
 *
 * - `query` is a subject-OR-sender substring match, parenthesized so it groups
 *   correctly when ANDed with other filters.
 * - `from` and `subject` are substring matches (`sender`/`subject` contains).
 * - `isRead` / `isFlagged` are boolean status checks.
 * - Returns "" when no filters are set. Every interpolated value is escaped.
 *
 * Exported for unit testing: the bug this addresses (filters declared in the
 * tool schema but silently dropped) lived in this logic, so it gets direct
 * coverage independent of Mail.app.
 */
export function buildSearchCondition(filters) {
    const { query, from, subject, isRead, isFlagged } = filters;
    const conditions = [];
    if (query) {
        const safeQuery = escapeForAppleScript(query);
        conditions.push(`(subject contains "${safeQuery}" or sender contains "${safeQuery}")`);
    }
    if (from) {
        conditions.push(`sender contains "${escapeForAppleScript(from)}"`);
    }
    if (subject) {
        conditions.push(`subject contains "${escapeForAppleScript(subject)}"`);
    }
    if (typeof isRead === "boolean") {
        conditions.push(`read status is ${isRead ? "true" : "false"}`);
    }
    if (typeof isFlagged === "boolean") {
        conditions.push(`flagged status is ${isFlagged ? "true" : "false"}`);
    }
    return conditions.length > 0 ? `whose ${conditions.join(" and ")}` : "";
}
export class AppleMailManager {
    /**
     * Default account used when no account is specified.
     */
    defaultAccount = null;
    /**
     * TTL cache for expensive AppleScript queries that rarely change.
     * Caches account list and per-account mailbox names to avoid
     * redundant AppleScript roundtrips on every tool call.
     */
    cache = {
        accounts: null,
        mailboxNames: new Map(),
    };
    /** Cache TTL in milliseconds (60 seconds). */
    CACHE_TTL_MS = 60_000;
    /**
     * Returns cached accounts or fetches fresh data if cache is expired/empty.
     */
    getCachedAccounts() {
        const now = Date.now();
        if (this.cache.accounts && now < this.cache.accounts.expiry) {
            return this.cache.accounts.data;
        }
        const accounts = this.fetchAccounts();
        this.cache.accounts = { data: accounts, expiry: now + this.CACHE_TTL_MS };
        return accounts;
    }
    /**
     * Returns cached mailbox names for an account, or fetches fresh.
     * This caches only the name list used by resolveMailbox(), not the
     * full Mailbox objects with counts (which change frequently).
     */
    getCachedMailboxNames(account) {
        const now = Date.now();
        const cached = this.cache.mailboxNames.get(account);
        if (cached && now < cached.expiry) {
            return cached.data;
        }
        const names = this.fetchMailboxNames(account);
        this.cache.mailboxNames.set(account, { data: names, expiry: now + this.CACHE_TTL_MS });
        return names;
    }
    /**
     * Invalidate all caches. Call after operations that change
     * mailbox structure (create/delete/rename mailbox).
     */
    invalidateCache() {
        this.cache.accounts = null;
        this.cache.mailboxNames.clear();
    }
    /**
     * Resolves the account to use for an operation when the caller omits one.
     *
     * Order (see chooseDefaultAccount): the APPLE_MAIL_MCP_DEFAULT_ACCOUNT env
     * override → Mail.app's configured default-send account (if enabled) → the
     * first enabled account. A disabled account is never chosen implicitly (#47).
     */
    resolveAccount(account) {
        if (account)
            return account;
        if (this.defaultAccount)
            return this.defaultAccount;
        const accounts = this.getCachedAccounts();
        // Mail.app's default send account (inspect a throwaway outgoing message).
        let defaultSendEmail;
        const defaultResult = executeAppleScript(buildAppLevelScript(`
        set newMsg to make new outgoing message
        set fromAddr to sender of newMsg
        delete newMsg
        return fromAddr
      `));
        if (defaultResult.success && defaultResult.output.trim()) {
            // sender returns "Name <email>" — pull out the address
            const senderOutput = defaultResult.output.trim();
            const emailMatch = senderOutput.match(/<([^>]+)>/);
            defaultSendEmail = emailMatch ? emailMatch[1] : senderOutput;
        }
        const chosen = chooseDefaultAccount(accounts, {
            override: process.env[DEFAULT_ACCOUNT_ENV],
            defaultSendEmail,
        });
        if (chosen) {
            this.defaultAccount = chosen;
            return chosen;
        }
        // No accounts at all — return something rather than throw; downstream
        // AppleScript will surface a clear "account not found".
        return accounts[0]?.name ?? "iCloud";
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
    resolveMailbox(mailbox, account) {
        const actualMailboxes = this.getCachedMailboxNames(account);
        if (actualMailboxes.length === 0) {
            return mailbox; // Fall back to original
        }
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
    searchMessages(query, mailbox, account, limit = 50, dateFrom, dateTo, from, subject, isRead, isFlagged) {
        return this.searchMessagesWithDiagnostics(query, mailbox, account, limit, dateFrom, dateTo, from, subject, isRead, isFlagged).messages;
    }
    /**
     * Search for messages, returning both the matches and diagnostics describing
     * how complete the search was.
     *
     * This is the correctness fix for issue #24. The previous implementation ran
     * an unbounded `messages of mb whose <predicate>` over every mailbox in an
     * account; on large IMAP/Gmail mailboxes (tens of thousands of messages) that
     * single Apple Event exceeded the timeout, the error was swallowed by a `try`,
     * and the function returned a clean — but wrong — empty result. Callers/agents
     * then confidently reported "no such mail."
     *
     * Two changes fix that:
     *  1. Cheap count-guard: mailboxes larger than the scan threshold are skipped
     *     (Apple Mail can't search them before timing out anyway) and reported.
     *  2. Honest diagnostics: per-account/per-mailbox timeouts are surfaced as a
     *     `partial` result with the affected scopes named, instead of an empty
     *     "success."
     */
    searchMessagesWithDiagnostics(query, mailbox, account, limit = 50, dateFrom, dateTo, from, subject, isRead, isFlagged) {
        // If no account specified, search across all accounts and merge diagnostics.
        if (!account) {
            const accounts = this.listAccounts();
            const allMessages = [];
            const diagnostics = {
                partial: false,
                timedOutAccounts: [],
                skippedLargeMailboxes: [],
                notSearchedMailboxes: [],
            };
            for (const acct of accounts) {
                if (allMessages.length >= limit)
                    break;
                const remaining = limit - allMessages.length;
                const res = this.searchMessagesWithDiagnostics(query, mailbox, acct.name, remaining, dateFrom, dateTo, from, subject, isRead, isFlagged);
                allMessages.push(...res.messages);
                mergeSearchDiagnostics(diagnostics, res.diagnostics);
            }
            return { messages: allMessages.slice(0, limit), diagnostics };
        }
        const targetAccount = this.resolveAccount(account);
        // `query` is a subject-OR-sender substring match; from/subject/isRead/isFlagged
        // are additional AND filters. Date filtering stays post-fetch below — `whose`
        // date comparisons are unreliable in Mail.app AppleScript. See buildSearchCondition.
        const searchCondition = buildSearchCondition({ query, from, subject, isRead, isFlagged });
        // Build the date-bound comparison. The comparison dates are constructed in
        // AppleScript from numeric components (see buildAppleScriptDate) and compared
        // against `msgDate` (set per-message below) rather than coerced from a
        // locale-formatted string — `date "May 30, 2026"` throws on non-English system
        // locales, and that swallowed error silently zeroes out results. See issue #15.
        // dateFrom/dateTo are already validated by DATE_FILTER_SCHEMA as parseable dates.
        let dateSetup = "";
        let dateFilter = "";
        if (dateFrom || dateTo) {
            const dateChecks = [];
            if (dateFrom) {
                dateSetup += buildAppleScriptDate("_dateFrom", new Date(dateFrom)) + "\n      ";
                dateChecks.push("msgDate >= _dateFrom");
            }
            if (dateTo) {
                const to = new Date(dateTo);
                // A date-only upper bound (no time component) is treated as end-of-day so
                // messages received later that same day are still included.
                if (!/\d:\d/.test(dateTo))
                    to.setHours(23, 59, 59, 0);
                dateSetup += buildAppleScriptDate("_dateTo", to) + "\n      ";
                dateChecks.push("msgDate <= _dateTo");
            }
            dateFilter = dateChecks.join(" and ");
        }
        const scanThreshold = getMailboxScanThreshold();
        let searchCommand;
        if (mailbox) {
            // Search a specific mailbox. The caller explicitly chose this mailbox, so
            // we don't apply the count-guard skip — but we still wrap the scan so a
            // timeout is reported as a partial result rather than a false empty.
            const targetMailbox = this.resolveMailbox(mailbox, targetAccount);
            searchCommand = `
      ${dateSetup}set outputText to ""
      set _timedOut to false
      set _notSearched to ""
      set theMailbox to mailbox "${escapeForAppleScript(targetMailbox)}"
      set msgCount to 0
      try
        set allMessages to messages of theMailbox ${searchCondition}
        repeat with msg in allMessages
          if msgCount >= ${limit} then exit repeat
          try
            ${dateFilter ? `set msgDate to date received of msg\n            if not (${dateFilter}) then\n              -- skip message outside date range\n            else` : ""}
            set msgId to id of msg as string
            set msgSubject to subject of msg
            set msgSender to sender of msg
            set d to date received of msg
            set msgDateStr to ${AS_DATE_TO_STRING}
            set msgRead to read status of msg as string
            set msgFlagged to flagged status of msg as string
            if msgCount > 0 then set outputText to outputText & "${RECORD_SEP}"
            set outputText to outputText & msgId & "${FIELD_SEP}" & msgSubject & "${FIELD_SEP}" & msgSender & "${FIELD_SEP}" & msgDateStr & "${FIELD_SEP}" & msgRead & "${FIELD_SEP}" & msgFlagged
            set msgCount to msgCount + 1
            ${dateFilter ? "end if" : ""}
          end try
        end repeat
      on error _errMsg number _errNum
        set _timedOut to true
        set _notSearched to "${escapeForAppleScript(targetMailbox)}${DIAG_ITEM_SEP}"
      end try
      return outputText & "${DIAG_MARKER}timedOut=" & (_timedOut as string) & "${DIAG_FIELD_SEP}skipped=${DIAG_FIELD_SEP}notSearched=" & _notSearched
    `;
        }
        else {
            // Search ALL mailboxes — iterate every mailbox in the account, dedup by
            // message ID. Skip mailboxes that exceed the scan threshold (they can't be
            // searched before timing out), enforce a per-account wall-clock budget, and
            // capture per-mailbox timeouts. All three are reported via the DIAG trailer.
            const scanGuard = scanThreshold > 0 ? `mbCount > ${scanThreshold}` : "false";
            searchCommand = `
      ${dateSetup}set outputText to ""
      set msgCount to 0
      set seenIds to {}
      set _timedOut to false
      set _skipped to ""
      set _notSearched to ""
      set _startedAt to current date
      repeat with mb in mailboxes
        if msgCount >= ${limit} then exit repeat
        set mbName to ""
        try
          set mbName to name of mb
        end try
        if ((current date) - _startedAt) > ${SEARCH_ACCOUNT_BUDGET_SECONDS} then
          set _timedOut to true
          set _notSearched to _notSearched & mbName & "${DIAG_ITEM_SEP}"
        else
          set mbCount to 0
          try
            set mbCount to count of messages of mb
          end try
          if (${scanGuard}) then
            set _timedOut to true
            set _skipped to _skipped & mbName & " (" & (mbCount as string) & ")${DIAG_ITEM_SEP}"
          else
            try
              set allMessages to messages of mb ${searchCondition}
              repeat with msg in allMessages
                if msgCount >= ${limit} then exit repeat
                try
                  set msgId to id of msg as string
                  if seenIds does not contain msgId then
                    set end of seenIds to msgId
                    ${dateFilter ? `set msgDate to date received of msg\n                    if not (${dateFilter}) then\n                      -- skip message outside date range\n                    else` : ""}
                    set msgSubject to subject of msg
                    set msgSender to sender of msg
                    set d to date received of msg
                    set msgDateStr to ${AS_DATE_TO_STRING}
                    set msgRead to read status of msg as string
                    set msgFlagged to flagged status of msg as string
                    if msgCount > 0 then set outputText to outputText & "${RECORD_SEP}"
                    set outputText to outputText & msgId & "${FIELD_SEP}" & msgSubject & "${FIELD_SEP}" & msgSender & "${FIELD_SEP}" & msgDateStr & "${FIELD_SEP}" & msgRead & "${FIELD_SEP}" & msgFlagged & "${FIELD_SEP}" & mbName
                    set msgCount to msgCount + 1
                    ${dateFilter ? "end if" : ""}
                  end if
                end try
              end repeat
            on error _errMsg number _errNum
              set _timedOut to true
              set _notSearched to _notSearched & mbName & "${DIAG_ITEM_SEP}"
            end try
          end if
        end if
      end repeat
      return outputText & "${DIAG_MARKER}timedOut=" & (_timedOut as string) & "${DIAG_FIELD_SEP}skipped=" & _skipped & "${DIAG_FIELD_SEP}notSearched=" & _notSearched
    `;
        }
        const script = buildAccountScopedScript(targetAccount, searchCommand);
        const result = executeAppleScript(script, { timeoutMs: SEARCH_ACCOUNT_TIMEOUT_MS });
        if (!result.success) {
            // Whole-account script failed (most often the osascript process timeout /
            // SIGKILL on an unresponsive account). Surface it as a timeout rather than
            // a false empty result — that confusion is the heart of issue #24.
            console.error(`Failed to search messages in "${targetAccount}": ${result.error}`);
            return {
                messages: [],
                diagnostics: {
                    partial: true,
                    timedOutAccounts: [targetAccount],
                    skippedLargeMailboxes: [],
                    notSearchedMailboxes: [],
                },
            };
        }
        return this.parseSearchResult(result.output, mailbox || "INBOX", targetAccount);
    }
    /**
     * Split a per-account search payload into its message list and the DIAG
     * trailer, parse both, and return a SearchResult. See searchMessagesWithDiagnostics.
     */
    parseSearchResult(output, mailbox, account) {
        const { payload, diagnostics } = splitSearchDiagnostics(output, account);
        const messages = payload.trim() ? this.parseMessageList(payload, mailbox, account) : [];
        return { messages, diagnostics };
    }
    /**
     * Get a message by ID.
     *
     * Note: Mail.app message IDs are unique per mailbox. This method searches
     * all mailboxes in all accounts to find the message.
     */
    getMessageById(id, deepAttachmentCheck = false) {
        // MIME-embedded attachments are invisible to AppleScript's `mail attachments`
        // object, so the only way to detect them is to scan the raw `source of msg`.
        // That reads the entire message (can be MB-sized), so it's the slowest part
        // of this path — now opt-in via `deepAttachmentCheck` rather than run on
        // every attachmentless message (#32). Default off: hasAttachments reflects
        // the fast attachment count only.
        const deepScan = deepAttachmentCheck
            ? `if hasAtt is "false" then
                  try
                    set rawSrc to source of msg
                    if rawSrc contains "Content-Disposition: attachment" then set hasAtt to "true"
                  end try
                end if`
            : "";
        const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${Number(id)})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set msgSubject to subject of msg
                set msgSender to sender of msg
                set d to date received of msg
                set msgDate to ${AS_DATE_TO_STRING}
                set msgRead to read status of msg as string
                set msgFlagged to flagged status of msg as string
                set msgJunk to junk mail status of msg as string
                set msgDeleted to deleted status of msg as string
                set msgMailbox to name of mb
                set msgAccount to name of acct
                set hasAtt to "false"
                try
                  set attCount to count of mail attachments of msg
                  if attCount > 0 then set hasAtt to "true"
                end try
                ${deepScan}
                return msgSubject & "${FIELD_SEP}" & msgSender & "${FIELD_SEP}" & msgDate & "${FIELD_SEP}" & msgRead & "${FIELD_SEP}" & msgFlagged & "${FIELD_SEP}" & msgJunk & "${FIELD_SEP}" & msgDeleted & "${FIELD_SEP}" & msgMailbox & "${FIELD_SEP}" & msgAccount & "${FIELD_SEP}" & hasAtt
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
        const parts = result.output.split(FIELD_SEP);
        if (parts.length < 9)
            return null;
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
            hasAttachments: parts.length > 9 ? parts[9] === "true" : false,
        };
    }
    /**
     * Get the content of a message.
     *
     * @param id - Message ID
     * @param includeHtml - When true, also fetch the raw MIME source and extract
     *   the `text/html` body part into `htmlContent`. This is opt-in because the
     *   source can be MB-sized (it includes base64 attachments) and the plain-text
     *   path doesn't need it; fetching it unconditionally was both slow and, worse,
     *   returned the entire raw MIME blob mislabeled as HTML (#32).
     */
    getMessageContent(id, includeHtml = false) {
        // Only `source of msg` is fetched when HTML is requested. `content of msg`
        // is the plain-text body and is always cheap.
        const sourceFetch = includeHtml
            ? `set htmlSource to ""\n                try\n                  set htmlSource to source of msg\n                end try`
            : `set htmlSource to ""`;
        const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${Number(id)})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set msgSubject to subject of msg
                set msgContent to content of msg
                ${sourceFetch}
                return msgSubject & "${CONTENT_MARKER}" & msgContent & "${HTML_MARKER}" & htmlSource
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
        const htmlSplit = result.output.split(HTML_MARKER);
        const contentPart = htmlSplit[0];
        const rawSource = htmlSplit.length > 1 ? htmlSplit[1] : "";
        const parts = contentPart.split(CONTENT_MARKER);
        if (parts.length < 2)
            return null;
        // Extract the actual text/html body from the raw MIME source rather than
        // returning the whole source. Falls back to undefined when the message has
        // no HTML part (e.g. a plain-text-only email).
        const htmlContent = includeHtml && rawSource ? extractHtmlBody(rawSource) || undefined : undefined;
        return {
            id: id.toString(),
            subject: parts[0],
            plainText: parts[1],
            htmlContent,
        };
    }
    /**
     * Get the raw MIME source of a message.
     * Used as fallback for attachment extraction when AppleScript
     * mail attachments returns empty.
     *
     * Timeout is 2x the default (120s) because `source of msg` returns
     * the entire raw message including base64-encoded attachments —
     * a 20MB attachment can take several seconds over Exchange/IMAP.
     */
    getRawSource(id) {
        const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${Number(id)})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                return source of msg
              end if
            end try
          end repeat
        end repeat
        return ""
      on error errMsg
        return ""
      end try
    `);
        const result = executeAppleScript(script, { timeoutMs: 120000 });
        if (!result.success || !result.output.trim()) {
            return null;
        }
        return result.output;
    }
    /**
     * List messages in a mailbox.
     *
     * @param mailbox - Mailbox to list from (default: INBOX)
     * @param account - Account to list from
     * @param limit - Maximum number of messages
     * @returns Array of messages
     */
    listMessages(mailbox, account, limit = 50, from, offset = 0) {
        return this.listMessagesWithDiagnostics(mailbox, account, limit, from, offset).messages;
    }
    /**
     * List messages, returning matches plus coverage diagnostics.
     *
     * Like `searchMessages`, the unscoped (all-mailboxes) path used to iterate
     * `messages of mb` over every mailbox with a swallowing per-mailbox `try`,
     * so a large IMAP/Gmail mailbox timed out and the method returned `[]` — a
     * false "No messages found." This applies the same #24 discipline: skip
     * mailboxes above the scan threshold (reported), enforce a per-account
     * wall-clock budget, capture per-mailbox timeouts, and surface all of it as a
     * partial result. (by-id lookups don't need this — `whose id is` is indexed
     * and returns instantly even on a 44k-message mailbox.)
     */
    listMessagesWithDiagnostics(mailbox, account, limit = 50, from, offset = 0) {
        // If no account specified, list across all accounts and merge diagnostics.
        if (!account) {
            const accounts = this.listAccounts();
            const allMessages = [];
            const diagnostics = {
                partial: false,
                timedOutAccounts: [],
                skippedLargeMailboxes: [],
                notSearchedMailboxes: [],
            };
            for (const acct of accounts) {
                if (allMessages.length >= limit)
                    break;
                const remaining = limit - allMessages.length;
                const res = this.listMessagesWithDiagnostics(mailbox, acct.name, remaining, from, offset);
                allMessages.push(...res.messages);
                mergeSearchDiagnostics(diagnostics, res.diagnostics);
            }
            return { messages: allMessages.slice(0, limit), diagnostics };
        }
        const targetAccount = this.resolveAccount(account);
        const safeFrom = from ? escapeForAppleScript(from) : "";
        const fromFilter = from ? `whose sender contains "${safeFrom}"` : "";
        const scanThreshold = getMailboxScanThreshold();
        let listCommand;
        if (mailbox) {
            // List from a specific mailbox. Caller-scoped, so no count-guard skip, but
            // wrap the scan so a timeout is reported as partial, not a false empty.
            const targetMailbox = this.resolveMailbox(mailbox, targetAccount);
            listCommand = `
      set outputText to ""
      set _timedOut to false
      set _notSearched to ""
      set theMailbox to mailbox "${escapeForAppleScript(targetMailbox)}"
      set msgCount to 0
      set skipped to 0
      try
        repeat with msg in messages of theMailbox ${fromFilter}
          if msgCount >= ${limit} then exit repeat
          try
            if skipped < ${offset} then
              set skipped to skipped + 1
            else
              set msgId to id of msg as string
              set msgSubject to subject of msg
              set msgSender to sender of msg
              set d to date received of msg
              set msgDate to ${AS_DATE_TO_STRING}
              set msgRead to read status of msg as string
              set msgFlagged to flagged status of msg as string
              set msgHasAtt to "false"
              try
                if (count of mail attachments of msg) > 0 then set msgHasAtt to "true"
              end try
              if msgCount > 0 then set outputText to outputText & "${RECORD_SEP}"
              set outputText to outputText & msgId & "${FIELD_SEP}" & msgSubject & "${FIELD_SEP}" & msgSender & "${FIELD_SEP}" & msgDate & "${FIELD_SEP}" & msgRead & "${FIELD_SEP}" & msgFlagged & "${FIELD_SEP}" & msgHasAtt
              set msgCount to msgCount + 1
            end if
          end try
        end repeat
      on error _errMsg number _errNum
        set _timedOut to true
        set _notSearched to "${escapeForAppleScript(targetMailbox)}${DIAG_ITEM_SEP}"
      end try
      return outputText & "${DIAG_MARKER}timedOut=" & (_timedOut as string) & "${DIAG_FIELD_SEP}skipped=${DIAG_FIELD_SEP}notSearched=" & _notSearched
    `;
        }
        else {
            // List from ALL mailboxes — skip mailboxes over the scan threshold, enforce
            // the per-account budget, capture per-mailbox timeouts; dedup by message ID.
            const scanGuard = scanThreshold > 0 ? `mbCount > ${scanThreshold}` : "false";
            listCommand = `
      set outputText to ""
      set msgCount to 0
      set skipped to 0
      set seenIds to {}
      set _timedOut to false
      set _skipped to ""
      set _notSearched to ""
      set _startedAt to current date
      repeat with mb in mailboxes
        if msgCount >= ${limit} then exit repeat
        set mbName to ""
        try
          set mbName to name of mb
        end try
        if ((current date) - _startedAt) > ${SEARCH_ACCOUNT_BUDGET_SECONDS} then
          set _timedOut to true
          set _notSearched to _notSearched & mbName & "${DIAG_ITEM_SEP}"
        else
          set mbCount to 0
          try
            set mbCount to count of messages of mb
          end try
          if (${scanGuard}) then
            set _timedOut to true
            set _skipped to _skipped & mbName & " (" & (mbCount as string) & ")${DIAG_ITEM_SEP}"
          else
            try
              repeat with msg in messages of mb ${fromFilter}
                if msgCount >= ${limit} then exit repeat
                try
                  set msgId to id of msg as string
                  if seenIds does not contain msgId then
                    set end of seenIds to msgId
                    if skipped < ${offset} then
                      set skipped to skipped + 1
                    else
                      set msgSubject to subject of msg
                      set msgSender to sender of msg
                      set d to date received of msg
                      set msgDate to ${AS_DATE_TO_STRING}
                      set msgRead to read status of msg as string
                      set msgFlagged to flagged status of msg as string
                      set msgHasAtt to "false"
                      try
                        if (count of mail attachments of msg) > 0 then set msgHasAtt to "true"
                      end try
                      if msgCount > 0 then set outputText to outputText & "${RECORD_SEP}"
                      set outputText to outputText & msgId & "${FIELD_SEP}" & msgSubject & "${FIELD_SEP}" & msgSender & "${FIELD_SEP}" & msgDate & "${FIELD_SEP}" & msgRead & "${FIELD_SEP}" & msgFlagged & "${FIELD_SEP}" & mbName & "${FIELD_SEP}" & msgHasAtt
                      set msgCount to msgCount + 1
                    end if
                  end if
                end try
              end repeat
            on error _errMsg number _errNum
              set _timedOut to true
              set _notSearched to _notSearched & mbName & "${DIAG_ITEM_SEP}"
            end try
          end if
        end if
      end repeat
      return outputText & "${DIAG_MARKER}timedOut=" & (_timedOut as string) & "${DIAG_FIELD_SEP}skipped=" & _skipped & "${DIAG_FIELD_SEP}notSearched=" & _notSearched
    `;
        }
        const script = buildAccountScopedScript(targetAccount, listCommand);
        const result = executeAppleScript(script, { timeoutMs: SEARCH_ACCOUNT_TIMEOUT_MS });
        if (!result.success) {
            // Whole-account failure — surface as a timeout, not a false empty (#24/#29).
            console.error(`Failed to list messages in "${targetAccount}": ${result.error}`);
            return {
                messages: [],
                diagnostics: {
                    partial: true,
                    timedOutAccounts: [targetAccount],
                    skippedLargeMailboxes: [],
                    notSearchedMailboxes: [],
                },
            };
        }
        return this.parseSearchResult(result.output, mailbox || "INBOX", targetAccount);
    }
    /**
     * Parse message list output from AppleScript.
     *
     * Two emission schemas, disambiguated by length:
     *   7 fields: single-mailbox — ...|hasAtt (mailbox from caller)
     *   8 fields: all-mailboxes — ...|mailbox|hasAtt
     *
     * `hasAttachments` here is the fast-path AppleScript count only; it will
     * false-negative for MIME-embedded attachments (a known AppleScript
     * limitation). Use getMessage or list-attachments for authoritative info.
     */
    parseMessageList(output, mailbox, account) {
        const items = output.split(RECORD_SEP);
        const messages = [];
        for (const item of items) {
            const parts = item.split(FIELD_SEP);
            if (parts.length < 6)
                continue;
            let msgMailbox = mailbox;
            let hasAttachments = false;
            if (parts.length >= 8) {
                msgMailbox = parts[6];
                hasAttachments = parts[7] === "true";
            }
            else if (parts.length === 7) {
                hasAttachments = parts[6] === "true";
            }
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
                mailbox: msgMailbox,
                account,
                hasAttachments,
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
    // ───────────────────────────────────────────────────────────────────
    // KNOWN BUG: outgoing emails sent via AppleScript on macOS 15+ get wrapped
    // in <blockquote type="cite"> under the Apple-Mail-URLShareWrapperClass
    // template, so they render to recipients as quoted/forwarded content.
    // Plain-text alternative gets `>` prefixes on every line.
    //
    // Reproduces with EVERY AppleScript message-creation pattern I tried:
    //   • make new outgoing message with properties {content: ..., ...}
    //   • make new outgoing message (no content) + `set content of newMessage`
    //   • setting `default message format` to plain format first
    //
    // Apple radar FB11734014 (open since Ventura, no movement).
    // Discussion: https://forums.macrumors.com/threads/applescript-creating-a-
    //   new-message-in-mail-app-is-causing-weird-formatting-issues.2385052/
    //
    // FIX (v1.6.0): send-email now accepts `transport: "smtp"`, which bypasses
    // Mail.app and submits clean MIME directly via nodemailer (creds from the
    // Keychain). See src/services/smtpMailer.ts. This AppleScript path remains
    // the default for back-compat and for users who don't configure SMTP, so the
    // wrapping behavior below is unchanged for them.
    // Tracking issue: https://github.com/sweetrb/apple-mail-mcp/issues/12
    // ───────────────────────────────────────────────────────────────────
    sendEmail(to, subject, body, cc, bcc, account, attachments) {
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
        const attachmentCommands = buildAttachmentCommands(attachments);
        let sendCommand;
        if (account) {
            const safeAccount = escapeForAppleScript(account);
            sendCommand = `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:true}
        tell newMessage
          ${recipientCommands}
          set sender to "${safeAccount}"
          ${attachmentCommands}
        end tell
        send newMessage
        return "sent"
      `;
        }
        else {
            sendCommand = `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:true}
        tell newMessage
          ${recipientCommands}
          ${attachmentCommands}
        end tell
        send newMessage
        return "sent"
      `;
        }
        const script = buildAppLevelScript(sendCommand);
        const result = executeAppleScript(script, { timeoutMs: 60000, maxRetries: 2 });
        if (!result.success) {
            console.error(`Failed to send email: ${result.error}`);
            return false;
        }
        return result.output.includes("sent");
    }
    /**
     * Send individual personalized emails to a list of recipients (mail merge).
     *
     * Replaces {{placeholder}} tokens in subject and body with per-recipient values.
     * Each recipient receives their own individual email.
     *
     * @param recipients - List of recipient objects with email and variable values
     * @param subject - Email subject (may contain {{placeholders}})
     * @param body - Email body (may contain {{placeholders}})
     * @param account - Account to send from
     * @param delayMs - Delay between sends in milliseconds (default: 500, max: 10000)
     * @returns Array of per-recipient results
     */
    sendSerialEmail(recipients, subject, body, account, delayMs = 500) {
        const effectiveDelay = Math.min(Math.max(delayMs, 0), 10000);
        const results = [];
        for (let i = 0; i < recipients.length; i++) {
            const recipient = recipients[i];
            try {
                // Replace all {{Key}} placeholders with recipient's values
                let personalizedSubject = subject;
                let personalizedBody = body;
                for (const [key, value] of Object.entries(recipient.variables)) {
                    const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                    const placeholder = new RegExp(`\\{\\{${safeKey}\\}\\}`, "g");
                    personalizedSubject = personalizedSubject.replace(placeholder, value);
                    personalizedBody = personalizedBody.replace(placeholder, value);
                }
                const success = this.sendEmail([recipient.email], personalizedSubject, personalizedBody, undefined, undefined, account);
                results.push({
                    email: recipient.email,
                    success,
                    error: success ? undefined : "Failed to send email",
                });
            }
            catch (error) {
                results.push({
                    email: recipient.email,
                    success: false,
                    error: error instanceof Error ? error.message : "Unknown error",
                });
            }
            // Brief delay between sends to avoid overwhelming Mail.app
            if (effectiveDelay > 0 && i < recipients.length - 1) {
                spawnSync("sleep", [(effectiveDelay / 1000).toString()], { stdio: "ignore" });
            }
        }
        return results;
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
    createDraft(to, subject, body, cc, bcc, account, attachments) {
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
        const attachmentCommands = buildAttachmentCommands(attachments);
        let draftCommand;
        if (account) {
            const safeAccount = escapeForAppleScript(account);
            draftCommand = `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:false}
        tell newMessage
          ${recipientCommands}
          set sender to "${safeAccount}"
          ${attachmentCommands}
        end tell
        return "draft created"
      `;
        }
        else {
            draftCommand = `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:false}
        tell newMessage
          ${recipientCommands}
          ${attachmentCommands}
        end tell
        return "draft created"
      `;
        }
        const script = buildAppLevelScript(draftCommand);
        const result = executeAppleScript(script, { timeoutMs: 60000, maxRetries: 2 });
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
    replyToMessage(id, body, replyAll = false, send = true) {
        const safeBody = escapeForAppleScript(body);
        const replyAllClause = replyAll ? " with reply to all" : "";
        const sendAction = send ? "send theReply" : "";
        const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${Number(id)})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set theReply to reply msg without opening window${replyAllClause}
                set content of theReply to "${safeBody}"
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
    forwardMessage(id, to, body, send = true) {
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
              set matchingMsgs to (messages of mb whose id is ${Number(id)})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set theForward to forward msg without opening window
                ${recipientCommands}
                ${safeBody ? `set content of theForward to "${safeBody}"` : ""}
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
    findMessageScript(id, operation) {
        return buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${Number(id)})
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
    markAsRead(id) {
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
    markAsUnread(id) {
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
    flagMessage(id) {
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
    unflagMessage(id) {
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
    deleteMessage(id) {
        const script = this.findMessageScript(id, "delete msg");
        const result = executeAppleScript(script, { timeoutMs: 60000 });
        if (result.success && !result.output.startsWith("error:")) {
            return { success: true };
        }
        const raw = result.success
            ? result.output.replace(/^error:/, "")
            : result.error || "Unknown error";
        const error = this.classifyMessageMutationError(id, raw, "delete");
        console.error(`Failed to delete message: ${error}`);
        return { success: false, error };
    }
    /**
     * Classify a failed message mutation (delete/move) into an actionable error.
     *
     * Mail.app's scripting bridge cannot delete or move drafts, and cannot mutate
     * messages in some server-side special mailboxes — it throws `AppleEvent
     * handler failed` rather than a useful message (#42). When that pattern is
     * seen, look up the message's mailbox (cheap, indexed `whose id is`) to give a
     * draft-specific or server-specific hint. Other errors (e.g. "Message not
     * found", "ambiguous destination") pass through unchanged.
     */
    classifyMessageMutationError(id, raw, op) {
        const trimmed = (raw || "").trim();
        if (!UNSUPPORTED_APPLESCRIPT_OP.test(trimmed))
            return trimmed || `Failed to ${op} message`;
        let mailbox = "";
        try {
            mailbox = this.getMessageById(id)?.mailbox ?? "";
        }
        catch {
            /* best-effort; fall through to the generic server-side message */
        }
        if (/draft/i.test(mailbox)) {
            return `Mail.app cannot ${op} drafts via AppleScript; ${op} it in Mail.app directly. (Mail.app error: ${trimmed})`;
        }
        return `Mail.app cannot ${op} this message via AppleScript (server-side or special mailbox${mailbox ? ` "${mailbox}"` : ""}); ${op} it in Mail.app directly. (Mail.app error: ${trimmed})`;
    }
    /**
     * Move a message to a different mailbox.
     */
    /**
     * Move a message to a destination mailbox, with full nested-mailbox support.
     *
     * Resolving the destination as `mailbox "X" of account "Y"` only finds
     * top-level mailboxes, so nested destinations (e.g. a "Moore" subfolder)
     * silently failed. Instead we walk the target account's full mailbox tree and
     * match by name. Resolution is:
     *   - account-scoped (won't move to a same-named mailbox in another account)
     *   - ambiguity-aware: if the name matches more than one mailbox in the
     *     account we refuse to guess and return an error — silently moving mail to
     *     the wrong folder is worse than failing.
     * The source message is located by walking every account's tree breadth-first
     * (top-level mailboxes like Inbox are checked first), so messages in nested
     * mailboxes are found too.
     *
     * Returns a result object so batch callers can surface the specific failure
     * (destination not found / ambiguous / message not found).
     */
    moveMessageInternal(id, mailbox, account) {
        const targetAccount = this.resolveAccount(account);
        const targetMailbox = this.resolveMailbox(mailbox, targetAccount);
        const safeMailbox = escapeForAppleScript(targetMailbox);
        const safeAccount = escapeForAppleScript(targetAccount);
        const script = buildAppLevelScript(`
      try
        -- \`mailboxes of account\` is already flat: it includes nested mailboxes
        -- (named by path, e.g. "Processed/Vendors"). Descending via \`mailboxes of mb\`
        -- is unreliable (it double-prepends the parent path), so we DON'T recurse —
        -- we match against this flat list by exact name and use the reference directly
        -- (addressing \`mailbox "X" of account "Y"\` only finds some top-level mailboxes).
        set destName to "${safeMailbox}"
        set destMatches to {}
        repeat with mb in (mailboxes of account "${safeAccount}")
          if (name of mb) is destName then set end of destMatches to mb
        end repeat
        if (count of destMatches) is 0 then return "error:Destination mailbox \\"" & destName & "\\" not found in account \\"${safeAccount}\\""
        if (count of destMatches) > 1 then return "error:Destination mailbox \\"" & destName & "\\" is ambiguous (" & (count of destMatches) & " matches) in account \\"${safeAccount}\\"; disambiguate or move by full path"
        set destMailbox to item 1 of destMatches

        -- Find the message by id. The flat mailbox list already covers nested
        -- mailboxes, so this reaches messages in subfolders without recursing.
        repeat with acct in accounts
          repeat with mb in (mailboxes of acct)
            try
              set matchingMsgs to (messages of mb whose id is ${Number(id)})
              if (count of matchingMsgs) > 0 then
                move (item 1 of matchingMsgs) to destMailbox
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
        const result = executeAppleScript(script, { timeoutMs: 90000 });
        if (!result.success) {
            return { success: false, error: result.error || "AppleScript execution failed" };
        }
        if (result.output.startsWith("error:")) {
            return { success: false, error: result.output.slice("error:".length) };
        }
        return { success: true };
    }
    moveMessage(id, mailbox, account) {
        const res = this.moveMessageInternal(id, mailbox, account);
        if (res.success)
            return { success: true };
        const error = this.classifyMessageMutationError(id, res.error || "Failed to move message", "move");
        console.error(`Failed to move message: ${error}`);
        return { success: false, error };
    }
    // ===========================================================================
    // Batch Operations
    // ===========================================================================
    /**
     * Run one operation over many message IDs in a SINGLE osascript invocation.
     *
     * Previously each batch method looped and called the per-id method, so a
     * 100-id batch spawned 100 osascript processes — each one re-resolving
     * accounts and walking the whole account→mailbox tree — all serialized
     * through the gate (issue #31). This walks the tree exactly once: for each
     * mailbox it probes the still-pending IDs with `whose id is` (indexed, so
     * effectively free) and applies `operation` to any match, tracking found IDs
     * so it can stop early once all are accounted for. Per-id outcomes come back
     * as control-char-delimited `id<FS>status` records (status: `ok`,
     * `notfound`, or `error:<msg>`), and results are returned in input order.
     *
     * `setup` runs once before the walk (used by move to resolve the destination);
     * it may bail the whole batch by returning a `BATCH_FATAL`-prefixed string.
     */
    runBatchOperation(ids, operation, setup = "") {
        // Keep the numeric IDs paired with their original string form and 1-based
        // position. The AppleScript reports outcomes by POSITION, not by id: a Mail
        // id large enough to exceed AppleScript's 2^29 integer range coerces to
        // scientific notation under `as string` (999999999 -> "9.99999999E+8"), so
        // echoing the id back can't be matched to the input. Positions are always
        // small integers, so they round-trip cleanly.
        const valid = [];
        for (const id of ids) {
            const num = Number(id);
            if (Number.isFinite(num))
                valid.push({ id, num });
        }
        if (valid.length === 0) {
            return ids.map((id) => ({ id, success: false, error: "Invalid message ID" }));
        }
        const script = buildAppLevelScript(`
      try
        ${setup}
        set _out to ""
        set _done to {}
        set _ids to {${valid.map((v) => v.num).join(", ")}}
        set _total to count of _ids
        repeat with acct in accounts
          if (count of _done) is _total then exit repeat
          repeat with mb in (mailboxes of acct)
            if (count of _done) is _total then exit repeat
            repeat with _idx from 1 to _total
              if _idx is not in _done then
                set _theId to item _idx of _ids
                try
                  set _m to (messages of mb whose id is _theId)
                  if (count of _m) > 0 then
                    set _msg to item 1 of _m
                    ${operation}
                    set end of _done to _idx
                    set _out to _out & (_idx as string) & "${FIELD_SEP}ok${RECORD_SEP}"
                  end if
                on error _e
                  set end of _done to _idx
                  set _out to _out & (_idx as string) & "${FIELD_SEP}error:" & _e & "${RECORD_SEP}"
                end try
              end if
            end repeat
          end repeat
        end repeat
        repeat with _idx from 1 to _total
          if _idx is not in _done then set _out to _out & (_idx as string) & "${FIELD_SEP}notfound${RECORD_SEP}"
        end repeat
        return _out
      on error errMsg
        return "${BATCH_FATAL}" & errMsg
      end try
    `);
        // Generous timeout: one walk over the tree with indexed id probes. Scale a
        // little with batch size, capped.
        const timeoutMs = Math.min(180000, 60000 + valid.length * 500);
        const result = executeAppleScript(script, { timeoutMs });
        if (!result.success) {
            const err = result.error || "Batch operation failed";
            return ids.map((id) => ({ id, success: false, error: err }));
        }
        if (result.output.startsWith(BATCH_FATAL)) {
            const err = result.output.slice(BATCH_FATAL.length);
            return ids.map((id) => ({ id, success: false, error: err }));
        }
        // Map by-position outcomes back to the original id strings.
        const byId = new Map();
        for (const rec of result.output.split(RECORD_SEP)) {
            if (!rec)
                continue;
            const sep = rec.indexOf(FIELD_SEP);
            if (sep < 0)
                continue;
            const pos = Number(rec.slice(0, sep));
            const status = rec.slice(sep + FIELD_SEP.length);
            const entry = valid[pos - 1];
            if (!entry)
                continue;
            const id = entry.id;
            if (status === "ok") {
                byId.set(id, { id, success: true });
            }
            else if (status === "notfound") {
                byId.set(id, { id, success: false, error: "Message not found" });
            }
            else if (status.startsWith("error:")) {
                byId.set(id, { id, success: false, error: status.slice("error:".length) });
            }
            else {
                byId.set(id, { id, success: false, error: status || "Unknown error" });
            }
        }
        return ids.map((id) => byId.get(id) ??
            (Number.isFinite(Number(id))
                ? { id, success: false, error: "No result returned" }
                : { id, success: false, error: "Invalid message ID" }));
    }
    /**
     * Delete multiple messages at once (single tree walk — see runBatchOperation).
     */
    batchDeleteMessages(ids) {
        return this.runBatchOperation(ids, "delete _msg");
    }
    /**
     * Move multiple messages to a mailbox at once (single tree walk).
     *
     * The destination is resolved once (account-scoped, ambiguity-aware — a name
     * matching more than one mailbox fails the whole batch rather than guessing),
     * then every matched message is moved in the same walk.
     */
    batchMoveMessages(ids, mailbox, account) {
        const targetAccount = this.resolveAccount(account);
        const targetMailbox = this.resolveMailbox(mailbox, targetAccount);
        const safeMailbox = escapeForAppleScript(targetMailbox);
        const safeAccount = escapeForAppleScript(targetAccount);
        // Resolved once, before the walk. `mailboxes of account` is already flat
        // (includes nested mailboxes by path), so we match by exact name and use the
        // reference directly. A bad/ambiguous destination fails the whole batch.
        const setup = `
        set destName to "${safeMailbox}"
        set destMatches to {}
        repeat with _dmb in (mailboxes of account "${safeAccount}")
          if (name of _dmb) is destName then set end of destMatches to _dmb
        end repeat
        if (count of destMatches) is 0 then return "${BATCH_FATAL}Destination mailbox \\"" & destName & "\\" not found in account \\"${safeAccount}\\""
        if (count of destMatches) > 1 then return "${BATCH_FATAL}Destination mailbox \\"" & destName & "\\" is ambiguous (" & (count of destMatches) & " matches) in account \\"${safeAccount}\\"; move by full path"
        set destMailbox to item 1 of destMatches`;
        return this.runBatchOperation(ids, "move _msg to destMailbox", setup);
    }
    /**
     * Mark multiple messages as read at once (single tree walk).
     */
    batchMarkAsRead(ids) {
        return this.runBatchOperation(ids, "set read status of _msg to true");
    }
    /**
     * Mark multiple messages as unread at once (single tree walk).
     */
    batchMarkAsUnread(ids) {
        return this.runBatchOperation(ids, "set read status of _msg to false");
    }
    /**
     * Flag multiple messages at once (single tree walk).
     */
    batchFlagMessages(ids) {
        return this.runBatchOperation(ids, "set flagged status of _msg to true");
    }
    /**
     * Unflag multiple messages at once (single tree walk).
     */
    batchUnflagMessages(ids) {
        return this.runBatchOperation(ids, "set flagged status of _msg to false");
    }
    /**
     * List attachments for a message.
     * Tries AppleScript first, falls back to MIME source parsing
     * when AppleScript returns empty (known issue across all account types).
     */
    listAttachments(id) {
        // Attempt 1: AppleScript mail attachments
        const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${Number(id)})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set outputText to ""
                set attCount to 0
                repeat with att in mail attachments of msg
                  set attName to name of att
                  set attType to MIME type of att
                  set attSize to file size of att as string
                  if attCount > 0 then set outputText to outputText & "${RECORD_SEP}"
                  set outputText to outputText & attName & "${FIELD_SEP}" & attType & "${FIELD_SEP}" & attSize
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
        if (result.success && result.output.trim()) {
            const items = result.output.split(RECORD_SEP);
            const attachments = [];
            for (const item of items) {
                const parts = item.split(FIELD_SEP);
                if (parts.length < 3)
                    continue;
                attachments.push({
                    id: `${id}-${parts[0]}`,
                    name: parts[0],
                    mimeType: parts[1],
                    size: parseInt(parts[2]) || 0,
                });
            }
            if (attachments.length > 0)
                return attachments;
        }
        // Attempt 2: MIME source fallback
        const rawSource = this.getRawSource(id);
        if (!rawSource)
            return [];
        const mimeAttachments = parseMimeAttachments(rawSource);
        return mimeAttachments.map((att) => ({
            id: `${id}-${att.name}`,
            name: att.name,
            mimeType: att.mimeType,
            size: att.size,
        }));
    }
    /**
     * Save an attachment from a message to disk.
     * Tries AppleScript first, falls back to MIME source extraction
     * when AppleScript can't find the attachment.
     */
    saveAttachment(id, attachmentName, savePath) {
        // Validate attachment name: block path separators, traversal, null bytes, and backslashes
        if (/[/\\\0]/.test(attachmentName) || attachmentName.includes("..")) {
            console.error(`Invalid attachment name: "${attachmentName}"`);
            return false;
        }
        // Resolve the save path to prevent symlink / ".." traversal bypass
        const resolvedPath = resolve(savePath);
        if (!isPathWithinAllowedRoots(resolvedPath)) {
            console.error(`Save path "${savePath}" is outside allowed directories`);
            return false;
        }
        const safeName = escapeForAppleScript(attachmentName);
        const safePath = escapeForAppleScript(resolvedPath);
        const numericId = Number(id);
        // Attempt 1: AppleScript save
        const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${numericId})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                repeat with att in mail attachments of msg
                  if name of att is "${safeName}" then
                    set savePath to POSIX file "${safePath}/${safeName}"
                    save att in savePath
                    return "ok"
                  end if
                end repeat
                return "error:Attachment not found"
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
        if (result.success && result.output === "ok") {
            return true;
        }
        // Attempt 2: MIME source fallback
        const rawSource = this.getRawSource(id);
        if (!rawSource) {
            console.error(`Failed to save attachment: could not retrieve message source`);
            return false;
        }
        const attachment = extractMimeAttachment(rawSource, attachmentName);
        if (!attachment) {
            console.error(`Failed to save attachment: "${attachmentName}" not found in MIME source`);
            return false;
        }
        try {
            const outPath = resolve(resolvedPath, attachmentName);
            // Verify the resolved output path is still within allowed directories
            if (!isPathWithinAllowedRoots(outPath)) {
                console.error(`Output path "${outPath}" is outside allowed directories`);
                return false;
            }
            writeFileSync(outPath, attachment.data);
            return true;
        }
        catch (err) {
            console.error(`Failed to write attachment to disk: ${err}`);
            return false;
        }
    }
    // ===========================================================================
    // Mailbox Operations
    // ===========================================================================
    /**
     * List all mailboxes for an account.
     */
    listMailboxes(account) {
        const targetAccount = this.resolveAccount(account);
        const listCommand = `
      set mailboxList to {}
      repeat with mb in mailboxes
        set mbName to name of mb
        set mbUnread to unread count of mb
        set mbCount to count of messages of mb
        set end of mailboxList to mbName & "${FIELD_SEP}" & mbUnread & "${FIELD_SEP}" & mbCount
      end repeat
      set AppleScript's text item delimiters to "${RECORD_SEP}"
      return mailboxList as text
    `;
        const script = buildAccountScopedScript(targetAccount, listCommand);
        // Counts every mailbox's message total, so it needs more than the default
        // 30s on accounts with many/large mailboxes; a timeout here silently
        // returned an empty list (audit finding #8).
        const result = executeAppleScript(script, { timeoutMs: 60000 });
        if (!result.success) {
            console.error(`Failed to list mailboxes: ${result.error}`);
            return [];
        }
        if (!result.output.trim())
            return [];
        const items = result.output.split(RECORD_SEP);
        const mailboxes = [];
        for (const item of items) {
            const parts = item.split(FIELD_SEP);
            if (parts.length < 3)
                continue;
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
    getUnreadCount(mailbox, account) {
        const targetAccount = this.resolveAccount(account);
        let command;
        if (mailbox) {
            const targetMailbox = this.resolveMailbox(mailbox, targetAccount);
            const safeMailbox = escapeForAppleScript(targetMailbox);
            command = `return unread count of mailbox "${safeMailbox}"`;
        }
        else {
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
        // Summing unread across every mailbox can exceed the default 30s; a timeout
        // previously degraded silently to 0 ("all read") — audit finding #8.
        const result = executeAppleScript(script, { timeoutMs: 60000 });
        if (!result.success) {
            console.error(`Failed to get unread count: ${result.error}`);
            return 0;
        }
        return parseInt(result.output) || 0;
    }
    /**
     * Create a new mailbox.
     */
    createMailbox(name, account) {
        const targetAccount = this.resolveAccount(account);
        const safeName = escapeForAppleScript(name);
        const safeAccount = escapeForAppleScript(targetAccount);
        const script = buildAppLevelScript(`
      try
        make new mailbox with properties {name:"${safeName}"} at account "${safeAccount}"
        return "ok"
      on error errMsg
        return "error:" & errMsg
      end try
    `);
        const result = executeAppleScript(script);
        if (!result.success || result.output.startsWith("error:")) {
            console.error(`Failed to create mailbox: ${result.error || result.output}`);
            return false;
        }
        this.invalidateCache();
        return true;
    }
    /**
     * Delete a mailbox.
     */
    deleteMailbox(name, account) {
        const targetAccount = this.resolveAccount(account);
        const targetMailbox = this.resolveMailbox(name, targetAccount);
        const safeName = escapeForAppleScript(targetMailbox);
        const safeAccount = escapeForAppleScript(targetAccount);
        const script = buildAppLevelScript(`
      try
        delete mailbox "${safeName}" of account "${safeAccount}"
        return "ok"
      on error errMsg
        return "error:" & errMsg
      end try
    `);
        const result = executeAppleScript(script);
        if (!result.success || result.output.startsWith("error:")) {
            const raw = result.success
                ? result.output.replace(/^error:/, "")
                : result.error || "Unknown error";
            const error = describeMailboxOpError("delete", raw);
            console.error(`Failed to delete mailbox: ${error}`);
            return { success: false, error };
        }
        this.invalidateCache();
        return { success: true };
    }
    /**
     * Rename a mailbox by creating a new one, moving messages, and deleting the old one.
     */
    renameMailbox(oldName, newName, account) {
        const targetAccount = this.resolveAccount(account);
        // Create the new mailbox
        if (!this.createMailbox(newName, targetAccount)) {
            return {
                success: false,
                error: `Could not create the destination mailbox "${newName}" needed for the rename.`,
            };
        }
        // Move all messages from old to new
        const resolvedOld = this.resolveMailbox(oldName, targetAccount);
        const resolvedNew = this.resolveMailbox(newName, targetAccount);
        const safeOld = escapeForAppleScript(resolvedOld);
        const safeNew = escapeForAppleScript(resolvedNew);
        const safeAccount = escapeForAppleScript(targetAccount);
        // Mail.app has no reliable in-place mailbox rename across account types, so
        // rename is emulated as create-new + move-all + delete-old. The risk (issue
        // #33) is that the old code iterated `messages of srcMailbox` *while moving*
        // (mutating the collection it was iterating, which can skip messages) and
        // then deleted the source unconditionally — so a move that errored or timed
        // out part-way lost the un-moved remainder. This version:
        //   - snapshots the message references up front (move can't disturb iteration),
        //   - moves each within its own `try` so one bad message doesn't abort the rest,
        //   - and deletes the source ONLY if it is empty afterwards (every message
        //     moved). On a partial move the source is left intact and we report how
        //     many remain, so no mail is lost.
        const moveScript = buildAppLevelScript(`
      try
        set srcMailbox to mailbox "${safeOld}" of account "${safeAccount}"
        set destMailbox to mailbox "${safeNew}" of account "${safeAccount}"
        set srcCount to count of messages of srcMailbox
        set msgs to (every message of srcMailbox)
        repeat with m in msgs
          try
            move m to destMailbox
          end try
        end repeat
        set srcAfter to count of messages of srcMailbox
        if srcAfter is 0 then
          delete mailbox "${safeOld}" of account "${safeAccount}"
          return "ok${FIELD_SEP}" & srcCount
        else
          return "partial${FIELD_SEP}" & (srcCount - srcAfter) & "${FIELD_SEP}" & srcCount & "${FIELD_SEP}" & srcAfter
        end if
      on error errMsg
        return "error:" & errMsg
      end try
    `);
        // Moving a large source mailbox is slow; give it room. If it's still killed,
        // the source is never deleted (delete only runs after a verified-empty
        // check), so a truncated move is recoverable rather than lossy.
        const result = executeAppleScript(moveScript, { timeoutMs: 120000 });
        if (!result.success || result.output.startsWith("error:")) {
            const raw = result.success
                ? result.output.replace(/^error:/, "")
                : result.error || "Unknown error";
            // The empty destination mailbox we just created is now an orphan; the
            // source is untouched (delete only runs after a verified-empty move).
            const error = describeMailboxOpError("rename", raw);
            console.error(`Failed to rename mailbox: ${error}`);
            this.invalidateCache();
            return { success: false, error };
        }
        if (result.output.startsWith("partial")) {
            const parts = result.output.split(FIELD_SEP);
            const remaining = parts[3] ?? "?";
            const total = parts[2] ?? "?";
            const error = `Only ${parts[1] ?? "?"} of ${total} messages moved, ${remaining} remain in "${resolvedOld}"; the source was NOT deleted (both mailboxes left intact). Retry to move the rest.`;
            console.error(`Failed to rename mailbox: ${error}`);
            this.invalidateCache(); // the new mailbox now exists and holds the moved messages
            return { success: false, error };
        }
        this.invalidateCache();
        return { success: true };
    }
    // ===========================================================================
    // Account Operations
    // ===========================================================================
    /**
     * List all mail accounts (uses cache).
     */
    listAccounts() {
        return this.getCachedAccounts();
    }
    /**
     * Fetches account list directly from Mail.app via AppleScript.
     * Used internally by the cache; prefer getCachedAccounts() or listAccounts().
     */
    fetchAccounts() {
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
        set end of accountList to acctName & "${FIELD_SEP}" & emailStr & "${FIELD_SEP}" & acctEnabled
      end repeat
      set AppleScript's text item delimiters to "${RECORD_SEP}"
      return accountList as text
    `);
        const result = executeAppleScript(script);
        if (!result.success) {
            console.error(`Failed to list accounts: ${result.error}`);
            return [];
        }
        if (!result.output.trim())
            return [];
        const items = result.output.split(RECORD_SEP);
        const accounts = [];
        for (const item of items) {
            const parts = item.split(FIELD_SEP);
            if (parts.length < 3)
                continue;
            accounts.push({
                name: parts[0],
                email: parts[1],
                enabled: parts[2] === "true",
            });
        }
        return accounts;
    }
    /**
     * Fetches mailbox names for an account directly from Mail.app.
     * Used internally by the cache; prefer getCachedMailboxNames().
     */
    fetchMailboxNames(account) {
        const script = buildAccountScopedScript(account, `
      set mbNames to {}
      repeat with mb in mailboxes
        set end of mbNames to name of mb
      end repeat
      return mbNames
    `);
        const result = executeAppleScript(script);
        if (!result.success || !result.output) {
            return [];
        }
        return result.output.split(", ").map((s) => s.trim());
    }
    // ===========================================================================
    // Mail Rules
    // ===========================================================================
    /**
     * List all mail rules.
     */
    listRules() {
        const script = buildAppLevelScript(`
      set ruleList to {}
      repeat with r in rules
        set ruleName to name of r
        set ruleEnabled to enabled of r
        set end of ruleList to ruleName & "${FIELD_SEP}" & (ruleEnabled as string)
      end repeat
      set AppleScript's text item delimiters to "${RECORD_SEP}"
      return ruleList as text
    `);
        const result = executeAppleScript(script);
        if (!result.success || !result.output.trim()) {
            return [];
        }
        const items = result.output.split(RECORD_SEP);
        const rules = [];
        for (const item of items) {
            const parts = item.split(FIELD_SEP);
            if (parts.length < 2)
                continue;
            rules.push({
                name: parts[0],
                enabled: parts[1] === "true",
            });
        }
        return rules;
    }
    /**
     * Enable or disable a mail rule.
     */
    setRuleEnabled(ruleName, enabled) {
        const safeName = escapeForAppleScript(ruleName);
        const script = buildAppLevelScript(`
      try
        repeat with r in rules
          if name of r is "${safeName}" then
            set enabled of r to ${enabled}
            return "ok"
          end if
        end repeat
        return "error:Rule not found"
      on error errMsg
        return "error:" & errMsg
      end try
    `);
        const result = executeAppleScript(script);
        if (!result.success || result.output.startsWith("error:")) {
            console.error(`Failed to set rule state: ${result.error || result.output}`);
            return false;
        }
        return true;
    }
    /**
     * Create a mail rule (B2). Builds conditions (from/to/cc/subject/content with
     * a match operator) and actions (mark read/flagged, delete, move to a
     * mailbox) on a real Mail.app rule. Returns an error string on failure.
     */
    createRule(opts) {
        const safeName = escapeForAppleScript(opts.name);
        if (!opts.conditions?.length) {
            return { success: false, error: "A rule needs at least one condition." };
        }
        const ruleTypeMap = {
            from: "from header",
            to: "to header",
            cc: "cc header",
            subject: "subject header",
            content: "message content",
        };
        const qualifierMap = {
            contains: "does contain value",
            notContains: "does not contain value",
            equals: "equal to value",
            beginsWith: "begins with value",
            endsWith: "ends with value",
        };
        const conditionStmts = opts.conditions
            .map((c) => {
            const rt = ruleTypeMap[c.field];
            const q = qualifierMap[c.operator];
            return `        make new rule condition at end of rule conditions of newRule with properties {rule type:${rt}, qualifier:${q}, expression:"${escapeForAppleScript(c.value)}"}`;
        })
            .join("\n");
        const actionStmts = [];
        const a = opts.actions ?? {};
        if (a.markRead)
            actionStmts.push(`        set mark read of newRule to true`);
        if (a.markFlagged)
            actionStmts.push(`        set mark flagged of newRule to true`);
        if (a.delete)
            actionStmts.push(`        set delete message of newRule to true`);
        if (a.moveTo) {
            const safeMbox = escapeForAppleScript(a.moveTo);
            const mboxRef = a.moveToAccount
                ? `mailbox "${safeMbox}" of account "${escapeForAppleScript(a.moveToAccount)}"`
                : `mailbox "${safeMbox}"`;
            actionStmts.push(`        set should move message of newRule to true`);
            actionStmts.push(`        set move message of newRule to ${mboxRef}`);
        }
        if (!actionStmts.length) {
            return { success: false, error: "A rule needs at least one action." };
        }
        const enabled = opts.enabled !== false;
        const matchAll = opts.matchAll !== false; // default: all conditions must match
        const script = buildAppLevelScript(`
      try
        repeat with existing in rules
          if name of existing is "${safeName}" then return "error:A rule named '${safeName}' already exists."
        end repeat
        set newRule to make new rule at end of rules with properties {name:"${safeName}", enabled:${enabled}}
        set all conditions must be met of newRule to ${matchAll}
${conditionStmts}
${actionStmts.join("\n")}
        return "ok"
      on error errMsg
        return "error:" & errMsg
      end try
    `);
        const result = executeAppleScript(script);
        if (!result.success || result.output.startsWith("error:")) {
            const error = result.output?.replace(/^error:/, "") || result.error || "Unknown error";
            return { success: false, error };
        }
        return { success: true };
    }
    /**
     * Delete a mail rule by name (B2). Returns false if no such rule exists.
     */
    deleteRule(ruleName) {
        const safeName = escapeForAppleScript(ruleName);
        // Delete via a `whose` filter rather than iterating + `delete r`: mutating
        // the rules collection mid-`repeat` invalidates the loop reference
        // ("Can't get item N of every rule").
        const script = buildAppLevelScript(`
      try
        set matches to (every rule whose name is "${safeName}")
        if (count of matches) is 0 then return "error:Rule not found"
        delete (every rule whose name is "${safeName}")
        return "ok"
      on error errMsg
        return "error:" & errMsg
      end try
    `);
        const result = executeAppleScript(script);
        if (!result.success || result.output.startsWith("error:")) {
            console.error(`Failed to delete rule: ${result.error || result.output}`);
            return false;
        }
        return true;
    }
    // ===========================================================================
    // Contacts Integration
    // ===========================================================================
    /**
     * Search contacts by name or email.
     */
    searchContacts(query) {
        const safeQuery = escapeForAppleScript(query);
        const script = `
      tell application "Contacts"
        set matchedContacts to {}
        set foundPeople to (every person whose name contains "${safeQuery}") & (every person whose value of emails contains "${safeQuery}")

        -- Deduplicate by tracking IDs
        set seenIds to {}
        repeat with p in foundPeople
          set pid to id of p
          if seenIds does not contain pid then
            set end of seenIds to pid
            -- Per-person try: one malformed contact (e.g. no emails) must not
            -- abort the whole search and return an empty list (audit finding #13).
            try
              set pName to name of p
              set pEmails to ""
              repeat with e in emails of p
                if pEmails is not "" then set pEmails to pEmails & ","
                set pEmails to pEmails & (value of e)
              end repeat
              set pPhones to ""
              repeat with ph in phones of p
                if pPhones is not "" then set pPhones to pPhones & ","
                set pPhones to pPhones & (value of ph)
              end repeat
              set end of matchedContacts to pName & "${FIELD_SEP}" & pEmails & "${FIELD_SEP}" & pPhones
            end try
          end if
        end repeat

        set AppleScript's text item delimiters to "${RECORD_SEP}"
        return matchedContacts as text
      end tell
    `;
        const result = executeAppleScript(script);
        if (!result.success || !result.output.trim()) {
            return [];
        }
        const items = result.output.split(RECORD_SEP);
        const contacts = [];
        for (const item of items) {
            const parts = item.split(FIELD_SEP);
            if (parts.length < 3)
                continue;
            contacts.push({
                name: parts[0],
                emails: parts[1] ? parts[1].split(",").filter(Boolean) : [],
                phones: parts[2] ? parts[2].split(",").filter(Boolean) : [],
            });
        }
        return contacts;
    }
    // ===========================================================================
    // Email Templates
    // ===========================================================================
    // Templates persist to disk (B3 / #14) so they survive server restarts.
    templateStore = new TemplateStore();
    /**
     * List all stored templates.
     */
    listTemplates() {
        return this.templateStore.list();
    }
    /**
     * Get a template by ID.
     */
    getTemplate(id) {
        return this.templateStore.get(id);
    }
    /**
     * Create or update a template (persisted).
     */
    saveTemplate(name, subject, body, to, cc, id) {
        return this.templateStore.save(name, subject, body, to, cc, id);
    }
    /**
     * Delete a template (persisted).
     */
    deleteTemplate(id) {
        return this.templateStore.delete(id);
    }
    /**
     * Use a template to create a draft.
     */
    useTemplate(id, overrides) {
        const template = this.templateStore.get(id);
        if (!template)
            return false;
        // Use `??` (not `||`) for subject/body so an intentional empty-string
        // override is honored rather than falling back to the template value
        // (audit finding #14).
        const to = overrides?.to ?? template.to ?? [];
        const cc = overrides?.cc ?? template.cc;
        const subject = overrides?.subject ?? template.subject;
        const body = overrides?.body ?? template.body;
        if (to.length === 0)
            return false;
        return this.createDraft(to, subject, body, cc);
    }
    // ===========================================================================
    // Diagnostics
    // ===========================================================================
    /**
     * Run health check on Mail.app connectivity.
     */
    healthCheck() {
        const checks = [];
        // Check 1: Mail.app is accessible
        const mailCheck = executeAppleScript('tell application "Mail" to return "ok"');
        if (mailCheck.success && mailCheck.output === "ok") {
            checks.push({
                name: "mail_app",
                passed: true,
                message: "Mail.app is accessible",
            });
        }
        else {
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
        }
        else {
            const isPermError = permCheck.error?.includes("not authorized") || permCheck.error?.includes("not permitted");
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
        }
        else {
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
    getMailStats() {
        const accounts = this.listAccounts();
        const accountStats = [];
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
    getRecentlyReceivedStats() {
        // Get message counts for different time periods
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        // Thresholds are built from numeric components via buildAppleScriptDate
        // rather than `date "January 5, 2026"` string coercion. The English-month
        // literal throws "Invalid date and time (-30720)" on non-English system
        // locales; that throw was swallowed by the per-inbox `try` below, so this
        // method silently returned 0/0/0 on those Macs — the same locale regression
        // fixed for searchMessages in #15 / surfaced again in #28.
        // Only scan INBOX for performance - scanning all mailboxes is too slow
        const script = buildAppLevelScript(`
      set last24h to 0
      set last7d to 0
      set last30d to 0
      ${buildAppleScriptDate("oneDayAgo", oneDayAgo)}
      ${buildAppleScriptDate("sevenDaysAgo", sevenDaysAgo)}
      ${buildAppleScriptDate("thirtyDaysAgo", thirtyDaysAgo)}

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

      return (last24h as string) & "${FIELD_SEP}" & (last7d as string) & "${FIELD_SEP}" & (last30d as string)
    `);
        const result = executeAppleScript(script, { timeoutMs: 60000 });
        if (!result.success || !result.output.trim()) {
            console.error(`Failed to get recently received stats: ${result.error}`);
            return { last24h: 0, last7d: 0, last30d: 0 };
        }
        const parts = result.output.split(FIELD_SEP);
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
    getSyncStatus() {
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

      return "running${FIELD_SEP}" & accountCount & "${FIELD_SEP}" & totalMailboxes
    `);
        // Counts mailboxes across every account; give it headroom over the 30s
        // default so a slow account doesn't silently report "not syncing" (#8).
        const result = executeAppleScript(script, { timeoutMs: 60000 });
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
        const parts = result.output.split(FIELD_SEP);
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
