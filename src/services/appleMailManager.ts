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
import {
  constants as fsConstants,
  chmodSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  copyFileSync,
  renameSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  lstatSync,
} from "fs";
import { resolve, sep, join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { executeAppleScript, isPermissionDenied } from "@/utils/applescript.js";
import { SETUP_HINT } from "@/utils/docsUrls.js";
import { parseMimeAttachments, extractMimeAttachment, extractHtmlBody } from "@/utils/mimeParse.js";
import { TemplateStore } from "@/services/templateStore.js";
import { materializeAttachments } from "@/utils/attachmentMaterialize.js";
import { resolveAttachmentReadPath } from "@/utils/attachmentReadPolicy.js";
import { searchContactsDb } from "@/utils/contactsDb.js";
import {
  isAuditEnabled,
  auditSubjectsEnabled,
  auditSnapshotMax,
  auditSnapshotChunk,
  SNAPSHOT_SLICE_ATTEMPTS,
  AUDIT_SNAPSHOT_MAX_ENV,
  type CountDelta,
  type AuditPreImage,
  type AuditOutcome,
  type CollateralDiff,
  type DestructiveOpReport,
} from "@/services/auditLog.js";
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
  MailRule,
  RuleSpec,
  RuleConditionField,
  RuleConditionOperator,
  AttachmentInput,
  Contact,
  EmailTemplate,
  SerialEmailRecipient,
  SerialEmailResult,
  SearchDiagnostics,
  SearchResult,
  AppleScriptResult,
  SmartMailbox,
} from "@/types.js";

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
function getMailboxScanThreshold(): number {
  const raw = process.env.APPLE_MAIL_MAX_SEARCH_MAILBOX;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
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
 * (Unit/Record/Group Separator), which mail field values are not SUPPOSED to
 * contain. The same constant is used by the AppleScript emitter (interpolated
 * into the script string) and the TS parser, so the two can never drift.
 *
 * "not supposed to contain" is not "cannot contain" — see
 * `stripStreamDelimiters` / `sanitizeFragment` below.
 */
const GROUP_SEP = "\x1d"; // GS — opens/closes the tag markers built below
const FIELD_SEP = "\x1f"; // US — between fields within a record
const RECORD_SEP = "\x1e"; // RS — between records
const DIAG_MARKER = "\x1dDIAG\x1d"; // GS-wrapped — payload/diagnostics boundary
const DIAG_FIELD_SEP = "\x1dF\x1d"; // between diagnostics fields
const DIAG_ITEM_SEP = "\x1dM\x1d"; // between diagnostics list items
const CONTENT_MARKER = "\x1dCONTENT\x1d"; // subject/plain-text boundary
const MSGID_MARKER = "\x1dMSGID\x1d"; // subject/RFC-Message-ID boundary (get-message content)
const HTML_MARKER = "\x1dHTML\x1d"; // plain-text/source boundary
const LOOKUP_ERROR_MARKER = "\x1dERR\x1d"; // GS-wrapped — by-id lookup failure; must not be a bare text prefix because the success payload of the same script leads with the sender-controlled subject
const BATCH_FATAL = "\x1dFATAL\x1d"; // prefix for a whole-batch failure (e.g. bad destination)
/**
 * Forensic record tags (#155). These ride in the SAME delimited stream as the
 * per-id outcome records, emitted by the SAME AppleScript, so the effect
 * reconciliation and the collateral snapshot cost ZERO extra `osascript`
 * invocations — the single-invocation property from issue #31 is preserved
 * exactly. A tag occupies the field where a record normally carries its 1-based
 * position, and no position can ever be one of these strings, so old and new
 * records coexist unambiguously in one stream.
 *
 * ## Invariant for EVERY emitter into this stream
 *
 * Any value interpolated into a record must first be stripped of GROUP_SEP,
 * RECORD_SEP and FIELD_SEP — `stripStreamDelimiters()` for a value interpolated
 * from TypeScript, `AppleMailManager.sanitizeFragment()` for one read inside the
 * script (a Message-ID, a subject, a `date received`, a mailbox or account name
 * Mail returns at runtime, an error string Mail composed). It holds for the
 * boring records too — outcome, `notfound`, `error:`, "mailbox not found",
 * ambiguity — not only the ones carrying obviously attacker-controlled text.
 * An invariant with exceptions is not an invariant: the next emitter will be
 * copied from whichever one its author happened to read, and one unstripped
 * value is enough to forge a RECON record and fabricate the `over` warning this
 * whole feature exists to produce.
 */
const RECON_TAG = "\x1dRECON\x1d"; // mailbox count before/after one mutation group
const SNAP_TAG = "\x1dSNAP\x1d"; // (id, Message-ID) snapshot of a mailbox
const SNAP_PAIR = "\x1dP\x1d"; // between a snapshot entry's id and Message-ID
const SNAP_ITEM = "\x1dI\x1d"; // between snapshot entries

/**
 * What replaces a stream delimiter found inside a VALUE. A visible, non-empty
 * marker on purpose: a Message-ID that arrives with control characters in it is
 * malformed (RFC 5322 `msg-id` admits no control characters), and the record
 * should say the value was altered rather than quietly hand back a shortened
 * string that looks authentic.
 */
const DELIMITER_REPLACEMENT = "�";

/**
 * Remove the stream's structural bytes from a value that is about to be
 * interpolated into it.
 *
 * The forensic stream carries values that come from INBOUND MAIL — the RFC
 * Message-ID always, the subject under `APPLE_MAIL_MCP_AUDIT_SUBJECTS` — so
 * anyone who can send mail controls those bytes. A Message-ID containing a
 * literal RECORD_SEP followed by a forged `RECON` tag would inject a
 * reconciliation record the operation never emitted, and could therefore
 * fabricate the very `over` warning this instrumentation exists to produce.
 * Reachable only with the audit log on, which is exactly when someone is
 * chasing a real incident and can least afford invented evidence.
 *
 * The AppleScript side does the same thing to the same characters at the source
 * (`AppleMailManager.sanitizeFragment`); this is the TS-side counterpart for
 * values interpolated into the emitter from here (account and mailbox names).
 */
export function stripStreamDelimiters(value: string): string {
  let out = value;
  for (const d of [GROUP_SEP, RECORD_SEP, FIELD_SEP])
    out = out.split(d).join(DELIMITER_REPLACEMENT);
  return out;
}
/**
 * Leading text of the error returned when a bare numeric id can't be pinned to
 * one mailbox. Mail.app ids are per-mailbox and a label store repeats one id
 * across INBOX / "Important" / "All Mail", so a mutation with no recorded
 * source mailbox has no safe target to pick (#152).
 */
const AMBIGUOUS_ID_PREFIX = "Message id ";
/** Same refusal, phrased for the batch path where the id isn't interpolable. */
const AMBIGUOUS_ID_BATCH = "This message id is present in more than one mailbox ";

/**
 * Normalize an RFC 5322 Message-ID for backend-independent matching: trim and
 * drop any surrounding angle brackets. Mail.app's AppleScript `message id`
 * property returns the value bracketless already, but normalize defensively so
 * the surfaced value is consistent regardless of source. Returns "" for a
 * missing/blank value.
 */
function normalizeRfcMessageId(mid: string): string {
  return (mid || "").trim().replace(/^<+/, "").replace(/>+$/, "").trim();
}

/**
 * Merge a per-account SearchDiagnostics into an aggregate (all-accounts) one.
 *
 * Exported for unit testing.
 */
export function mergeSearchDiagnostics(into: SearchDiagnostics, from: SearchDiagnostics): void {
  into.timedOutAccounts.push(...from.timedOutAccounts);
  into.skippedLargeMailboxes.push(...from.skippedLargeMailboxes);
  into.notSearchedMailboxes.push(...from.notSearchedMailboxes);
  if (from.partial) into.partial = true;
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
export function splitSearchDiagnostics(
  output: string,
  account: string
): { payload: string; diagnostics: SearchDiagnostics } {
  const markerIdx = output.lastIndexOf(DIAG_MARKER);
  const payload = markerIdx >= 0 ? output.slice(0, markerIdx) : output;
  const trailer = markerIdx >= 0 ? output.slice(markerIdx + DIAG_MARKER.length) : "";

  const diagnostics: SearchDiagnostics = {
    partial: false,
    timedOutAccounts: [],
    skippedLargeMailboxes: [],
    notSearchedMailboxes: [],
  };

  if (trailer) {
    const fields = trailer.split(DIAG_FIELD_SEP);
    const getField = (key: string): string => {
      const f = fields.find((x) => x.startsWith(`${key}=`));
      return f ? f.slice(key.length + 1) : "";
    };
    const splitList = (raw: string): string[] =>
      raw
        .split(DIAG_ITEM_SEP)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

    diagnostics.skippedLargeMailboxes = splitList(getField("skipped")).map(
      (mb) => `${account} / ${mb}`
    );
    diagnostics.notSearchedMailboxes = splitList(getField("notSearched")).map(
      (mb) => `${account} / ${mb}`
    );
    if (getField("timedOut") === "true") diagnostics.partial = true;
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
export function isPathWithinAllowedRoots(resolvedPath: string): boolean {
  return ALLOWED_SAVE_ROOTS.some((root) => {
    const base = root.endsWith(sep) ? root.slice(0, -1) : root;
    return resolvedPath === base || resolvedPath.startsWith(base + sep);
  });
}

/** Resolve and validate an attachment save directory and its final output path. */
export function resolveAttachmentSaveTarget(
  savePath: string,
  attachmentName: string
): { saveDirectory: string; savedPath: string } {
  let saveDirectory: string;
  try {
    saveDirectory = realpathSync(resolve(savePath));
  } catch {
    throw new Error(`Save directory "${savePath}" does not exist`);
  }

  if (!isPathWithinAllowedRoots(saveDirectory)) {
    throw new Error(`Save path "${savePath}" is outside allowed directories`);
  }

  const savedPath = resolve(saveDirectory, attachmentName);
  if (!isPathWithinAllowedRoots(savedPath)) {
    throw new Error(`Output path "${savedPath}" is outside allowed directories`);
  }
  if (existsSync(savedPath)) {
    if (lstatSync(savedPath).isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symbolic link "${savedPath}"`);
    }
    throw new Error(`Refusing to overwrite existing file "${savedPath}"`);
  }

  return { saveDirectory, savedPath };
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
export function describeMailboxOpError(op: "create" | "delete" | "rename", raw: string): string {
  const trimmed = (raw || "").trim();
  if (UNSUPPORTED_APPLESCRIPT_OP.test(trimmed)) {
    const verb = op.charAt(0).toUpperCase() + op.slice(1);
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
export function chooseDefaultAccount(
  accounts: Account[],
  opts: { override?: string; defaultSendEmail?: string } = {}
): string | null {
  const norm = (s: string): string => s.trim().toLowerCase();
  const override = opts.override?.trim();
  if (override) {
    const o = norm(override);
    const m = accounts.find((a) => norm(a.name) === o || norm(a.email) === o);
    if (m) return m.name; // honor an explicit pin even if that account is disabled
  }
  if (opts.defaultSendEmail) {
    const e = norm(opts.defaultSendEmail);
    const m = accounts.find((a) => norm(a.email) === e);
    if (m && m.enabled) return m.name;
  }
  const firstEnabled = accounts.find((a) => a.enabled);
  if (firstEnabled) return firstEnabled.name;
  return accounts[0]?.name ?? null;
}

export function escapeForAppleScript(text: string): string {
  if (!text) return "";
  // Escape backslash and double-quote for the AppleScript string literal, and
  // strip ASCII control characters. An AppleScript double-quoted literal cannot
  // contain a raw newline, so an interpolated value with a `\n` (or other
  // control char) would terminate the literal early and could inject a
  // statement; stripping them closes that gap (audit finding #10).
  return (
    text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, "")
  );
}

/**
 * Escape a message BODY for interpolation into an AppleScript string literal.
 *
 * Same injection defense as {@link escapeForAppleScript} (backslash then quote,
 * in that order), but instead of stripping line breaks it converts CRLF / CR /
 * LF to the two-character sequence `\n` (and tab to `\t`), which AppleScript
 * 2.0+ interprets as a linefeed/tab inside a double-quoted literal. No raw
 * control character ever reaches the emitted literal, so the audit finding #10
 * fix is preserved — but paragraph breaks survive in bodies instead of
 * collapsing into a wall of text. Any remaining control characters are
 * stripped exactly as in the single-line variant.
 *
 * Use ONLY for body/content values. Subjects, addresses, account/mailbox
 * names, paths, queries, and rule expressions must stay on
 * {@link escapeForAppleScript} so they remain single-line.
 */
export function escapeForAppleScriptBody(text: string): string {
  if (!text) return "";
  return (
    text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r\n|\r|\n/g, "\\n")
      .replace(/\t/g, "\\t")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, "")
  );
}

/**
 * Validates attachment file paths and builds AppleScript commands to attach them.
 *
 * @param attachments - Absolute file paths in the configured read roots
 * @returns AppleScript commands to add attachments, or empty string if none
 * @throws Error if any path is not absolute, readable, regular, or allowlisted
 */
function buildAttachmentCommands(attachments?: string[]): string {
  if (!attachments || attachments.length === 0) return "";
  const readablePaths = attachments.map((filePath) => resolveAttachmentReadPath(filePath));
  let commands = "";
  for (const filePath of readablePaths) {
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
 * Build the AppleScript loop that turns a message collection into delimited
 * rows (C1, audit #11). It first tries a *bulk* read — one Apple Event per
 * property for the whole collection (`subject of msgs`, `sender of msgs`, …),
 * ~6 events total instead of ~6 per message — and only on error falls back to
 * the original per-message reads. The per-iteration `try` preserves the
 * malformed-message isolation (#13): one bad message can't abort the batch,
 * and if a bulk read throws (the audit's regression worry) we degrade to the
 * safe per-message path automatically.
 *
 * Expects `outputText`, `msgCount` (and, when `dedup`, `seenIds`) already in
 * scope at the call site; appends rows and advances `msgCount` up to `limit`.
 */
function buildMessageRowLoop(opts: {
  collection: string;
  limit: number;
  dedup?: boolean;
  dateFilter?: string;
  trailing?: string;
  /** Honor an `offset` by skipping the first N matched (uses a `skipped` var). */
  offset?: number;
  /** Append a hasAttachments field (bulk-reads `mail attachments`). */
  withAttachments?: boolean;
}): string {
  const { collection, limit, dedup, dateFilter, trailing = "", offset, withAttachments } = opts;
  const dedupOpen = dedup
    ? `if seenIds does not contain msgId then\n            set end of seenIds to msgId`
    : "";
  const dedupClose = dedup ? `end if` : "";
  const offsetOpen =
    offset !== undefined
      ? `if skipped < ${offset} then\n            set skipped to skipped + 1\n          else`
      : "";
  const offsetClose = offset !== undefined ? `end if` : "";
  const dateOpen = dateFilter
    ? `set msgDate to d\n            if not (${dateFilter}) then\n              -- outside date range; skip\n            else`
    : "";
  const dateClose = dateFilter ? `end if` : "";
  const attBulk = withAttachments ? `\n        set _atts to mail attachments of _msgs` : "";
  const attRow = withAttachments
    ? `
          set msgHasAtt to "false"
          try
            if _bulkOK then
              if (count of (item _i of _atts)) > 0 then set msgHasAtt to "true"
            else
              if (count of mail attachments of (item _i of _msgs)) > 0 then set msgHasAtt to "true"
            end if
          end try`
    : "";
  const attField = withAttachments ? ` & "${FIELD_SEP}" & msgHasAtt` : "";
  return `
      set _msgs to ${collection}
      set _bulkOK to true
      try
        set _ids to id of _msgs
        set _subjs to subject of _msgs
        set _sndrs to sender of _msgs
        set _dates to date received of _msgs
        set _reads to read status of _msgs
        set _flags to flagged status of _msgs${attBulk}
      on error
        set _bulkOK to false
      end try
      repeat with _i from 1 to (count of _msgs)
        if msgCount >= ${limit} then exit repeat
        try
          if _bulkOK then
            set msgId to (item _i of _ids) as string
          else
            set msgId to id of (item _i of _msgs) as string
          end if
          ${dedupOpen}
          ${offsetOpen}
          if _bulkOK then
            set d to item _i of _dates
          else
            set d to date received of (item _i of _msgs)
          end if
          ${dateOpen}
          if _bulkOK then
            set msgSubject to item _i of _subjs
            set msgSender to item _i of _sndrs
            set msgRead to (item _i of _reads) as string
            set msgFlagged to (item _i of _flags) as string
          else
            set _m to item _i of _msgs
            set msgSubject to subject of _m
            set msgSender to sender of _m
            set msgRead to read status of _m as string
            set msgFlagged to flagged status of _m as string
          end if${attRow}
          set msgDateStr to ${AS_DATE_TO_STRING}
          if msgCount > 0 then set outputText to outputText & "${RECORD_SEP}"
          set outputText to outputText & msgId & "${FIELD_SEP}" & msgSubject & "${FIELD_SEP}" & msgSender & "${FIELD_SEP}" & msgDateStr & "${FIELD_SEP}" & msgRead & "${FIELD_SEP}" & msgFlagged${trailing}${attField}
          set msgCount to msgCount + 1
          ${dateClose}
          ${offsetClose}
          ${dedupClose}
        end try
      end repeat`;
}

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
function parseAppleScriptDate(dateStr: string): Date {
  // Try locale-independent numeric format first: "YYYY-M-D-H-m-s"
  const numParts = dateStr.split("-").map(Number);
  if (numParts.length === 6 && numParts.every((n) => !isNaN(n))) {
    return new Date(
      numParts[0],
      numParts[1] - 1,
      numParts[2],
      numParts[3],
      numParts[4],
      numParts[5]
    );
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
export function buildAppleScriptDate(varName: string, d: Date): string {
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
function buildAccountScopedScript(account: string, command: string): string {
  return `
    tell application "Mail"
      tell account "${escapeForAppleScript(account)}"
        ${command}
      end tell
    end tell
  `;
}

// ---------------------------------------------------------------------------
// Mail's LOCAL store ("On My Mac") — #183
//
// Local mailboxes are NOT children of any `account`; they hang off the
// application. Every enumeration here walked `accounts` → `mailboxes of acct`,
// so local mail was invisible: not listable, not searchable, not addressable.
//
// Measured against a live Mail.app on 2026-08-16 (read-only probe, results on
// issue #183) — these are facts, not assumptions:
//   • `account of <an app-level mailbox>` returns `missing value`. It does not
//     raise, and does not return a bogus object.
//   • `account of <an account mailbox>` correctly names its account, so the
//     ownership filter below cannot mistake one for a local mailbox. That is
//     what stops it double-listing every account mailbox.
//   • App-level `mailboxes` returned ONLY the 4 local mailboxes while the
//     accounts separately held 26 — i.e. no overlap on this backend, so the
//     filter is insurance (POP is untested), not the load-bearing mechanism.
//   • Local mailboxes answer `unread count` and `count of messages` normally.
// ---------------------------------------------------------------------------

/** The synthetic account label the local store is addressed by. */
export const LOCAL_STORE_LABEL = "On My Mac";

/** Names a caller might reasonably use for the local store. */
const LOCAL_STORE_ALIASES = ["on my mac", "on my computer", "local", "local folders"];

/** True when `name` addresses Mail's local store rather than a real account. */
export function isLocalStoreLabel(name: string | undefined): boolean {
  return name !== undefined && LOCAL_STORE_ALIASES.includes(name.trim().toLowerCase());
}

/**
 * Binds `_mbs` to the application-level mailboxes that belong to no account.
 *
 * The `try` wrapper is deliberate belt-and-braces: the live probe says
 * `account of` returns `missing value` here, but a backend that RAISES instead
 * must also be treated as local rather than aborting the whole enumeration.
 * A mailbox whose `account` names something is an account mailbox and is
 * excluded — that exclusion is the only thing standing between this and
 * double-listing every account mailbox on a backend where the two sets overlap.
 */
function localMailboxBindingFragment(): string {
  return `
      set _mbs to {}
      repeat with _m in mailboxes
        set _isLoc to false
        try
          if (account of _m) is missing value then set _isLoc to true
        on error
          set _isLoc to true
        end try
        if _isLoc then set end of _mbs to (contents of _m)
      end repeat`;
}

/**
 * Key for the per-source-mailbox grouping in runBatchOperation.
 *
 * ONE definition, used by both the producer and every consumer. It was two
 * inline template literals with different separators for about an hour, which
 * silently made every reconciliation lookup miss and report `expected: 0` — the
 * exact false-alarm the #155 warning must never produce.
 *
 * The separator is written as the ESCAPE `\u0000`, never as a literal NUL
 * byte. A single raw 0x00 anywhere in this file makes it BINARY to `ripgrep` —
 * which then refuses to search it at all — and to plain `grep`, silently
 * costing everyone their tooling on the largest source file in the repo.
 */
function groupKey(account: string, mailbox: string): string {
  return `${account}\u0000${mailbox}`;
}

/**
 * One representation for a numeric Mail id, whichever side produced it.
 *
 * A Mail id above AppleScript's 2^29 integer range is a REAL there, and
 * `as string` renders it in scientific notation — `999999999` comes back as
 * `"9.99999999E+8"`. TypeScript renders that same id `"999999999"`. Comparing
 * those two strings says "different message".
 *
 * That comparison is what decides `CollateralDiff.unrequested`, so without this
 * a large-id mailbox reports a message the caller EXPLICITLY asked to delete as
 * collateral damage — a fabricated finding, handed to someone mid-incident who
 * is trying to work out what was destroyed. Both sides of the membership test go
 * through here, and so does every id the report surfaces, so the numeric id a
 * caller reads back is the one they passed in.
 *
 * Non-numeric input is returned trimmed and unchanged rather than coerced: an id
 * that will not parse must not silently become `NaN` and collide with every
 * other unparseable id.
 */
function canonicalNumericId(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return "";
  const n = Number(trimmed);
  return Number.isFinite(n) ? String(n) : trimmed;
}

/**
 * The `note` on a move whose destination IS the source mailbox, and the reason
 * that mailbox carries `expected: null` / `status: "unknown"` rather than a
 * comparison. Shared by the single-message and the batch path so the two cannot
 * describe the same situation differently.
 */
const SELF_MOVE_NOTE =
  "Destination is the source mailbox, so no message should leave it. What Mail does to the " +
  "count when a message is re-filed into the mailbox it already occupies is unspecified, so " +
  "there is no expected delta to compare against: this mailbox is reported without a " +
  "comparison and is never warned about.";

/**
 * The `note` when the count did not move AT ALL (`unknownReason:
 * "count-did-not-move"`).
 *
 * This is the ordinary reading on a store that flags deletions instead of
 * removing them, and it must keep saying so plainly. Two things it deliberately
 * does NOT do, both of which a previous version got wrong (#155):
 *
 *   - it does not tell the reader to go check a destination. On a flag-only
 *     store the message was never moved, so there is nothing to find, and its
 *     absence reads as "the delete failed" when the delete succeeded;
 *   - it does not suggest retrying. The operation reported success per id, and
 *     a retry on the strength of a count is how one deletes twice.
 */
const COUNT_UNMOVED_NOTE =
  "Mail's count did not move. This is the ordinary reading on a store that flags deletions " +
  'instead of removing them (Gmail label mailboxes and IMAP accounts with "move deleted ' +
  'messages to Trash" off), where the message stays put and the operation still fully ' +
  "succeeded. It can also mean Mail's count simply had not caught up yet. The per-id outcomes " +
  "are what report success; this number is not, so do not retry on the strength of it.";

/**
 * The `note` when the count moved but by less than the operation accounted for
 * (`unknownReason: "count-partial"`).
 *
 * A flag-only store cannot produce this shape — its count does not move at all —
 * so unlike COUNT_UNMOVED_NOTE this one can talk about a lag without being wrong
 * on the commonest benign store.
 */
const COUNT_PARTIAL_NOTE =
  "Mail's count moved by less than this operation accounted for. That is a LOWER BOUND on " +
  "what left, not a count of what left: Mail has been observed reporting a stale count for a " +
  "delete it had already performed (issue #155), and new mail arriving mid-operation reads the " +
  "same way. No claim is made either way. To confirm where the messages went, match them at " +
  'the destination by "date received" plus sender — NOT by the numeric ids you passed, which ' +
  "are renumbered by the move and do not survive it.";

/**
 * Same key discipline for a snapshot entry's (numeric id, Message-ID) identity —
 * including writing the separator as an escape rather than a raw byte. The id
 * half is already canonicalised by `parseSnapshot`, so both phases of a
 * before/after diff key on the same representation.
 */
function snapshotKey(entry: { id: string; messageId: string }): string {
  return `${entry.id}\u0000${entry.messageId}`;
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

/**
 * The mailbox names (as `list-mailboxes` reports them) that hold a Gmail-style
 * account's actually-received mail. On Gmail/Google-Workspace accounts the
 * literal "INBOX" mailbox that Mail.app exposes is a virtual shell that holds
 * ~0 messages — real inbox mail lives under the "All Mail" (`\All`) and
 * "Important" (`\Important`) special mailboxes (nested in Mail.app's `[Gmail]`
 * container, so they DON'T resolve by a flat `mailbox "All Mail"` lookup and
 * must be found by iterating and matching `name of mb`). "All Mail" is the
 * superset that contains every inbox message, so scoping/scanning "INBOX" to
 * this set makes scoped search/get-thread/stats see the same mail an unscoped
 * call reports. See BUG A / issue: Gmail virtual-INBOX handling.
 */
const GMAIL_INBOX_MAILBOXES = ["All Mail", "Important"] as const;

/** Lowercased names that a caller might use to mean "the inbox". */
const INBOX_SCOPE_NAMES = new Set(["inbox"]);

/** True when `mailbox` (case-insensitively) refers to the inbox. */
function isInboxScope(mailbox: string): boolean {
  return INBOX_SCOPE_NAMES.has(mailbox.trim().toLowerCase());
}

/**
 * Detect a Gmail-style account from its mailbox-name list: it exposes an
 * "All Mail" special mailbox. Returns the subset of GMAIL_INBOX_MAILBOXES that
 * actually exist on the account (so we only scan mailboxes that are present),
 * or `null` when the account is not Gmail-style (no "All Mail") — callers then
 * keep the ordinary single-INBOX behavior. Matching is case-insensitive.
 */
function gmailReceivingMailboxes(mailboxNames: readonly string[]): string[] | null {
  const lower = mailboxNames.map((n) => n.toLowerCase());
  if (!lower.includes("all mail")) return null;
  const present = GMAIL_INBOX_MAILBOXES.filter((want) => lower.includes(want.toLowerCase()));
  return present.length > 0 ? present : null;
}

/**
 * AppleScript literal list of quoted, lowercased mailbox names, e.g.
 * `{"all mail", "important"}` — for a case-insensitive `name of mb` membership
 * test inside a generated script.
 */
function appleScriptLowerNameList(names: readonly string[]): string {
  return "{" + names.map((n) => `"${escapeForAppleScript(n.toLowerCase())}"`).join(", ") + "}";
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
export interface SearchConditionFilters {
  query?: string;
  from?: string;
  subject?: string;
  isRead?: boolean;
  isFlagged?: boolean;
}

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
export function buildSearchCondition(filters: SearchConditionFilters): string {
  const { query, from, subject, isRead, isFlagged } = filters;
  const conditions: string[] = [];
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
  private defaultAccount: string | null = null;

  /**
   * TTL cache for expensive AppleScript queries that rarely change.
   * Caches account list and per-account mailbox names to avoid
   * redundant AppleScript roundtrips on every tool call.
   */
  private cache = {
    accounts: null as { data: Account[]; expiry: number } | null,
    mailboxNames: new Map<string, { data: string[]; expiry: number }>(),
  };

  /** Cache TTL in milliseconds (60 seconds). */
  private readonly CACHE_TTL_MS = 60_000;

  /**
   * Last AppleScript transport error from an account/count read, or null when the
   * last one succeeded. Lets a tool report "the transport failed" instead of
   * presenting a fallback zero/empty as a real answer. (#130)
   */
  private lastAccountsError: string | null = null;

  /**
   * Same, for the mailbox listing — read via `listMailboxesChecked()`. Kept
   * separate from `lastAccountsError` so a failed mailbox read on one account
   * can't be misread as the account enumeration having failed. (#135)
   */
  private lastMailboxesError: string | null = null;

  /**
   * Remembers where each message id was last seen: id → {account, mailbox}.
   *
   * Mail.app numeric message ids are unique *per mailbox*, and by-id fetches
   * (getMessageContent/getRawSource) otherwise have to linear-scan every mailbox
   * of every account probing `whose id is N`. On a real multi-account setup that
   * is 700+ mailboxes; a message in a late-iterated folder (e.g. a large "Sent
   * Items") isn't reached before the AppleScript timeout fires, so the fetch
   * returns a false "not found" (only INBOX ids, reached early, worked). Every
   * search/list/by-id result records its id→location here so a subsequent fetch
   * opens the one right mailbox directly. A stale entry (message moved) simply
   * misses and falls back to the full scan, so it can never wedge a lookup.
   */
  private idLocationIndex = new Map<string, { account: string; mailbox: string }>();

  /** Error from the most recent numeric message read, if it was refused. */
  private lastMessageLookupError: string | undefined;

  /** Cap on the id→location index so a long-lived process can't grow unbounded. */
  private readonly ID_LOCATION_MAX = 5000;

  /** Record (or refresh) where a message id lives, evicting oldest when full. */
  private rememberLocation(id: string, account: string, mailbox: string): void {
    if (!id || !account || !mailbox) return;
    // Re-insert to keep Map insertion order ~ recency for simple FIFO eviction.
    if (this.idLocationIndex.has(id)) this.idLocationIndex.delete(id);
    this.idLocationIndex.set(id, { account, mailbox });
    if (this.idLocationIndex.size > this.ID_LOCATION_MAX) {
      const oldest = this.idLocationIndex.keys().next().value;
      if (oldest !== undefined) this.idLocationIndex.delete(oldest);
    }
  }

  /** Where a message id was last listed/searched from, if we've seen it. */
  private locationFor(id: string): { account: string; mailbox: string } | undefined {
    return this.idLocationIndex.get(String(id));
  }

  /**
   * Publicly record where a message id lives.
   *
   * The index fills itself from list/search results, but that is per-process
   * state: a caller that carried ids across a process boundary (a stored triage
   * list, a scheduled job resuming) starts with an empty index, so every id is
   * "unlocated" and a label-store id gets refused as ambiguous. Registering the
   * known location restores scoped resolution.
   */
  noteMessageLocation(id: string, account: string, mailbox: string): void {
    this.rememberLocation(id, account, mailbox);
  }

  /** Consume the most recent read refusal so the tool layer can preserve it. */
  consumeLastMessageLookupError(): string | undefined {
    const error = this.lastMessageLookupError;
    this.lastMessageLookupError = undefined;
    return error;
  }

  /**
   * AppleScript fragment resolving `account` + `mailbox` into `_tmb`, leaving
   * `_tmb` as `missing value` when it can't be pinned down. Exact-name match
   * only, and a name matching more than one mailbox resolves to nothing rather
   * than guessing — the same rule the move destination already applies.
   */
  private resolveMailboxFragment(account: string, mailbox: string): string {
    const resolved = this.resolveMailbox(mailbox, account);
    return `
        set _tmb to missing value
        set _acctM to {}
        repeat with _a in accounts
          if (name of _a) is "${escapeForAppleScript(account)}" then set end of _acctM to _a
        end repeat
        if (count of _acctM) is 1 then
          set _mbM to {}
          repeat with _m in (mailboxes of (item 1 of _acctM))
            if (name of _m) is "${escapeForAppleScript(resolved)}" then set end of _mbM to _m
          end repeat
          if (count of _mbM) is 1 then set _tmb to item 1 of _mbM
        end if`;
  }

  // ===========================================================================
  // Destructive-operation forensics (#155)
  // ===========================================================================

  /**
   * What the last destructive operation observed about its own effect.
   *
   * Read once, by the tool layer, immediately after the call — every
   * AppleScript path in this class is synchronous (`spawnSync`), so there is no
   * await between the mutation and the read and no other operation can land in
   * between.
   *
   * ## Lifetime (one rule, no exceptions)
   *
   * The report belongs to the MOST RECENT message mutation, whatever it was.
   * `beginMutation()` clears it at the start of EVERY message mutation —
   * destructive or not, instrumented or not — and `consumeLastForensics()`
   * clears it on read. So the only two answers a caller can get are "the report
   * for the call I just made" and `undefined`; a mutation that produces no
   * report can never hand back the previous one's.
   *
   * It used to be cleared only by the instrumented paths, which left
   * `batch-mark-as-read` returning the preceding `batch-delete-messages`'
   * evidence if nobody had consumed it.
   */
  private lastForensics: DestructiveOpReport | undefined;

  /**
   * Start of a message mutation: invalidate whatever the previous one observed.
   *
   * Called by every single-message mutation (via `findMessageScript`), by
   * `moveMessage` (which builds its own script) and by `runBatchOperation`.
   */
  private beginMutation(): void {
    this.lastForensics = undefined;
  }

  /** Take (and clear) the forensic report for the destructive op just run. */
  consumeLastForensics(): DestructiveOpReport | undefined {
    const r = this.lastForensics;
    this.lastForensics = undefined;
    return r;
  }

  /**
   * AppleScript that reads a mailbox's message count into `varName`, leaving
   * `-1` when Mail will not answer. Two Apple Events per mutation group, inside
   * the script that is already running: no extra `osascript`.
   */
  private countFragment(varName: string, mbVar = "_tmb"): string {
    return `
        set ${varName} to -1
        try
          set ${varName} to (count of messages of ${mbVar})
        end try`;
  }

  /**
   * AppleScript that strips the stream's structural bytes out of `varName`,
   * in place, before it is appended to the record stream.
   *
   * This is the source-side half of the defence described on
   * `stripStreamDelimiters`: the values that go into a pre-image or a snapshot
   * (RFC Message-ID, `date received`, subject, mailbox and account names) are
   * attacker-influenced — a Message-ID is whatever the sender put in the
   * header — and a crafted one containing a RECORD_SEP plus a forged `RECON`
   * tag would otherwise inject a reconciliation record, fabricating an `over`
   * warning on an operation that did exactly the right thing.
   *
   * One pass: AppleScript accepts a LIST of text item delimiters when splitting
   * and uses the first when joining, so all three characters are replaced in a
   * single `text items` round trip. Verified with `osascript` directly.
   *
   * Deliberately distinct variable names (`_zTid`, `_zParts`) — AppleScript
   * identifiers are case-insensitive, so `_stid` would be the same variable as
   * the snapshot fragment's `_sTid`.
   */
  private sanitizeFragment(varName: string, indent = "        "): string {
    return `
${indent}set _zTid to AppleScript's text item delimiters
${indent}set AppleScript's text item delimiters to {"${GROUP_SEP}", "${RECORD_SEP}", "${FIELD_SEP}"}
${indent}set _zParts to text items of ${varName}
${indent}set AppleScript's text item delimiters to "${DELIMITER_REPLACEMENT}"
${indent}set ${varName} to _zParts as string
${indent}set AppleScript's text item delimiters to _zTid`;
  }

  /**
   * AppleScript emitting one `error:` outcome record into `_out`, with the
   * runtime error text sanitised first.
   *
   * Mail composes that text, and it routinely quotes back a mailbox or message
   * property, so it is a runtime-read value like any other — the same invariant
   * that covers the Message-ID and the snapshot covers it. `_zErr` (not `_e`)
   * because `sanitizeFragment` rewrites its variable in place and the handler's
   * own binding should be left alone.
   */
  private errorEmit(indent: string): string {
    return `${indent}set _zErr to (_e as string)${this.sanitizeFragment("_zErr", indent)}
${indent}set _out to _out & (_idx as string) & "${FIELD_SEP}error:" & _zErr & "${RECORD_SEP}"`;
  }

  /** AppleScript emitting one RECON record into `_out`. */
  private reconEmit(
    acctExpr: string,
    mbExpr: string,
    beforeVar: string,
    afterVar: string,
    posExpr = '""'
  ): string {
    return `
        set _out to _out & "${RECON_TAG}${FIELD_SEP}" & ${acctExpr} & "${FIELD_SEP}" & ${mbExpr} & "${FIELD_SEP}" & (${beforeVar} as string) & "${FIELD_SEP}" & (${afterVar} as string) & "${FIELD_SEP}" & ${posExpr} & "${RECORD_SEP}"`;
  }

  /**
   * RECON emission for the unlocated paths, where the account and mailbox names
   * are read from Mail at runtime (`_uacct`, `mailbox of _msg`) instead of being
   * interpolated as literals from here — so they get the same delimiter
   * stripping the literal paths get in TypeScript.
   */
  private reconEmitFromMessage(
    beforeVar: string,
    afterVar: string,
    posExpr = '""',
    indent = "          "
  ): string {
    return `set _umbName to ""
${indent}try
${indent}  set _umbName to (name of _umb)
${indent}end try${this.sanitizeFragment("_uacct", indent)}${this.sanitizeFragment("_umbName", indent)}${this.reconEmit("_uacct", "_umbName", beforeVar, afterVar, posExpr)}`;
  }

  /**
   * AppleScript capturing every (numeric id, RFC Message-ID) pair in a mailbox
   * into a SNAP record — the before/after pair the collateral diff subtracts.
   *
   * Empty string when the audit log is off or the snapshot is disabled, so the
   * whole layer costs literally nothing by default. The property reads are BULK
   * (`id of messages i thru j of mb`) — two Apple Events per SLICE rather than
   * two per message — and the joining is pure in-memory AppleScript.
   *
   * ## Why it is sliced rather than one whole-mailbox read (#176)
   *
   * This used to be a single `id of messages of mb` pair. When Mail declined
   * that request the entire snapshot came back `unavailable`, and the cost of
   * the request grows with the mailbox — so the one mechanism that can attribute
   * an unrequested departure was least reliable exactly when the batch and the
   * mailbox, and therefore the blast radius, were largest. That correlation was
   * the defect, not any individual failure.
   *
   * Now the mailbox is read in `APPLE_MAIL_MCP_AUDIT_SNAPSHOT_CHUNK`-sized
   * slices; each slice is retried once on its own; and a slice that still will
   * not read costs only its own range. The unreadable ranges are emitted in
   * their own field, so the diff can report a PARTIAL snapshot that names its
   * own gap instead of an all-or-nothing `unavailable`.
   *
   * Above `APPLE_MAIL_MCP_AUDIT_SNAPSHOT_MAX` messages the snapshot is skipped,
   * and the skip is EMITTED as a record with its reason. A silently skipped
   * snapshot would read as "nothing collateral happened".
   *
   * Caveat recorded in the docs: `(id of msg) as string` renders a Mail id above
   * AppleScript's 2^29 integer range in scientific notation. The Message-ID is
   * the authoritative key in this record for exactly that reason; the numeric id
   * is a convenience — and it is put back into decimal form by
   * `canonicalNumericId` in `parseSnapshot`, because the raw exponential string
   * would otherwise fail the `unrequested` membership test and name a REQUESTED
   * message as collateral.
   */
  private snapshotFragment(
    phase: "before" | "after",
    acctExpr: string,
    mbExpr: string,
    countVar: string,
    mbVar = "_tmb"
  ): string {
    const max = auditSnapshotMax();
    if (!isAuditEnabled() || max <= 0) return "";
    const chunk = auditSnapshotChunk();
    return `
        set _sStatus to "ok"
        set _sPayload to ""
        set _sMiss to ""
        set _sPairs to {}
        set _sChunk to ${chunk}
        -- The mailbox's MEASURED length, emitted only when it disagrees with the
        -- count (#187). -1 = "not measured", which is the normal case: the probe
        -- only runs a binary search when the count's last position is unreadable.
        -- Initialised here, not in the else-branch, or the skipped/unavailable
        -- paths would reference an unbound variable when emitting.
        set _sTrue to -1
        if ${countVar} < 0 then
          set _sStatus to "unavailable"
        else if ${countVar} > ${max} then
          set _sStatus to "skipped"
          set _sPayload to "mailbox holds " & (${countVar} as string) & " messages, above ${AUDIT_SNAPSHOT_MAX_ENV}=${max}"
        else
          -- #187: the count can read HIGH, and an out-of-range range RAISES as
          -- a whole rather than clamping. On a mailbox smaller than one chunk
          -- there is only ONE slice, so a high count made it fail entirely:
          -- _sPairs stayed empty, the status collapsed to "unavailable", and
          -- the record carried no holes and no warning. The collateral
          -- instrument switched itself off in exactly the stale direction #155
          -- evidences, silently.
          --
          -- So establish a bound that actually EXISTS before slicing. If the
          -- last position the count claims is readable, the count is not high
          -- and this costs one probe. Otherwise binary-search the true end,
          -- which is O(log n) probes and also MEASURES how stale the count is.
          set _sBound to ${countVar}
          if _sBound > 0 then
            set _sEndOk to false
            try
              get id of message _sBound of ${mbVar}
              set _sEndOk to true
            end try
            if not _sEndOk then
              set _sLoB to 0
              set _sHiB to _sBound
              repeat while (_sHiB - _sLoB) > 1
                set _sMid to (_sLoB + _sHiB) div 2
                set _sMidOk to false
                try
                  get id of message _sMid of ${mbVar}
                  set _sMidOk to true
                end try
                if _sMidOk then
                  set _sLoB to _sMid
                else
                  set _sHiB to _sMid
                end if
              end repeat
              set _sBound to _sLoB
              set _sTrue to _sLoB
            end if
          end if
          set _sLo to 1
          repeat while _sLo <= _sBound
            set _sHi to _sLo + _sChunk - 1
            if _sHi > _sBound then set _sHi to _sBound
            set _sGot to false
            repeat with _sTry from 1 to ${SNAPSHOT_SLICE_ATTEMPTS}
              set _sIds to {}
              set _sMids to {}
              -- A slice is staged into _sBuf and merged only once it has been
              -- read IN FULL. Appending as we go would leave a slice that threw
              -- halfway both partially recorded AND marked unread, and the
              -- retry would then record its messages a second time.
              set _sBuf to {}
              try
                set _sIds to (id of messages _sLo thru _sHi of ${mbVar})
                set _sMids to (message id of messages _sLo thru _sHi of ${mbVar})
                if (class of _sIds) is not list then set _sIds to {_sIds}
                if (class of _sMids) is not list then set _sMids to {_sMids}
                if (count of _sIds) is (count of _sMids) then
                  repeat with _q from 1 to (count of _sIds)
                    set _sOne to ""
                    try
                      set _zSnapMid to ((item _q of _sMids) as string)${this.sanitizeFragment("_zSnapMid", "                      ")}
                      set _sOne to ((item _q of _sIds) as string) & "${SNAP_PAIR}" & _zSnapMid
                    on error
                      set _sOne to ((item _q of _sIds) as string) & "${SNAP_PAIR}"
                    end try
                    set end of _sBuf to _sOne
                  end repeat
                  set _sGot to true
                end if
              end try
              if _sGot then
                repeat with _sB in _sBuf
                  set end of _sPairs to (contents of _sB)
                end repeat
                exit repeat
              end if
            end repeat
            if not _sGot then
              if _sMiss is not "" then set _sMiss to _sMiss & ","
              set _sMiss to _sMiss & (_sLo as string) & "-" & (_sHi as string)
            end if
            set _sLo to _sHi + 1
          end repeat
          -- #179: the loop above is bounded by the count Mail JUST reported,
          -- and that count can lag the mailbox (#155). Positions past the bound
          -- are never requested, so — unlike a slice that failed — they leave
          -- no trace in _sMiss, and the record would claim a complete
          -- observation while every message past the bound looks like it
          -- disappeared. That is a FABRICATED finding with names attached,
          -- which is worse than the gap it papers over.
          --
          -- Probe exactly ONE position past the bound. One, not a slice: an
          -- out-of-range RANGE raises as a whole, so an over-requested slice
          -- could not distinguish "nothing there" from "count was low by more
          -- than a chunk". If a message is there, the count was low and the
          -- unread tail is recorded as a hole, which makes this snapshot
          -- PARTIAL under the existing rules and withholds the halves a
          -- truncation would poison.
          try
            set _sOverId to ((id of message (_sBound + 1) of ${mbVar}) as string)
            -- A specifier that CLAMPS rather than raising hands back the LAST
            -- message instead of failing. That is not evidence of a truncation,
            -- so only an id this enumeration did not already record counts.
            set _sSeen to false
            repeat with _sP in _sPairs
              if (contents of _sP) starts with (_sOverId & "${SNAP_PAIR}") then set _sSeen to true
            end repeat
            if not _sSeen then
              if _sMiss is not "" then set _sMiss to _sMiss & ","
              set _sMiss to _sMiss & ((_sBound + 1) as string) & "-end"
            end if
          end try
          if _sMiss is not "" then
            if (count of _sPairs) is 0 then
              set _sStatus to "unavailable"
            else
              set _sStatus to "partial"
            end if
          end if
          set _sTid to AppleScript's text item delimiters
          set AppleScript's text item delimiters to "${SNAP_ITEM}"
          set _sPayload to _sPairs as string
          set AppleScript's text item delimiters to _sTid
        end if
        set _out to _out & "${SNAP_TAG}${FIELD_SEP}" & ${acctExpr} & "${FIELD_SEP}" & ${mbExpr} & "${FIELD_SEP}${phase}${FIELD_SEP}" & _sStatus & "${FIELD_SEP}" & _sPayload & "${FIELD_SEP}" & _sMiss & "${FIELD_SEP}" & (_sTrue as string) & "${RECORD_SEP}"`;
  }

  /**
   * AppleScript capturing the message the op is ABOUT to touch into `_pre`,
   * appended to that id's outcome record.
   *
   * Empty when the audit log is off — the pre-image is the only per-message cost
   * in this feature, and it must not exist by default. Subjects need the second,
   * separate opt-in; message bodies are never read.
   *
   * Every value here is EXTERNALLY CONTROLLED (the Message-ID and the subject
   * are whatever the sender wrote), so each one is stripped of the stream's
   * structural bytes before it is appended — see `sanitizeFragment`.
   */
  private preImageFragment(msgVar = "_msg"): string {
    if (!isAuditEnabled()) return "";
    const ind = "                ";
    const subject = auditSubjectsEnabled()
      ? `
              if _pre is not "" then
                try
                  set _zSub to ((subject of ${msgVar}) as string)${this.sanitizeFragment("_zSub", ind + "  ")}
                  set _pre to _pre & "${FIELD_SEP}" & _zSub
                end try
              end if`
      : "";
    return `
              try
                set _zMid to ((message id of ${msgVar}) as string)${this.sanitizeFragment("_zMid", ind)}
                set _zDate to ((date received of ${msgVar}) as string)${this.sanitizeFragment("_zDate", ind)}
                set _pre to "${FIELD_SEP}" & _zMid & "${FIELD_SEP}" & _zDate
              end try${subject}`;
  }

  /**
   * Parse the delimited stream a destructive AppleScript returns: per-id
   * outcomes (with their optional pre-image), RECON records and SNAP records.
   *
   * `valid` maps 1-based positions back to the id strings the caller passed —
   * outcomes are reported BY POSITION because a Mail id past 2^29 does not
   * survive `as string` (see runBatchOperation).
   */
  private parseForensicStream(
    output: string,
    valid: { id: string; num: number }[]
  ): {
    byId: Map<string, BatchOperationResult>;
    /** 1-based positions the script reported `ok` for. Unique by construction. */
    okPositions: Set<number>;
    outcomes: AuditOutcome[];
    preImages: Map<number, { messageId: string | null; date: string | null; subject?: string }>;
    recons: {
      account: string;
      mailbox: string;
      before: number;
      after: number;
      pos: number | null;
    }[];
    snaps: {
      account: string;
      mailbox: string;
      phase: "before" | "after";
      status: string;
      payload: string;
      /** 1-based position ranges this phase could not read ("251-500,900-1000"). */
      miss: string;
      /** #187: the mailbox's MEASURED length, present only when it disagreed
       *  with the count Mail reported — i.e. the count read HIGH. */
      measuredLength?: number;
    }[];
  } {
    const byId = new Map<string, BatchOperationResult>();
    const okPositions = new Set<number>();
    const outcomes: AuditOutcome[] = [];
    const preImages = new Map<
      number,
      { messageId: string | null; date: string | null; subject?: string }
    >();
    const recons: {
      account: string;
      mailbox: string;
      before: number;
      after: number;
      pos: number | null;
    }[] = [];
    const snaps: {
      account: string;
      mailbox: string;
      phase: "before" | "after";
      status: string;
      payload: string;
      miss: string;
      measuredLength?: number;
    }[] = [];

    for (const rec of output.split(RECORD_SEP)) {
      if (!rec) continue;
      const f = rec.split(FIELD_SEP);
      if (f.length < 2) continue;

      if (f[0] === RECON_TAG) {
        recons.push({
          account: f[1] ?? "",
          mailbox: f[2] ?? "",
          before: Number(f[3]),
          after: Number(f[4]),
          pos: f[5] ? Number(f[5]) : null,
        });
        continue;
      }
      if (f[0] === SNAP_TAG) {
        // f[7] (#187) is the mailbox's MEASURED length, emitted only when it
        // disagreed with the count; -1 or absent means "not measured". Absent
        // is the normal case for a record written before 2.14.1.
        const measured = f[7] !== undefined && f[7] !== "" ? Number(f[7]) : -1;
        snaps.push({
          account: f[1] ?? "",
          mailbox: f[2] ?? "",
          phase: f[3] === "after" ? "after" : "before",
          status: f[4] ?? "",
          payload: f[5] ?? "",
          miss: f[6] ?? "",
          ...(Number.isFinite(measured) && measured >= 0 ? { measuredLength: measured } : {}),
        });
        continue;
      }

      const pos = Number(f[0]);
      const entry = valid[pos - 1];
      if (!entry) continue;
      // The status may itself contain FIELD_SEP only in the pre-image tail, and
      // a pre-image is only ever appended to an `ok`, so this split is exact.
      const status = f[1];
      const id = entry.id;
      if (status === "ok") {
        byId.set(id, { id, success: true });
        okPositions.add(pos);
        outcomes.push({ id, status: "ok" });
        if (f.length >= 4) {
          preImages.set(pos, {
            messageId: f[2] || null,
            date: f[3] || null,
            ...(f.length >= 5 ? { subject: f[4] } : {}),
          });
        }
      } else if (status === "notfound") {
        byId.set(id, { id, success: false, error: "Message not found" });
        outcomes.push({ id, status: "notfound" });
      } else if (status.startsWith("error:")) {
        const error = f.slice(1).join(FIELD_SEP).slice("error:".length);
        byId.set(id, { id, success: false, error });
        outcomes.push({ id, status: "error", error });
      } else {
        const error = status || "Unknown error";
        byId.set(id, { id, success: false, error });
        outcomes.push({ id, status: "error", error });
      }
    }

    return { byId, okPositions, outcomes, preImages, recons, snaps };
  }

  /**
   * Parse one SNAP payload into (numeric id → RFC Message-ID) entries.
   *
   * The id is CANONICALISED as it is parsed (`canonicalNumericId`), because
   * AppleScript renders a Mail id above 2^29 in scientific notation. That is the
   * only point where the AppleScript representation and the caller's own id
   * strings meet, so normalising here fixes both the `unrequested` membership
   * test and the id the report hands back to a human.
   */
  private parseSnapshot(payload: string): { id: string; messageId: string }[] {
    if (!payload) return [];
    return payload.split(SNAP_ITEM).map((entry) => {
      const i = entry.indexOf(SNAP_PAIR);
      return i < 0
        ? { id: canonicalNumericId(entry), messageId: "" }
        : {
            id: canonicalNumericId(entry.slice(0, i)),
            messageId: entry.slice(i + SNAP_PAIR.length),
          };
    });
  }

  /**
   * Turn the raw RECON/SNAP records into the report the tool layer reports on.
   *
   * `expectedFor(account, mailbox, pos)` says how many messages the operation
   * should have removed from that mailbox — the caller knows this because only
   * the caller knows which ids succeeded and whether a move's destination IS the
   * source mailbox.
   *
   * It returns **null** for "not predictable", and null propagates: the mailbox
   * is classified `unknown` and no comparison is made. That is the only honest
   * answer for a self-move — Mail's behaviour when a message is re-filed into
   * the mailbox it already occupies is unspecified, so any number here would be
   * a guess, and a guess is what turns this instrumentation into a false alarm.
   *
   * `requestedNumericIds` MUST already be canonical (`canonicalNumericId`): it is
   * compared against ids that came back through AppleScript, where a value above
   * 2^29 arrives in scientific notation.
   */
  private buildForensicReport(
    parsed: ReturnType<AppleMailManager["parseForensicStream"]>,
    valid: { id: string; num: number }[],
    expectedFor: (account: string, mailbox: string, pos: number | null) => number | null,
    locationFor: (pos: number) => { account: string; mailbox: string },
    noteFor: (account: string, mailbox: string) => string | undefined,
    requestedNumericIds: Set<string>
  ): DestructiveOpReport {
    // Merge RECON records that describe the same mailbox. The unlocated path
    // emits one per message, and consecutive records are sequential
    // observations of one mailbox: the first record's `before` is the true
    // pre-state and the last record's `after` the true post-state.
    const merged = new Map<
      string,
      { account: string; mailbox: string; before: number; after: number; expected: number | null }
    >();
    for (const r of parsed.recons) {
      const key = groupKey(r.account, r.mailbox);
      const expected = expectedFor(r.account, r.mailbox, r.pos);
      const prev = merged.get(key);
      if (prev) {
        prev.after = r.after;
        // "Not predictable" is absorbing: one unpredictable contribution makes
        // the mailbox's total unpredictable too. Treating null as 0 here would
        // quietly re-manufacture the comparison this is meant to withhold.
        prev.expected =
          prev.expected === null || expected === null ? null : prev.expected + expected;
      } else {
        merged.set(key, {
          account: r.account,
          mailbox: r.mailbox,
          before: r.before,
          after: r.after,
          expected,
        });
      }
    }

    const countDeltas: CountDelta[] = [...merged.values()].map((m) => {
      const readable = m.before >= 0 && m.after >= 0;
      const observed = readable ? m.before - m.after : null;
      const note = noteFor(m.account, m.mailbox);
      let status: CountDelta["status"];
      let unknownReason: CountDelta["unknownReason"];
      // Four disjoint ways there is nothing this server will assert. They are
      // NOT interchangeable to a reader, so each carries its own reason and its
      // own note — see the #155 retraction on CountDelta.
      if (!readable) {
        status = "unknown";
        unknownReason = "count-unreadable";
      } else if (m.expected === null) {
        status = "unknown";
        unknownReason = "no-expectation";
      } else if (observed === m.expected) {
        status = "match";
      } else if ((observed ?? 0) > m.expected) {
        status = "over";
      } else if (observed === 0) {
        // The count did not move at all. On a store that flags deletions
        // instead of removing them this is the ORDINARY reading for an
        // operation that fully succeeded, so it must keep saying so.
        status = "unknown";
        unknownReason = "count-did-not-move";
      } else {
        // It moved, but short. A flag-only store cannot produce this, which is
        // the whole reason it is worth telling apart from the case above.
        status = "unknown";
        unknownReason = "count-partial";
      }
      return {
        account: m.account,
        mailbox: m.mailbox,
        before: readable ? m.before : null,
        after: readable ? m.after : null,
        expected: m.expected,
        observed,
        status,
        ...(unknownReason ? { unknownReason } : {}),
        ...(note ? { note } : {}),
        ...(unknownReason === "count-unreadable"
          ? { note: note ?? "Mail did not report a message count for this mailbox" }
          : {}),
        ...(unknownReason === "count-did-not-move" && !note ? { note: COUNT_UNMOVED_NOTE } : {}),
        ...(unknownReason === "count-partial" && !note ? { note: COUNT_PARTIAL_NOTE } : {}),
      };
    });

    const preImages: AuditPreImage[] = [];
    for (const [pos, pre] of parsed.preImages) {
      const entry = valid[pos - 1];
      if (!entry) continue;
      const loc = locationFor(pos);
      preImages.push({
        id: entry.id,
        account: loc.account,
        mailbox: loc.mailbox,
        messageId: pre.messageId,
        date: pre.date,
        ...(pre.subject !== undefined ? { subject: pre.subject } : {}),
      });
    }

    // Collateral: subtract the after-snapshot from the before-snapshot per
    // mailbox. Keyed on the (numeric id, RFC Message-ID) PAIR — see
    // `snapshotKey`. Both phases read the same source mailbox before and after,
    // so neither half of the key moves under a message that stayed put; the
    // numeric id also correlates the entry with the caller's id list.
    const collateral: CollateralDiff[] = [];
    const byMailbox = new Map<
      string,
      {
        account: string;
        mailbox: string;
        before?: (typeof parsed.snaps)[number];
        after?: (typeof parsed.snaps)[number];
      }
    >();
    for (const s of parsed.snaps) {
      const key = groupKey(s.account, s.mailbox);
      const g = byMailbox.get(key) ?? { account: s.account, mailbox: s.mailbox };
      if (s.phase === "before") g.before = s;
      else g.after = s;
      byMailbox.set(key, g);
    }
    for (const g of byMailbox.values()) {
      const b = g.before;
      const a = g.after;
      if (!b || !a) {
        collateral.push({
          account: g.account,
          mailbox: g.mailbox,
          snapshot: "unavailable",
          skipReason: "only one of the before/after snapshots was produced",
        });
        continue;
      }
      // "skipped"/"unavailable" is terminal for the pair: nothing usable to
      // diff. "partial" is NOT — it carries real entries plus a named gap.
      const dead = (s: (typeof parsed.snaps)[number]): boolean =>
        s.status !== "ok" && s.status !== "partial";
      if (dead(b) || dead(a)) {
        const bad = dead(b) ? b : a;
        collateral.push({
          account: g.account,
          mailbox: g.mailbox,
          snapshot: bad.status === "skipped" ? "skipped" : "unavailable",
          skipReason:
            bad.payload ||
            `Mail would not produce the ${bad === b ? "before" : "after"} snapshot for this mailbox`,
        });
        continue;
      }
      const beforeEntries = this.parseSnapshot(b.payload);
      const afterEntries = this.parseSnapshot(a.payload);
      const afterKeys = new Set(afterEntries.map((e) => snapshotKey(e)));
      const beforeKeys = new Set(beforeEntries.map((e) => snapshotKey(e)));
      const disappeared = beforeEntries.filter((e) => !afterKeys.has(snapshotKey(e)));
      const appeared = afterEntries.filter((e) => !beforeKeys.has(snapshotKey(e)));
      // Both sides are canonical numeric ids: the caller's, canonicalised by the
      // callers of this method, and the snapshot's, canonicalised in
      // parseSnapshot. Comparing an AppleScript "9.99999999E+8" against a
      // TypeScript "999999999" would name a REQUESTED message as collateral.
      const unrequested = disappeared.filter(
        (e) => !requestedNumericIds.has(canonicalNumericId(e.id))
      );
      // Each half of the diff is gated on the completeness of the snapshot that
      // could REFUTE it, not on both (#176). A hole in `after` means a message
      // absent from it may merely be unread, so `disappeared` would name
      // innocent messages as collateral — the fabricated finding this layer must
      // never produce. A hole in `before` only undercounts it, and symmetrically
      // poisons `appeared`.
      // #187: when Mail's count read HIGH, the snapshot measured the mailbox's
      // true length instead of letting the over-request collapse it. Surface that
      // measurement — it is DIRECT evidence of the count staleness #155 is about,
      // and discarding it would repeat the mistake of measuring and saying nothing.
      const countStale = [b, a]
        .filter((s) => s.measuredLength !== undefined)
        .map((s) => ({ phase: s.phase, measuredLength: s.measuredLength as number }));
      const holes = [b, a]
        .filter((s) => s.miss !== "")
        .map((s) => ({ phase: s.phase, ranges: s.miss }));
      if (holes.length === 0) {
        collateral.push({
          account: g.account,
          mailbox: g.mailbox,
          snapshot: "ok",
          disappeared,
          unrequested,
          appeared,
          ...(countStale.length ? { countStale } : {}),
        });
        continue;
      }
      const derivable = [
        a.miss === "" ? `what left the ${beforeEntries.length} message(s) read before it` : null,
        b.miss === "" ? "what arrived during it" : null,
      ].filter((s): s is string => s !== null);
      collateral.push({
        account: g.account,
        mailbox: g.mailbox,
        snapshot: "partial",
        ...(countStale.length ? { countStale } : {}),
        skipReason:
          `Mail would not read ${holes.map((h) => `${h.ranges} (${h.phase})`).join(", ")} of ` +
          `this mailbox, so the snapshot has a hole in it. ` +
          (derivable.length > 0
            ? `Still derivable and reported: ${derivable.join(" and ")}. `
            : `Neither half of the diff is derivable from it. `) +
          `Anything the unread range could refute is omitted rather than guessed — an absent ` +
          `field here means "not computable", not "empty".`,
        unobserved: holes,
        ...(a.miss === "" ? { disappeared, unrequested } : {}),
        ...(b.miss === "" ? { appeared } : {}),
      });
    }

    return { countDeltas, preImages, outcomes: parsed.outcomes, collateral };
  }

  /**
   * Returns cached accounts or fetches fresh data if cache is expired/empty.
   */
  private getCachedAccounts(options: { timeoutMs?: number } = {}): Account[] {
    const now = Date.now();
    if (this.cache.accounts && now < this.cache.accounts.expiry) {
      return this.cache.accounts.data;
    }
    const accounts = this.fetchAccounts(options);
    if (accounts === null) {
      // Transport failure. Do NOT cache it — caching an empty list here poisoned
      // every subsequent call for the whole TTL, so one timeout made Mail look
      // account-less long after it recovered. Serve the last known-good list if
      // we have one; the error stays readable via consumeAccountsError(). (#130)
      return this.cache.accounts?.data ?? [];
    }
    this.lastAccountsError = null;
    this.cache.accounts = { data: accounts, expiry: now + this.CACHE_TTL_MS };
    return accounts;
  }

  /**
   * Returns cached mailbox names for an account, or fetches fresh.
   * This caches only the name list used by resolveMailbox(), not the
   * full Mailbox objects with counts (which change frequently).
   */
  private getCachedMailboxNames(account: string): string[] {
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
  private invalidateCache(): void {
    this.cache.accounts = null;
    this.cache.mailboxNames.clear();
  }

  /**
   * Reads the live `enabled` flag for an account directly from Mail (bypassing
   * the 60 s account cache) so a guard reflects an account that was enabled or
   * disabled out-of-band. Returns true/false when known, or null when the probe
   * is inconclusive — account not found, or the probe itself failed. Callers
   * treat null as "can't tell, don't block".
   */
  private isAccountEnabled(account: string): boolean | null {
    const safeAccount = escapeForAppleScript(account);
    const result = executeAppleScript(
      buildAppLevelScript(`
        try
          return (enabled of account "${safeAccount}") as text
        on error
          return "missing"
        end try
      `)
    );
    if (!result.success) return null;
    const out = result.output.trim();
    if (out === "true") return true;
    if (out === "false") return false;
    return null;
  }

  /**
   * Reads an account's `account type` from Mail (e.g. "imap", "iCloud", "pop",
   * ".Mac", or "unknown" for Exchange). Returns the lowercased type string, or
   * null when the probe is inconclusive (account not found / probe failed).
   * Used to decide whether AppleScript can safely create/delete/rename a
   * mailbox on the account (BUG B).
   */
  private accountTypeOf(account: string): string | null {
    const safeAccount = escapeForAppleScript(account);
    const result = executeAppleScript(
      buildAppLevelScript(`
        try
          return (account type of account "${safeAccount}") as text
        on error
          return "missing"
        end try
      `)
    );
    if (!result.success) return null;
    const out = result.output.trim().toLowerCase();
    if (!out || out === "missing") return null;
    return out;
  }

  /**
   * True when the account stores its mailboxes server-side (IMAP / iCloud /
   * Exchange), so AppleScript CANNOT reliably create, delete, or rename its
   * folders — those ops must go through the IMAP backend. POP accounts keep
   * everything local, so their mailboxes ARE AppleScript-writable.
   *
   * Returns null when the type can't be determined (fail open: an inconclusive
   * probe should not block an operation).
   */
  private isServerSideAccount(account: string): boolean | null {
    const type = this.accountTypeOf(account);
    if (type === null) return null;
    if (type === "pop") return false;
    // imap, icloud (".mac"), exchange (reported as "unknown"), and anything else
    // that isn't a plain local POP store is treated as server-side.
    return true;
  }

  /**
   * Guard for AppleScript create-mailbox on a server-side account (BUG B). When
   * the account stores mailboxes server-side, AppleScript can CREATE a folder
   * but cannot later delete or rename it — so a bare create would orphan a
   * mailbox the server can never remove. If IMAP is configured for the account
   * the tool layer routes the op to IMAP before reaching here; if it isn't, we
   * refuse rather than create something we can't remove. Returns an error string
   * when the op must be refused, else null (POP / local / indeterminate accounts
   * fall through to AppleScript).
   */
  private serverSideCreateGuard(account: string, op: "create" | "rename"): string | null {
    if (this.isServerSideAccount(account) === true) {
      const verb = op === "rename" ? "rename" : "create";
      return `Account "${account}" stores its mailboxes on the server (IMAP / iCloud / Exchange), and Mail.app cannot ${verb} server-side mailboxes via AppleScript — a ${verb} would ${op === "rename" ? "leave a half-created orphan" : "orphan a mailbox that can never be removed"}. Configure IMAP for this account (APPLE_MAIL_MCP_IMAP_*) so mailbox create/delete/rename route through the server, or manage the folder in Mail.app directly. ${SETUP_HINT}`;
    }
    return null;
  }

  /**
   * Guard for AppleScript-backed structural operations (create / delete / rename
   * mailbox). When the target account is disabled in Mail, Mail holds no live
   * server session for it, so the operation fails inside Mail with an opaque
   * AppleEvent -10000 — and a multi-step op like rename can leave half-built
   * state behind (an orphaned destination mailbox). Detect the disabled account
   * up front and refuse with an actionable message instead of attempting the
   * doomed op.
   *
   * Returns an error string when the account is known-disabled, else null —
   * including when the state can't be determined. We fail open: an inconclusive
   * probe never blocks an otherwise-valid operation.
   *
   * Applies only to the AppleScript backend. Direct-IMAP accounts talk to the
   * server independent of Mail's enabled toggle and are routed before reaching
   * the manager.
   */
  private disabledAccountGuard(account: string): string | null {
    if (this.isAccountEnabled(account) === false) {
      return `Account "${account}" is disabled in Mail, so Mail has no live connection to it — this operation would fail server-side (AppleEvent -10000) and could leave a mailbox half-changed. Enable the account (Mail ▸ Settings ▸ Accounts ▸ "Enable this account") and retry, or target an enabled account.`;
    }
    return null;
  }

  /**
   * Best-effort rollback for a failed rename: delete a just-created destination
   * mailbox, but ONLY if it is empty, so any messages that did move are never
   * destroyed. Returns true if the empty orphan was removed.
   */
  private deleteMailboxIfEmpty(name: string, account: string): boolean {
    const safeName = escapeForAppleScript(name);
    const safeAccount = escapeForAppleScript(account);
    const result = executeAppleScript(
      buildAppLevelScript(`
        try
          set mb to mailbox "${safeName}" of account "${safeAccount}"
          if (count of messages of mb) is 0 then
            delete mb
            return "deleted"
          else
            return "kept"
          end if
        on error errMsg
          return "error:" & errMsg
        end try
      `)
    );
    return result.success && result.output.trim() === "deleted";
  }

  /**
   * Resolves the account to use for an operation when the caller omits one.
   *
   * Order (see chooseDefaultAccount): the APPLE_MAIL_MCP_DEFAULT_ACCOUNT env
   * override → Mail.app's configured default-send account (if enabled) → the
   * first enabled account. A disabled account is never chosen implicitly (#47).
   */
  private resolveAccount(account?: string): string {
    if (account) return account;
    if (this.defaultAccount) return this.defaultAccount;

    const accounts = this.getCachedAccounts();

    // Mail.app's default send account (inspect a throwaway outgoing message).
    let defaultSendEmail: string | undefined;
    const defaultResult = executeAppleScript(
      buildAppLevelScript(`
        set newMsg to make new outgoing message
        set fromAddr to sender of newMsg
        delete newMsg
        return fromAddr
      `)
    );
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
  private resolveMailbox(mailbox: string, account: string): string {
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
  searchMessages(
    query?: string,
    mailbox?: string,
    account?: string,
    limit = 50,
    dateFrom?: string,
    dateTo?: string,
    from?: string,
    subject?: string,
    isRead?: boolean,
    isFlagged?: boolean
  ): Message[] {
    return this.searchMessagesWithDiagnostics(
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
    ).messages;
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
  searchMessagesWithDiagnostics(
    query?: string,
    mailbox?: string,
    account?: string,
    limit = 50,
    dateFrom?: string,
    dateTo?: string,
    from?: string,
    subject?: string,
    isRead?: boolean,
    isFlagged?: boolean
  ): SearchResult {
    // If no account specified, search across all accounts and merge diagnostics.
    if (!account) {
      const accounts = this.listAccounts();
      const allMessages: Message[] = [];
      const diagnostics: SearchDiagnostics = {
        partial: false,
        timedOutAccounts: [],
        skippedLargeMailboxes: [],
        notSearchedMailboxes: [],
      };
      for (const acct of accounts) {
        if (allMessages.length >= limit) break;
        const remaining = limit - allMessages.length;
        const res = this.searchMessagesWithDiagnostics(
          query,
          mailbox,
          acct.name,
          remaining,
          dateFrom,
          dateTo,
          from,
          subject,
          isRead,
          isFlagged
        );
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
      const dateChecks: string[] = [];
      if (dateFrom) {
        dateSetup += buildAppleScriptDate("_dateFrom", new Date(dateFrom)) + "\n      ";
        dateChecks.push("msgDate >= _dateFrom");
      }
      if (dateTo) {
        const to = new Date(dateTo);
        // A date-only upper bound (no time component) is treated as end-of-day so
        // messages received later that same day are still included.
        if (!/\d:\d/.test(dateTo)) to.setHours(23, 59, 59, 0);
        dateSetup += buildAppleScriptDate("_dateTo", to) + "\n      ";
        dateChecks.push("msgDate <= _dateTo");
      }
      dateFilter = dateChecks.join(" and ");
    }

    const scanThreshold = getMailboxScanThreshold();

    let searchCommand: string;

    if (mailbox) {
      // Search a specific mailbox. The caller explicitly chose this mailbox, so
      // we don't apply the count-guard skip — but we still wrap the scan so a
      // timeout is reported as a partial result rather than a false empty.
      const targetMailbox = this.resolveMailbox(mailbox, targetAccount);

      // Gmail virtual-INBOX (BUG A1): a Gmail-style account's literal "INBOX"
      // mailbox is an empty shell — the mail actually received lives under the
      // "All Mail"/"Important" special mailboxes. When the caller scopes to the
      // inbox on such an account, scan that receiving set (matched by `name of
      // mb`, since the flat names don't resolve via `mailbox "All Mail"`) and
      // dedup, so scoped search/get-thread find the same messages the unscoped
      // call reports as inbox mail.
      const gmailInbox = isInboxScope(mailbox)
        ? gmailReceivingMailboxes(this.getCachedMailboxNames(targetAccount))
        : null;

      if (gmailInbox) {
        const nameList = appleScriptLowerNameList(gmailInbox);
        searchCommand = `
      ${dateSetup}set outputText to ""
      set _timedOut to false
      set _notSearched to ""
      set _wantNames to ${nameList}
      set msgCount to 0
      set seenIds to {}
      repeat with mb in mailboxes
        if msgCount >= ${limit} then exit repeat
        set mbName to ""
        try
          set mbName to name of mb
        end try
        ignoring case
          if _wantNames contains mbName then
            try
              ${buildMessageRowLoop({ collection: `messages of mb ${searchCondition}`, limit, dedup: true, dateFilter })}
            on error _errMsg number _errNum
              set _timedOut to true
              set _notSearched to _notSearched & mbName & "${DIAG_ITEM_SEP}"
            end try
          end if
        end ignoring
      end repeat
      return outputText & "${DIAG_MARKER}timedOut=" & (_timedOut as string) & "${DIAG_FIELD_SEP}skipped=${DIAG_FIELD_SEP}notSearched=" & _notSearched
    `;
      } else {
        searchCommand = `
      ${dateSetup}set outputText to ""
      set _timedOut to false
      set _notSearched to ""
      set theMailbox to mailbox "${escapeForAppleScript(targetMailbox)}"
      set msgCount to 0
      try
        ${buildMessageRowLoop({ collection: `messages of theMailbox ${searchCondition}`, limit, dateFilter })}
      on error _errMsg number _errNum
        set _timedOut to true
        set _notSearched to "${escapeForAppleScript(targetMailbox)}${DIAG_ITEM_SEP}"
      end try
      return outputText & "${DIAG_MARKER}timedOut=" & (_timedOut as string) & "${DIAG_FIELD_SEP}skipped=${DIAG_FIELD_SEP}notSearched=" & _notSearched
    `;
      }
    } else {
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
              ${buildMessageRowLoop({ collection: `messages of mb ${searchCondition}`, limit, dedup: true, dateFilter, trailing: ` & "${FIELD_SEP}" & mbName` })}
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
  private parseSearchResult(output: string, mailbox: string, account: string): SearchResult {
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
  getMessageById(id: string, deepAttachmentCheck = false): Message | null {
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
    if (parts.length < 9) return null;

    // Record id→location so a subsequent content/source fetch skips the scan.
    this.rememberLocation(id.toString(), parts[8], parts[7]);

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
   * Build an app-level AppleScript that opens exactly one account+mailbox, finds
   * the message with numeric `id` in it, and runs `innerAction` (which may assume
   * `msg` is bound). Used by the by-id fast paths (getMessageContent/getRawSource)
   * so a message in a late-iterated large folder resolves directly instead of via
   * the timeout-prone full-mailbox scan.
   *
   * The mailbox name is resolved through `resolveMailbox` (so an alias like
   * "Sent"→"Sent Items" or a casing mismatch like "INBOX"→"Inbox" still opens the
   * right folder), and matched case-insensitively by iterating the account's
   * mailboxes — `mailbox "INBOX" of account …` throws on accounts whose inbox is
   * actually named "Inbox", which would silently drop us back to the slow scan.
   * Returns "" (found nothing) on any error, so the caller falls back safely.
   */
  private scopedByIdScript(
    account: string,
    mailbox: string,
    id: string,
    innerAction: string
  ): string {
    const resolved = this.resolveMailbox(mailbox, account);
    return buildAppLevelScript(`
      try
        set acct to (first account whose name is "${escapeForAppleScript(account)}")
        set targetMb to missing value
        ignoring case
          repeat with mb in mailboxes of acct
            if (name of mb) is "${escapeForAppleScript(resolved)}" then
              set targetMb to mb
              exit repeat
            end if
          end repeat
        end ignoring
        if targetMb is not missing value then
          set matchingMsgs to (messages of targetMb whose id is ${Number(id)})
          if (count of matchingMsgs) > 0 then
            set msg to item 1 of matchingMsgs
            ${innerAction}
          end if
        end if
        return ""
      on error errMsg
        return ""
      end try
    `);
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
  getMessageContent(
    id: string,
    includeHtml = false,
    hint?: { account?: string; mailbox?: string }
  ): MessageContent | null {
    this.lastMessageLookupError = undefined;
    // Only `source of msg` is fetched when HTML is requested. `content of msg`
    // is the plain-text body and is always cheap.
    const sourceFetch = includeHtml
      ? `set htmlSource to ""\n                try\n                  set htmlSource to source of msg\n                end try`
      : `set htmlSource to ""`;

    // Shared per-message read: subject, RFC Message-ID (`message id`; empty when
    // the message carries none), plain-text content and — only when requested —
    // the raw source. `msg` must already be bound.
    const innerFetch = `
                set msgSubject to subject of msg
                set msgRfcId to ""
                try
                  set msgRfcId to message id of msg
                end try
                set msgContent to content of msg
                ${sourceFetch}
                return msgSubject & "${MSGID_MARKER}" & msgRfcId & "${CONTENT_MARKER}" & msgContent & "${HTML_MARKER}" & htmlSource`;

    // Fast path: when we know which account+mailbox holds this id (explicit hint
    // from the caller, or remembered from a prior search/list/by-id lookup), open
    // just that one mailbox. The unscoped scan below walks every mailbox of every
    // account (700+ on a real multi-account setup) and, for a message in a
    // late-iterated folder like a large "Sent Items", never reaches it before the
    // AppleScript timeout — returning a false "not found". See idLocationIndex.
    const loc =
      hint?.account && hint?.mailbox
        ? { account: hint.account, mailbox: hint.mailbox }
        : this.idLocationIndex.get(id.toString());

    if (loc) {
      const scopedScript = this.scopedByIdScript(loc.account, loc.mailbox, id, innerFetch);
      const scoped = this.parseMessageContent(
        id,
        executeAppleScript(scopedScript, { timeoutMs: 60000 }),
        includeHtml
      );
      if (scoped) return scoped;
      // Scoped lookup missed (stale index — e.g. the message was moved). Fall
      // through to the full scan below rather than returning a false "not found".
    }

    const script = buildAppLevelScript(`
      try
        set _hits to {}
        set _names to ""
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${Number(id)})
              if (count of matchingMsgs) > 0 then
                set end of _hits to item 1 of matchingMsgs
                set _names to _names & (name of acct) & "/" & (name of mb) & ", "
              end if
            end try
          end repeat
        end repeat
        if (count of _hits) is 0 then return "${LOOKUP_ERROR_MARKER}Message not found"
        if (count of _hits) > 1 then return "${LOOKUP_ERROR_MARKER}${AMBIGUOUS_ID_PREFIX}${Number(id)} is present in more than one mailbox (" & _names & "); list or search that mailbox first so the read targets the right copy"
        if (count of _hits) is 1 then
          set msg to item 1 of _hits
          ${innerFetch}
        end if
        return ""
      on error errMsg
        return ""
      end try
    `);

    return this.parseMessageContent(
      id,
      executeAppleScript(script, { timeoutMs: 60000 }),
      includeHtml
    );
  }

  /**
   * Parse the marker-delimited output of a getMessageContent AppleScript into a
   * MessageContent, or null when nothing was found / the fetch failed. Shared by
   * the scoped fast path and the full-mailbox-scan fallback.
   */
  private parseMessageContent(
    id: string,
    result: AppleScriptResult,
    includeHtml: boolean
  ): MessageContent | null {
    if (!result.success || !result.output.trim()) {
      if (!result.success) console.error(`Failed to get message content: ${result.error}`);
      return null;
    }

    if (result.output.startsWith(LOOKUP_ERROR_MARKER)) {
      this.lastMessageLookupError = result.output.slice(LOOKUP_ERROR_MARKER.length).trim();
      return null;
    }

    const htmlSplit = result.output.split(HTML_MARKER);
    const contentPart = htmlSplit[0];
    const rawSource = htmlSplit.length > 1 ? htmlSplit[1] : "";

    const parts = contentPart.split(CONTENT_MARKER);
    if (parts.length < 2) return null;

    // parts[0] is `subject{MSGID_MARKER}rfcMessageId` — split the RFC Message-ID
    // (added for stable, session-independent dedup) back out of the subject.
    const subjParts = parts[0].split(MSGID_MARKER);
    const subject = subjParts[0];
    const rfcMessageId = normalizeRfcMessageId(subjParts.length > 1 ? subjParts[1] : "");

    // Extract the actual text/html body from the raw MIME source rather than
    // returning the whole source. Falls back to undefined when the message has
    // no HTML part (e.g. a plain-text-only email).
    const htmlContent =
      includeHtml && rawSource ? extractHtmlBody(rawSource) || undefined : undefined;

    return {
      id: id.toString(),
      subject,
      plainText: parts[1],
      htmlContent,
      rfcMessageId,
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
  getRawSource(id: string, hint?: { account?: string; mailbox?: string }): string | null {
    this.lastMessageLookupError = undefined;
    // Fast path: fetch from the known mailbox directly (same rationale as
    // getMessageContent — the unscoped scan below times out for a message in a
    // late-iterated large folder like "Sent Items"). See idLocationIndex.
    const loc =
      hint?.account && hint?.mailbox
        ? { account: hint.account, mailbox: hint.mailbox }
        : this.idLocationIndex.get(id.toString());

    if (loc) {
      const scopedScript = this.scopedByIdScript(
        loc.account,
        loc.mailbox,
        id,
        "return source of msg"
      );
      const scoped = executeAppleScript(scopedScript, { timeoutMs: 120000 });
      if (
        scoped.success &&
        scoped.output.trim() &&
        !scoped.output.startsWith(LOOKUP_ERROR_MARKER)
      ) {
        return scoped.output;
      }
      if (scoped.success && scoped.output.startsWith(LOOKUP_ERROR_MARKER)) {
        this.lastMessageLookupError = scoped.output.slice(LOOKUP_ERROR_MARKER.length).trim();
      }
      // Miss (stale index) → fall through to the full scan.
    }

    const script = buildAppLevelScript(`
      try
        set _hits to {}
        set _names to ""
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${Number(id)})
              if (count of matchingMsgs) > 0 then
                set end of _hits to item 1 of matchingMsgs
                set _names to _names & (name of acct) & "/" & (name of mb) & ", "
              end if
            end try
          end repeat
        end repeat
        if (count of _hits) is 0 then return "${LOOKUP_ERROR_MARKER}Message not found"
        if (count of _hits) > 1 then return "${LOOKUP_ERROR_MARKER}${AMBIGUOUS_ID_PREFIX}${Number(id)} is present in more than one mailbox (" & _names & "); list or search that mailbox first so the read targets the right copy"
        if (count of _hits) is 1 then
          set msg to item 1 of _hits
          return source of msg
        end if
        return ""
      on error errMsg
        return ""
      end try
    `);

    const result = executeAppleScript(script, { timeoutMs: 120000 });

    if (!result.success || !result.output.trim()) {
      return null;
    }
    if (result.output.startsWith(LOOKUP_ERROR_MARKER)) {
      this.lastMessageLookupError = result.output.slice(LOOKUP_ERROR_MARKER.length).trim();
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
  listMessages(
    mailbox?: string,
    account?: string,
    limit = 50,
    from?: string,
    offset = 0
  ): Message[] {
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
  listMessagesWithDiagnostics(
    mailbox?: string,
    account?: string,
    limit = 50,
    from?: string,
    offset = 0
  ): SearchResult {
    // If no account specified, list across all accounts and merge diagnostics.
    if (!account) {
      const accounts = this.listAccounts();
      const allMessages: Message[] = [];
      const diagnostics: SearchDiagnostics = {
        partial: false,
        timedOutAccounts: [],
        skippedLargeMailboxes: [],
        notSearchedMailboxes: [],
      };
      for (const acct of accounts) {
        if (allMessages.length >= limit) break;
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

    let listCommand: string;

    if (mailbox) {
      // List from a specific mailbox. Caller-scoped, so no count-guard skip, but
      // wrap the scan so a timeout is reported as partial, not a false empty.
      const targetMailbox = this.resolveMailbox(mailbox, targetAccount);

      // Gmail virtual-INBOX (BUG A1, ported from searchMessagesWithDiagnostics):
      // a Gmail-style account's literal "INBOX" mailbox is an empty shell — mail
      // actually received lives under the "All Mail"/"Important" special
      // mailboxes. Without this, list-messages (unlike search-messages) silently
      // returns a small, shifting subset of the account's real inbox contents.
      // See BUG A / issue: Gmail virtual-INBOX handling.
      const gmailInbox = isInboxScope(mailbox)
        ? gmailReceivingMailboxes(this.getCachedMailboxNames(targetAccount))
        : null;

      if (gmailInbox) {
        const nameList = appleScriptLowerNameList(gmailInbox);
        listCommand = `
      set outputText to ""
      set _timedOut to false
      set _notSearched to ""
      set _wantNames to ${nameList}
      set msgCount to 0
      set skipped to 0
      set seenIds to {}
      repeat with mb in mailboxes
        if msgCount >= ${limit} then exit repeat
        set mbName to ""
        try
          set mbName to name of mb
        end try
        ignoring case
          if _wantNames contains mbName then
            try
              ${buildMessageRowLoop({ collection: `messages of mb ${fromFilter}`, limit, offset, dedup: true, withAttachments: true, trailing: ` & "${FIELD_SEP}" & mbName` })}
            on error _errMsg number _errNum
              set _timedOut to true
              set _notSearched to _notSearched & mbName & "${DIAG_ITEM_SEP}"
            end try
          end if
        end ignoring
      end repeat
      return outputText & "${DIAG_MARKER}timedOut=" & (_timedOut as string) & "${DIAG_FIELD_SEP}skipped=${DIAG_FIELD_SEP}notSearched=" & _notSearched
    `;
      } else {
        listCommand = `
      set outputText to ""
      set _timedOut to false
      set _notSearched to ""
      set theMailbox to mailbox "${escapeForAppleScript(targetMailbox)}"
      set msgCount to 0
      set skipped to 0
      try
        ${buildMessageRowLoop({ collection: `messages of theMailbox ${fromFilter}`, limit, offset, withAttachments: true })}
      on error _errMsg number _errNum
        set _timedOut to true
        set _notSearched to "${escapeForAppleScript(targetMailbox)}${DIAG_ITEM_SEP}"
      end try
      return outputText & "${DIAG_MARKER}timedOut=" & (_timedOut as string) & "${DIAG_FIELD_SEP}skipped=${DIAG_FIELD_SEP}notSearched=" & _notSearched
    `;
      }
    } else {
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
              ${buildMessageRowLoop({ collection: `messages of mb ${fromFilter}`, limit, dedup: true, offset, withAttachments: true, trailing: ` & "${FIELD_SEP}" & mbName` })}
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
  private parseMessageList(output: string, mailbox: string, account: string): Message[] {
    const items = output.split(RECORD_SEP);
    const messages: Message[] = [];

    for (const item of items) {
      const parts = item.split(FIELD_SEP);
      if (parts.length < 6) continue;

      let msgMailbox = mailbox;
      let hasAttachments = false;
      if (parts.length >= 8) {
        msgMailbox = parts[6];
        hasAttachments = parts[7] === "true";
      } else if (parts.length === 7) {
        hasAttachments = parts[6] === "true";
      }

      const msgId = parts[0].trim();
      messages.push({
        id: msgId,
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
      // Remember where this id lives so a later by-id fetch can open the one
      // right mailbox instead of scanning every mailbox (avoids the Sent-Items
      // timeout, see idLocationIndex).
      this.rememberLocation(msgId, account, msgMailbox);
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
  sendEmail(
    to: string[],
    subject: string,
    body: string,
    cc?: string[],
    bcc?: string[],
    account?: string,
    attachments?: AttachmentInput[]
  ): boolean {
    const safeSubject = escapeForAppleScript(subject);
    const safeBody = escapeForAppleScriptBody(body);

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

    // Inline (base64) attachments are written to temp files first (B4), then
    // cleaned up after the send. Plain paths are canonicalized and checked
    // against the attachment read policy first.
    const mat = materializeAttachments(attachments);
    try {
      return this.sendEmailWithPaths(
        recipientCommands,
        safeSubject,
        safeBody,
        account,
        buildAttachmentCommands(mat.paths)
      );
    } finally {
      mat.cleanup();
    }
  }

  private sendEmailWithPaths(
    recipientCommands: string,
    safeSubject: string,
    safeBody: string,
    account: string | undefined,
    attachmentCommands: string
  ): boolean {
    let sendCommand: string;
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
    } else {
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
  sendSerialEmail(
    recipients: SerialEmailRecipient[],
    subject: string,
    body: string,
    account?: string,
    delayMs: number = 500
  ): SerialEmailResult[] {
    const effectiveDelay = Math.min(Math.max(delayMs, 0), 10000);
    const results: SerialEmailResult[] = [];

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

        const success = this.sendEmail(
          [recipient.email],
          personalizedSubject,
          personalizedBody,
          undefined,
          undefined,
          account
        );

        results.push({
          email: recipient.email,
          success,
          error: success ? undefined : "Failed to send email",
        });
      } catch (error) {
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
  createDraft(
    to: string[],
    subject: string,
    body: string,
    cc?: string[],
    bcc?: string[],
    account?: string,
    attachments?: AttachmentInput[]
  ): boolean {
    const safeSubject = escapeForAppleScript(subject);
    const safeBody = escapeForAppleScriptBody(body);

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

    // Inline (base64) attachments → temp files (B4); cleaned up after.
    const mat = materializeAttachments(attachments);
    const attachmentCommands = buildAttachmentCommands(mat.paths);
    try {
      return this.createDraftWithCommands(
        recipientCommands,
        safeSubject,
        safeBody,
        account,
        attachmentCommands
      );
    } finally {
      mat.cleanup();
    }
  }

  private createDraftWithCommands(
    recipientCommands: string,
    safeSubject: string,
    safeBody: string,
    account: string | undefined,
    attachmentCommands: string
  ): boolean {
    let draftCommand: string;
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
    } else {
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
  replyToMessage(
    id: string,
    body: string,
    replyAll = false,
    send = true
  ): { success: boolean; error?: string } {
    const safeBody = escapeForAppleScriptBody(body);
    const replyAllClause = replyAll ? " with reply to all" : "";
    // `save` is NOT optional on the draft path. Without it the script creates
    // the outgoing message, sets its content and abandons it, leaving Mail.app
    // holding an unsaved compose window — pre-addressed, pre-filled, one click
    // from sending — while this method reports success. `send: false` is the
    // REVIEW-FIRST option, so leaving a live compose window is the one outcome
    // it must never produce.
    const finalAction = send ? "send theReply" : "save theReply";

    const script = this.findMessageScript(
      id,
      `
          set theReply to reply msg without opening window${replyAllClause}
          set content of theReply to "${safeBody}"
          ${finalAction}`
    );

    return this.runComposeScript(script, "reply to");
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
  forwardMessage(
    id: string,
    to: string[],
    body?: string,
    send = true
  ): { success: boolean; error?: string } {
    const safeBody = body ? escapeForAppleScriptBody(body) : "";
    // See replyToMessage: the draft path MUST save, or Mail is left with a live
    // compose window while this reports success.
    const finalAction = send ? "send theForward" : "save theForward";

    // Build recipient additions
    let recipientCommands = "";
    for (const addr of to) {
      recipientCommands += `make new to recipient at end of to recipients of theForward with properties {address:"${escapeForAppleScript(addr)}"}\n`;
    }

    const script = this.findMessageScript(
      id,
      `
          set theForward to forward msg without opening window
          ${recipientCommands}
          ${safeBody ? `set content of theForward to "${safeBody}"` : ""}
          ${finalAction}`
    );

    return this.runComposeScript(script, "forward");
  }

  /**
   * Helper to find and operate on a message by ID, scoped to the mailbox the id
   * was listed from.
   *
   * Mail.app numeric ids are per-mailbox, and on a label store (Gmail, iCloud)
   * ONE message is present in several mailboxes under the SAME id — INBOX,
   * "Important" and "All Mail" all report id 75816 for the same mail. This used
   * to walk every account's every mailbox and mutate the FIRST hit, so whichever
   * copy `mailboxes of <account>` happened to reach first won and the mailbox the
   * id was listed from lost whenever an alias came earlier in that (store-
   * dependent) order — the op reported success while the copy the caller meant
   * stayed put and a different one was moved/deleted (#152). See
   * runBatchOperation for the observed ordering on the reporting account.
   *
   * Which mailbox a mutation lands in is semantic — deleting the INBOX copy and
   * deleting the "All Mail" copy are different operations — so scope to the
   * mailbox the id actually came from (`idLocationIndex`, populated by every
   * list/search) and never guess.
   *
   * Every single-message mutation in this class builds its script here and runs
   * it immediately, so this is also where the previous operation's forensic
   * report is invalidated — see `beginMutation()`.
   */
  /**
   * Run a reply/forward compose script and surface Mail's OWN error text.
   *
   * These used to return a bare boolean and log the reason to stderr, so the
   * tool layer could only say "Failed to reply to message X". That hid the two
   * failures a caller can actually act on — an id present in several mailboxes
   * (which names the candidates and tells you to re-list) and a missing id —
   * behind one indistinguishable message.
   */
  private runComposeScript(script: string, verb: string): { success: boolean; error?: string } {
    const result = executeAppleScript(script, { timeoutMs: 60000 });
    if (!result.success || result.output.startsWith("error:")) {
      const raw = result.error || result.output;
      const error = raw.startsWith("error:") ? raw.slice("error:".length) : raw;
      console.error(`Failed to ${verb} message: ${error}`);
      return { success: false, error };
    }
    return { success: true };
  }

  private findMessageScript(id: string, operation: string, instrument = false): string {
    this.beginMutation();
    const loc = this.locationFor(id);
    if (loc) {
      // Emitter-only literals: stripped of the stream's structural bytes so a
      // mailbox or account name containing one cannot shift the record it is
      // written into. The mailbox is still RESOLVED by its real name above.
      const acctLit = `"${escapeForAppleScript(stripStreamDelimiters(loc.account))}"`;
      const mbLit = `"${escapeForAppleScript(stripStreamDelimiters(loc.mailbox))}"`;
      return buildAppLevelScript(`
      try
        ${this.resolveMailboxFragment(loc.account, loc.mailbox)}
        if _tmb is missing value then return "error:Message not found"
        set matchingMsgs to (messages of _tmb whose id is ${Number(id)})
        if (count of matchingMsgs) > 0 then
          set msg to item 1 of matchingMsgs${
            instrument
              ? `
          set _out to ""
          set _pre to ""${this.countFragment("_cb")}${this.snapshotFragment("before", acctLit, mbLit, "_cb")}${this.preImageFragment("msg")}
          ${operation}${this.countFragment("_ca")}${this.snapshotFragment("after", acctLit, mbLit, "_ca")}${this.reconEmit(acctLit, mbLit, "_cb", "_ca")}
          return "1${FIELD_SEP}ok" & _pre & "${RECORD_SEP}" & _out`
              : `
          ${operation}
          return "ok"`
          }
        end if
        return "error:Message not found"
      on error errMsg
        return "error:" & errMsg
      end try
    `);
    }

    // No recorded location (id supplied out-of-band, or evicted from the
    // index). Collect EVERY mailbox holding this id and act only when it is
    // unambiguous — refusing beats mutating an arbitrary copy.
    return buildAppLevelScript(`
      try
        set _hits to {}
        set _names to ""
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${Number(id)})
              if (count of matchingMsgs) > 0 then
                set end of _hits to (item 1 of matchingMsgs)
                set _names to _names & (name of acct) & "/" & (name of mb) & ", "
              end if
            end try
          end repeat
        end repeat
        if (count of _hits) is 0 then return "error:Message not found"
        if (count of _hits) > 1 then return "error:${AMBIGUOUS_ID_PREFIX}${Number(id)} is present in more than one mailbox (" & _names & "); list or search that mailbox first so the operation targets the right copy"
        set msg to item 1 of _hits${
          instrument
            ? `
        set _out to ""
        set _pre to ""
        set _umb to missing value
        set _uacct to ""
        try
          set _umb to (mailbox of msg)
          set _uacct to (name of (account of _umb))
        end try
        set _cb to -1
        set _ca to -1
        if _umb is not missing value then
          try
            set _cb to (count of messages of _umb)
          end try
        end if${this.preImageFragment("msg")}
        ${operation}
        if _umb is not missing value then
          try
            set _ca to (count of messages of _umb)
          end try
          ${this.reconEmitFromMessage("_cb", "_ca")}
        end if
        return "1${FIELD_SEP}ok" & _pre & "${RECORD_SEP}" & _out`
            : `
        ${operation}
        return "ok"`
        }
      on error errMsg
        return "error:" & errMsg
      end try
    `);
  }

  /**
   * Build and stash the forensic report for a SINGLE-message destructive op.
   *
   * Same record stream, same parser and same reconciliation rules as the batch
   * path — a single-message delete is just a one-id batch as far as the evidence
   * is concerned, so there is exactly one implementation of "what did this
   * actually do".
   */
  private recordSingleForensics(
    output: string,
    id: string,
    destination?: { account: string; mailbox: string }
  ): void {
    const valid = [{ id, num: Number(id) }];
    const parsed = this.parseForensicStream(output, valid);
    // Position 1 is the only operand on this path — read from the stream's own
    // key, exactly as the batch path does.
    const succeeded = parsed.okPositions.has(1);
    const sameMailbox = (account: string, mailbox: string): boolean =>
      destination !== undefined &&
      destination.account === account &&
      this.resolveMailbox(destination.mailbox, destination.account) ===
        this.resolveMailbox(mailbox, account);
    const home = parsed.recons[0];
    this.lastForensics = this.buildForensicReport(
      parsed,
      valid,
      // null, not 0, for a self-move — see SELF_MOVE_NOTE.
      (account, mailbox) => (sameMailbox(account, mailbox) ? null : succeeded ? 1 : 0),
      () =>
        home
          ? { account: home.account, mailbox: home.mailbox }
          : (this.locationFor(id) ?? { account: "", mailbox: "" }),
      (account, mailbox) => (sameMailbox(account, mailbox) ? SELF_MOVE_NOTE : undefined),
      new Set([canonicalNumericId(String(Number(id)))])
    );
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
   * AppleScript statement(s) to flag a message variable, optionally setting its
   * color. `colorIndex` is Apple's flag-index palette (0 red, 1 orange,
   * 2 yellow, 3 green, 4 blue, 5 purple, 6 gray); it is validated to 0-6 by the
   * schema layer and is a number, so it is safe to interpolate. Omitting it
   * applies Mail's default flag without touching the color.
   */
  private flagOperation(varName: string, colorIndex?: number): string {
    const setFlag = `set flagged status of ${varName} to true`;
    return colorIndex === undefined
      ? setFlag
      : `${setFlag}\n          set flag index of ${varName} to ${colorIndex}`;
  }

  /**
   * Flag a message, optionally with a color (see {@link flagOperation}).
   */
  flagMessage(id: string, colorIndex?: number): boolean {
    const script = this.findMessageScript(id, this.flagOperation("msg", colorIndex));
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to flag message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Resolve a message's numeric Mail.app id from its RFC822 Message-ID (the
   * backend-independent join key). This bridges an `imap:` id to the numeric id
   * required by the AppleScript-only tools — `reply-to-message` and
   * `forward-message`.
   *
   * Note: flag *color* no longer needs this (since 2.10.0). Mail.app stores the
   * color as the `$MailFlagBit0/1/2` keywords, which ride alongside `\Flagged`
   * in an ordinary `UID STORE`, so flag-message/batch-flag-messages color an
   * `imap:` id directly and a smart mailbox keyed on flag color matches it.
   *
   * The Message-ID is matched both bracketless and `<bracketed>` (Mail returns
   * it bracketless; IMAP envelopes carry the brackets). When `accountName` is
   * given the search is scoped to that account, checking its INBOX first (swept
   * messages live there) to avoid scanning huge All Mail/Archive mailboxes.
   *
   * @returns the numeric id as a string, or null if no message matches.
   */
  findNumericIdByMessageId(messageId: string, accountName?: string): string | null {
    const mid = messageId.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
    if (!mid) return null;

    const q = (s: string) => escapeForAppleScript(s);
    const midLit = `"${q(mid)}"`;
    const bracketedLit = `"${q(`<${mid}>`)}"`;
    const matchClause = (mbVar: string) =>
      `(messages of ${mbVar} whose message id is ${midLit} or message id is ${bracketedLit})`;

    const acctList = accountName
      ? `set acctList to (every account whose name is "${q(accountName)}")
        if (count of acctList) is 0 then set acctList to accounts`
      : `set acctList to accounts`;

    const script = buildAppLevelScript(`
      try
        ${acctList}
        repeat with acct in acctList
          -- INBOX first: swept messages live there; avoids scanning huge mailboxes.
          try
            set inMb to mailbox "INBOX" of acct
            set inHits to ${matchClause("inMb")}
            if (count of inHits) > 0 then return (id of (item 1 of inHits)) as string
          end try
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to ${matchClause("mb")}
              if (count of matchingMsgs) > 0 then
                return (id of (item 1 of matchingMsgs)) as string
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
    if (!result.success || result.output.startsWith("error:")) return null;
    const out = result.output.trim();
    return /^\d+$/.test(out) ? out : null;
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
  deleteMessage(id: string): { success: boolean; error?: string } {
    // (findMessageScript calls beginMutation)
    const script = this.findMessageScript(id, "delete msg", true);
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (result.success && !result.output.startsWith("error:")) {
      this.recordSingleForensics(result.output, id);
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
  private classifyMessageMutationError(id: string, raw: string, op: "delete" | "move"): string {
    const trimmed = (raw || "").trim();
    if (!UNSUPPORTED_APPLESCRIPT_OP.test(trimmed)) return trimmed || `Failed to ${op} message`;

    let mailbox = "";
    try {
      mailbox = this.getMessageById(id)?.mailbox ?? "";
    } catch {
      /* best-effort; fall through to the generic server-side message */
    }
    if (/draft/i.test(mailbox)) {
      return `Mail.app cannot ${op} drafts via AppleScript; ${op} it in Mail.app directly. (Mail.app error: ${trimmed})`;
    }
    return `Mail.app cannot ${op} this message via AppleScript (server-side or special mailbox${
      mailbox ? ` "${mailbox}"` : ""
    }); ${op} it in Mail.app directly. (Mail.app error: ${trimmed})`;
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
  private moveMessageInternal(
    id: string,
    mailbox: string,
    account?: string
  ): { success: boolean; error?: string } {
    const targetAccount = this.resolveAccount(account);
    const targetMailbox = this.resolveMailbox(mailbox, targetAccount);
    const safeMailbox = escapeForAppleScript(targetMailbox);
    const safeAccount = escapeForAppleScript(targetAccount);

    // Locate the SOURCE copy the same way every other by-id mutation does:
    // scoped to the mailbox the id was listed from, because one Mail.app id
    // names a different message in every mailbox that holds it (#152).
    const loc = this.locationFor(id);
    // Emitter-only literals — stripped of the record stream's own bytes.
    const srcAcctLit = loc ? `"${escapeForAppleScript(stripStreamDelimiters(loc.account))}"` : '""';
    const srcMbLit = loc ? `"${escapeForAppleScript(stripStreamDelimiters(loc.mailbox))}"` : '""';
    const findAndMove = loc
      ? `
        ${this.resolveMailboxFragment(loc.account, loc.mailbox)}
        if _tmb is missing value then return "error:Message not found"
        set matchingMsgs to (messages of _tmb whose id is ${Number(id)})
        if (count of matchingMsgs) is 0 then return "error:Message not found"
        set msg to item 1 of matchingMsgs
        set _out to ""
        set _pre to ""${this.countFragment("_cb")}${this.snapshotFragment("before", srcAcctLit, srcMbLit, "_cb")}${this.preImageFragment("msg")}
        move msg to destMailbox${this.countFragment("_ca")}${this.snapshotFragment("after", srcAcctLit, srcMbLit, "_ca")}${this.reconEmit(srcAcctLit, srcMbLit, "_cb", "_ca")}
        return "1${FIELD_SEP}ok" & _pre & "${RECORD_SEP}" & _out`
      : `
        set _hits to {}
        set _names to ""
        repeat with acct in accounts
          repeat with mb in (mailboxes of acct)
            try
              set matchingMsgs to (messages of mb whose id is ${Number(id)})
              if (count of matchingMsgs) > 0 then
                set end of _hits to (item 1 of matchingMsgs)
                set _names to _names & (name of acct) & "/" & (name of mb) & ", "
              end if
            end try
          end repeat
        end repeat
        if (count of _hits) is 0 then return "error:Message not found"
        if (count of _hits) > 1 then return "error:${AMBIGUOUS_ID_PREFIX}${Number(id)} is present in more than one mailbox (" & _names & "); list or search that mailbox first so the move targets the right copy"
        set msg to item 1 of _hits
        set _out to ""
        set _pre to ""
        set _umb to missing value
        set _uacct to ""
        try
          set _umb to (mailbox of msg)
          set _uacct to (name of (account of _umb))
        end try
        set _cb to -1
        set _ca to -1
        if _umb is not missing value then
          try
            set _cb to (count of messages of _umb)
          end try
        end if${this.preImageFragment("msg")}
        move msg to destMailbox
        if _umb is not missing value then
          try
            set _ca to (count of messages of _umb)
          end try
          ${this.reconEmitFromMessage("_cb", "_ca")}
        end if
        return "1${FIELD_SEP}ok" & _pre & "${RECORD_SEP}" & _out`;

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
        ${findAndMove}
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
    this.recordSingleForensics(result.output, id, {
      account: targetAccount,
      mailbox: targetMailbox,
    });
    return { success: true };
  }

  moveMessage(id: string, mailbox: string, account?: string): { success: boolean; error?: string } {
    this.beginMutation();
    const res = this.moveMessageInternal(id, mailbox, account);
    if (res.success) return { success: true };
    const error = this.classifyMessageMutationError(
      id,
      res.error || "Failed to move message",
      "move"
    );
    console.error(`Failed to move message: ${error}`);
    return { success: false, error };
  }

  // ===========================================================================
  // Batch Operations
  // ===========================================================================

  /**
   * Turn a caller-supplied batch source scope into an account+mailbox pair.
   *
   * A numeric source scope is an account+mailbox pair. A mailbox name alone is
   * not an identity: the same mailbox can exist in several accounts, and a
   * numeric Mail id is not globally unique. Resolving a missing account from
   * mutable default-send state can therefore target the wrong account. Require
   * both fields so a caller cannot silently cross that account boundary.
   *
   * The safety property is absolute: when the account cannot be determined there
   * is NO fallback to the scan-and-guess walk. The caller gets an error naming
   * the mailbox it asked for, so it can retry with an explicit `sourceAccount`.
   * (An `account` with no `mailbox` cannot pin anything, so it scopes nothing —
   * those ids still go through the index / ambiguity-checked path. A supplied
   * whitespace-only field is rejected rather than silently discarded.)
   */
  private resolveBatchScope(scope?: {
    account?: string;
    mailbox?: string;
  }):
    | { kind: "none" }
    | { kind: "scoped"; account: string; mailbox: string }
    | { kind: "unresolvable"; error: string } {
    const rawMailbox = scope?.mailbox;
    const rawAccount = scope?.account;
    const mailbox = rawMailbox?.trim();
    const account = rawAccount?.trim();

    if (rawMailbox !== undefined && !mailbox) {
      return {
        kind: "unresolvable",
        error: "sourceMailbox must contain a mailbox name; whitespace-only scope is not allowed.",
      };
    }
    if (rawAccount !== undefined && !account) {
      return {
        kind: "unresolvable",
        error: "sourceAccount must contain an account name; whitespace-only scope is not allowed.",
      };
    }
    if (!mailbox) return { kind: "none" };
    if (!account) {
      return {
        kind: "unresolvable",
        error:
          `Cannot scope to source mailbox "${mailbox}" without sourceAccount: numeric Mail ids ` +
          `are only unique within an account and mailbox. Retry with both sourceAccount and ` +
          `sourceMailbox explicitly set.`,
      };
    }
    return { kind: "scoped", account, mailbox };
  }

  /**
   * Run one operation over many message IDs in a SINGLE osascript invocation.
   *
   * Previously each batch method looped and called the per-id method, so a
   * 100-id batch spawned 100 osascript processes — each one re-resolving
   * accounts and walking the whole account→mailbox tree — all serialized
   * through the gate (issue #31). Still one osascript invocation, but the ids
   * are now grouped by the mailbox they were listed from and each group opens
   * exactly that one mailbox. Per-id outcomes come back as control-char
   * delimited `position<FS>status` records (status: `ok`, `notfound`, or
   * `error:<msg>`), and results are returned in input order.
   *
   * Scoping is a CORRECTNESS requirement, not an optimization (#152). A Mail.app
   * numeric id is unique only within a mailbox, and a label store (Gmail,
   * iCloud) exposes one message in several mailboxes under the same id — INBOX,
   * "Important" and "All Mail" all report id 75816 for the same mail. The old
   * tree walk applied `operation` to the FIRST mailbox that matched while
   * iterating `mailboxes of <account>`, so whichever copy that iteration reached
   * first won — and the ids' real source mailbox lost whenever an alias came
   * earlier. Observed on the reporting account (`list-mailboxes`, 2026-08-13):
   * INBOX 1, "[Gmail]/All Mail" 5, "[Gmail]/Important" 9, "Sales Spam" 12 — so a
   * batch listed from "Sales Spam" was applied to the All Mail copies while the
   * Sales Spam messages stayed put, and every id still reported `ok`. That order
   * is a property of the store, not a guarantee: do not rely on it in either
   * direction — any mailbox the walk reaches late loses the same way. Grouping by
   * recorded source mailbox makes the op land on the copy the caller actually
   * listed; ids with no recorded mailbox are refused when ambiguous rather than
   * applied to an arbitrary copy.
   *
   * `setup` runs once up front (used by move to resolve the destination); it may
   * bail the whole batch by returning a `BATCH_FATAL`-prefixed string.
   *
   * ## A repeated id names ONE message, and is operated on once
   *
   * A batch is a set of messages, not a multiset: two occurrences of id `75811`
   * are the same message, and Mail can only delete it once. So the id list is
   * DEDUPED on the numeric value actually sent to AppleScript (`"75811"` and
   * `" 75811"` are the same target), and the returned array carries one entry
   * per distinct id, in first-seen order — hence `success` counts distinct
   * messages rather than list positions.
   *
   * This is a correctness requirement for the #155 reconciliation, not a
   * tidy-up. Counting a repeat as a second operand makes `expected` disagree
   * with the mailbox — the duplicate can only be reported `notfound` (the
   * message is already gone) or `ok` twice (on a flag-only store) — and either
   * way the always-on warning fires on an operation that did exactly the right
   * thing. A warning users learn to ignore is worse than no warning.
   */
  private runBatchOperation(
    ids: string[],
    operation: string,
    setup = "",
    scope?: { account?: string; mailbox?: string },
    forensics?: { destination?: { account: string; mailbox: string } }
  ): BatchOperationResult[] {
    // #155 instrumentation is opt-in PER OPERATION, not per server: only the
    // destructive batches (delete, move) ask for it, so batch mark/flag generate
    // byte-identical AppleScript to before and carry zero new cost or risk.
    const instrument = forensics !== undefined;
    // Cleared for EVERY batch, instrumented or not. An uninstrumented batch
    // produces no report, and if it left a previous one in place the next
    // `consumeLastForensics()` would attribute a delete's evidence to a
    // batch-mark-as-read. One rule, no stale window: entering any batch
    // invalidates whatever the last one observed.
    this.beginMutation();
    // Keep the numeric IDs paired with their original string form and 1-based
    // position. The AppleScript reports outcomes by POSITION, not by id: a Mail
    // id large enough to exceed AppleScript's 2^29 integer range coerces to
    // scientific notation under `as string` (999999999 -> "9.99999999E+8"), so
    // echoing the id back can't be matched to the input. Positions are always
    // small integers, so they round-trip cleanly.
    //
    // `operands` is the deduped input in first-seen order — what every return
    // path below maps over, so the caller gets exactly one result per distinct
    // id (see the class note above).
    const valid: { id: string; num: number }[] = [];
    const operands: string[] = [];
    const seenNums = new Set<number>();
    const seenInvalid = new Set<string>();
    for (const id of ids) {
      const num = Number(id);
      if (Number.isFinite(num)) {
        if (seenNums.has(num)) continue;
        seenNums.add(num);
        valid.push({ id, num });
      } else {
        if (seenInvalid.has(id)) continue;
        seenInvalid.add(id);
      }
      operands.push(id);
    }
    if (valid.length === 0) {
      return operands.map((id) => ({ id, success: false, error: "Invalid message ID" }));
    }

    // An explicit `scope` from the caller outranks the index. The index is
    // per-process state, so a caller that started a fresh server (or restored a
    // saved id list) has nothing recorded and every id would land in
    // `unlocated` — where, on a label store, it gets refused as ambiguous.
    // Naming the source mailbox is the reliable way to stay on the scoped path.
    //
    // A scope we cannot honor FAILS the batch. Silently dropping it would put
    // every id back on the whole-tree path the caller was trying to avoid.
    const resolved = this.resolveBatchScope(scope);
    if (resolved.kind === "unresolvable") {
      return operands.map((id) => ({ id, success: false, error: resolved.error }));
    }
    // #156 item 3. `runBatchOperation` never consulted this guard, so a batch
    // scoped to a disabled account went straight to AppleScript, failed
    // server-side with AppleEvent -10000, and could leave a mailbox half-changed
    // — the exact case disabledAccountGuard exists to refuse up front for the
    // single-message paths. The guard fails OPEN (an inconclusive probe returns
    // null), so this cannot block an operation on an account whose state Mail
    // will not report.
    if (resolved.kind === "scoped") {
      const disabled = this.disabledAccountGuard(resolved.account);
      if (disabled) {
        return operands.map((id) => ({ id, success: false, error: disabled }));
      }
    }
    const callerScope = resolved.kind === "scoped" ? resolved : undefined;

    // Group the ids by the mailbox they were listed from. Each group opens that
    // one mailbox and applies the op only there; ids we've never seen listed
    // fall into `unlocated` and are resolved with an ambiguity check.
    const groups = new Map<
      string,
      { account: string; mailbox: string; items: { num: number; pos: number }[] }
    >();
    const unlocated: { num: number; pos: number }[] = [];
    valid.forEach((v, i) => {
      const pos = i + 1;
      const loc = callerScope ?? this.locationFor(v.id);
      if (!loc) {
        unlocated.push({ num: v.num, pos });
        return;
      }
      const key = groupKey(loc.account, loc.mailbox);
      const g = groups.get(key) ?? { account: loc.account, mailbox: loc.mailbox, items: [] };
      g.items.push({ num: v.num, pos });
      groups.set(key, g);
    });

    const asList = (nums: number[]): string => `{${nums.join(", ")}}`;

    // One block per source mailbox: resolve it once, then apply the op to each
    // of that mailbox's ids.
    //
    // When instrumented, the SAME block also counts the mailbox before and after
    // its loop (always-on reconciliation) and, when the audit log is on,
    // snapshots (id, Message-ID) either side of it (collateral diff). All of it
    // is inline: still exactly ONE osascript invocation for the whole batch.
    const scopedBlocks = [...groups.values()]
      .map((g) => {
        // Emitter-only literals — see findMessageScript: the mailbox is resolved
        // by its real name, but what goes INTO the record stream is stripped of
        // the stream's own structural bytes. INVARIANT (see the record-tag block
        // at the top of this file): this holds for EVERY emitter, including the
        // error records below, not only the ones carrying mail-derived values.
        const acctLit = `"${escapeForAppleScript(stripStreamDelimiters(g.account))}"`;
        const mbLit = `"${escapeForAppleScript(stripStreamDelimiters(g.mailbox))}"`;
        // The "mailbox not found" record names the same two values in prose, so
        // it gets the same stripping. Unreachable today — a mailbox name with a
        // record separator in it would have to survive resolveMailbox first —
        // but an invariant with an exception is not an invariant, and the next
        // emitter gets copied from whichever one its author happened to read.
        const acctInProse = escapeForAppleScript(stripStreamDelimiters(g.account));
        const mbInProse = escapeForAppleScript(stripStreamDelimiters(g.mailbox));
        const pre = instrument ? this.preImageFragment("_msg") : "";
        return `
        ${this.resolveMailboxFragment(g.account, g.mailbox)}
        set _gids to ${asList(g.items.map((it) => it.num))}
        set _gpos to ${asList(g.items.map((it) => it.pos))}
        if _tmb is missing value then
          repeat with _k from 1 to (count of _gpos)
            set _out to _out & ((item _k of _gpos) as string) & "${FIELD_SEP}error:source mailbox \\"${mbInProse}\\" not found in account \\"${acctInProse}\\"${RECORD_SEP}"
          end repeat
        else${
          instrument
            ? `${this.countFragment("_cb")}${this.snapshotFragment("before", acctLit, mbLit, "_cb")}`
            : ""
        }
          repeat with _k from 1 to (count of _gids)
            set _idx to item _k of _gpos
            set _pre to ""
            try
              set _m to (messages of _tmb whose id is (item _k of _gids))
              if (count of _m) > 0 then
                set _msg to item 1 of _m${pre}
                ${operation}
                set _out to _out & (_idx as string) & "${FIELD_SEP}ok" & _pre & "${RECORD_SEP}"
              else
                set _out to _out & (_idx as string) & "${FIELD_SEP}notfound${RECORD_SEP}"
              end if
            on error _e
${this.errorEmit("              ")}
            end try
          end repeat${
            instrument
              ? `${this.countFragment("_ca")}${this.snapshotFragment("after", acctLit, mbLit, "_ca")}${this.reconEmit(acctLit, mbLit, "_cb", "_ca")}`
              : ""
          }
        end if`;
      })
      .join("\n");

    // Ids with no recorded source mailbox: count every mailbox holding each id
    // and act only where exactly one does. Anything ambiguous is refused with
    // the candidates named, never applied to whichever copy sorts first.
    const unlocatedBlock = unlocated.length
      ? `
        set _uids to ${asList(unlocated.map((it) => it.num))}
        set _upos to ${asList(unlocated.map((it) => it.pos))}
        set _ucount to count of _uids
        set _uhit to {}
        set _umsg to {}
        set _unames to {}
        repeat with _k from 1 to _ucount
          set end of _uhit to 0
          set end of _umsg to missing value
          set end of _unames to ""
        end repeat
        repeat with acct in accounts
          repeat with mb in (mailboxes of acct)
            repeat with _k from 1 to _ucount
              try
                set _m to (messages of mb whose id is (item _k of _uids))
                if (count of _m) > 0 then
                  set item _k of _uhit to ((item _k of _uhit) + 1)
                  if (item _k of _uhit) is 1 then set item _k of _umsg to (item 1 of _m)
                  set item _k of _unames to ((item _k of _unames) & (name of acct) & "/" & (name of mb) & ", ")
                end if
              end try
            end repeat
          end repeat
        end repeat
        repeat with _k from 1 to _ucount
          set _idx to item _k of _upos
          if (item _k of _uhit) is 0 then
            set _out to _out & (_idx as string) & "${FIELD_SEP}notfound${RECORD_SEP}"
          else if (item _k of _uhit) > 1 then
            set _uname to (item _k of _unames)${this.sanitizeFragment("_uname", "            ")}
            set _out to _out & (_idx as string) & "${FIELD_SEP}error:${AMBIGUOUS_ID_BATCH}(" & _uname & "); list or search that mailbox first so the operation targets the right copy${RECORD_SEP}"
          else
            set _pre to ""
            try
              set _msg to item _k of _umsg${
                instrument
                  ? `
              set _umb to missing value
              set _uacct to ""
              try
                set _umb to (mailbox of _msg)
                set _uacct to (name of (account of _umb))
              end try
              set _ucb to -1
              set _uca to -1
              if _umb is not missing value then
                try
                  set _ucb to (count of messages of _umb)
                end try
              end if${this.preImageFragment("_msg")}`
                  : ""
              }
              ${operation}
              set _out to _out & (_idx as string) & "${FIELD_SEP}ok" & _pre & "${RECORD_SEP}"${
                instrument
                  ? `
              if _umb is not missing value then
                try
                  set _uca to (count of messages of _umb)
                end try
                ${this.reconEmitFromMessage("_ucb", "_uca", "(_idx as string)", "                ")}
              end if`
                  : ""
              }
            on error _e
${this.errorEmit("              ")}
            end try
          end if
        end repeat`
      : "";

    const script = buildAppLevelScript(`
      try
        ${setup}
        set _out to ""
        ${scopedBlocks}
        ${unlocatedBlock}
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
      return operands.map((id) => ({ id, success: false, error: err }));
    }
    if (result.output.startsWith(BATCH_FATAL)) {
      const err = result.output.slice(BATCH_FATAL.length);
      return operands.map((id) => ({ id, success: false, error: err }));
    }

    // Map by-position outcomes (and, when instrumented, the RECON/SNAP records
    // riding in the same stream) back to the original id strings.
    const parsed = this.parseForensicStream(result.output, valid);
    const { byId } = parsed;

    if (instrument) {
      // Where each position's message lived, for the audit pre-image.
      const posLocation = new Map<number, { account: string; mailbox: string }>();
      for (const g of groups.values()) {
        for (const it of g.items)
          posLocation.set(it.pos, { account: g.account, mailbox: g.mailbox });
      }
      // Unlocated ids learn their mailbox from their own RECON record.
      for (const r of parsed.recons) {
        if (r.pos !== null) posLocation.set(r.pos, { account: r.account, mailbox: r.mailbox });
      }

      // Which POSITIONS the script reported `ok` for — taken straight off the
      // record stream, never re-derived through an id-keyed map. A position is
      // unique by construction; an id string is only unique because the input
      // is deduped, and `expected` is the number the always-on warning is
      // computed from, so it is read from the one key that cannot collide.
      const { okPositions } = parsed;

      // How many messages SHOULD have left a given mailbox.
      //
      // Normally one per id that reported `ok`: Apple Mail's `delete` moves the
      // message out of the mailbox it was in, and a `move` copies then removes
      // it — on a Gmail label mailbox both amount to dropping that label, so the
      // source mailbox loses exactly one entry either way.
      //
      // The one case with NO honest expectation is a move whose destination IS
      // the source mailbox: nothing should leave, but what Mail actually does to
      // the count when a message is re-filed into the mailbox it already
      // occupies is unspecified. `null` says so — the mailbox is reported,
      // annotated, and never compared. See SELF_MOVE_NOTE.
      const dest = forensics?.destination;
      const sameMailbox = (account: string, mailbox: string): boolean =>
        dest !== undefined &&
        dest.account === account &&
        this.resolveMailbox(dest.mailbox, dest.account) === this.resolveMailbox(mailbox, account);
      const expectedFor = (account: string, mailbox: string, pos: number | null): number | null => {
        if (sameMailbox(account, mailbox)) return null;
        if (pos !== null) return okPositions.has(pos) ? 1 : 0;
        const group = groups.get(groupKey(account, mailbox));
        if (!group) return 0;
        return group.items.filter((it) => okPositions.has(it.pos)).length;
      };
      const noteFor = (account: string, mailbox: string): string | undefined =>
        sameMailbox(account, mailbox) ? SELF_MOVE_NOTE : undefined;

      this.lastForensics = this.buildForensicReport(
        parsed,
        valid,
        expectedFor,
        (pos) => posLocation.get(pos) ?? { account: "", mailbox: "" },
        noteFor,
        // Canonicalised, because the ids this is compared against come back
        // from AppleScript — see canonicalNumericId.
        new Set(valid.map((v) => canonicalNumericId(String(v.num))))
      );
    }

    // One result per DISTINCT id, in first-seen order.
    return operands.map(
      (id) =>
        byId.get(id) ??
        (Number.isFinite(Number(id))
          ? { id, success: false, error: "No result returned" }
          : { id, success: false, error: "Invalid message ID" })
    );
  }

  /**
   * Delete multiple messages at once (single tree walk — see runBatchOperation).
   */
  batchDeleteMessages(
    ids: string[],
    scope?: { account?: string; mailbox?: string }
  ): BatchOperationResult[] {
    return this.runBatchOperation(ids, "delete _msg", "", scope, {});
  }

  /**
   * Move multiple messages to a mailbox at once (single tree walk).
   *
   * The destination is resolved once (account-scoped, ambiguity-aware — a name
   * matching more than one mailbox fails the whole batch rather than guessing),
   * then every matched message is moved in the same walk.
   */
  batchMoveMessages(
    ids: string[],
    mailbox: string,
    account?: string,
    scope?: { account?: string; mailbox?: string }
  ): BatchOperationResult[] {
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

    return this.runBatchOperation(ids, "move _msg to destMailbox", setup, scope, {
      destination: { account: targetAccount, mailbox: targetMailbox },
    });
  }

  /**
   * Mark multiple messages as read at once (single tree walk).
   */
  batchMarkAsRead(
    ids: string[],
    scope?: { account?: string; mailbox?: string }
  ): BatchOperationResult[] {
    return this.runBatchOperation(ids, "set read status of _msg to true", "", scope);
  }

  /**
   * Mark multiple messages as unread at once (single tree walk).
   */
  batchMarkAsUnread(
    ids: string[],
    scope?: { account?: string; mailbox?: string }
  ): BatchOperationResult[] {
    return this.runBatchOperation(ids, "set read status of _msg to false", "", scope);
  }

  /**
   * Flag multiple messages at once (single tree walk).
   */
  batchFlagMessages(
    ids: string[],
    colorIndex?: number,
    scope?: { account?: string; mailbox?: string }
  ): BatchOperationResult[] {
    return this.runBatchOperation(ids, this.flagOperation("_msg", colorIndex), "", scope);
  }

  /**
   * Unflag multiple messages at once (single tree walk).
   */
  batchUnflagMessages(
    ids: string[],
    scope?: { account?: string; mailbox?: string }
  ): BatchOperationResult[] {
    return this.runBatchOperation(ids, "set flagged status of _msg to false", "", scope);
  }

  /**
   * List attachments for a message.
   * Tries AppleScript first, falls back to MIME source parsing
   * when AppleScript returns empty (known issue across all account types).
   */
  listAttachments(id: string): Attachment[] {
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
      const attachments: Attachment[] = [];

      for (const item of items) {
        const parts = item.split(FIELD_SEP);
        if (parts.length < 3) continue;

        attachments.push({
          id: `${id}-${parts[0]}`,
          name: parts[0],
          mimeType: parts[1],
          size: parseInt(parts[2]) || 0,
        });
      }

      if (attachments.length > 0) return attachments;
    }

    // Attempt 2: MIME source fallback
    const rawSource = this.getRawSource(id);
    if (!rawSource) return [];

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
  saveAttachment(id: string, attachmentName: string, savePath: string): boolean {
    // Validate attachment name: block path separators, traversal, null bytes, and backslashes
    if (/[/\\\0]/.test(attachmentName) || attachmentName.includes("..")) {
      console.error(`Invalid attachment name: "${attachmentName}"`);
      return false;
    }

    let target: { saveDirectory: string; savedPath: string };
    try {
      target = resolveAttachmentSaveTarget(savePath, attachmentName);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return false;
    }

    const safeName = escapeForAppleScript(attachmentName);
    let temporaryDirectory: string;
    try {
      // Mail.app writes the attachment into a private directory created with
      // mkdtempSync, so another process cannot pre-create or swap the staging
      // path before COPYFILE_EXCL commits it to the caller's destination.
      temporaryDirectory = mkdtempSync(join(target.saveDirectory, ".apple-mail-mcp-"));
    } catch (error) {
      console.error(`Failed to create attachment staging directory: ${error}`);
      return false;
    }
    const temporaryPath = join(temporaryDirectory, "attachment");
    const safeTemporaryPath = escapeForAppleScript(temporaryPath);
    const cleanupTemporaryDirectory = () => {
      try {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the destination was not replaced by cleanup.
      }
    };
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
                    set savePath to POSIX file "${safeTemporaryPath}"
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
      try {
        // The preflight above prevents ordinary overwrites. COPYFILE_EXCL also
        // closes the check/use race if another process creates the destination
        // while Mail.app is saving the attachment to its private temp path.
        copyFileSync(temporaryPath, target.savedPath, fsConstants.COPYFILE_EXCL);
        // Mail.app controls the mode of the source file. Normalize the final
        // artifact after the exclusive copy so the shipped guarantee is true
        // for the AppleScript path as well as the MIME fallback.
        chmodSync(target.savedPath, 0o600);
        cleanupTemporaryDirectory();
        return true;
      } catch (err) {
        cleanupTemporaryDirectory();
        console.error(`Failed to commit attachment to disk: ${err}`);
        return false;
      }
    }

    cleanupTemporaryDirectory();

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

    let mimeTemporaryDirectory: string | undefined;
    try {
      // Keep MIME staging private and on the destination filesystem. The
      // final COPYFILE_EXCL is the only operation that creates the caller's
      // path, so this fallback has the same no-overwrite boundary as the
      // AppleScript path. A staging-directory failure is a safe false result.
      mimeTemporaryDirectory = mkdtempSync(join(target.saveDirectory, ".apple-mail-mcp-"));
      const mimeTemporaryPath = join(mimeTemporaryDirectory, "attachment");
      writeFileSync(mimeTemporaryPath, attachment.data, { flag: "wx", mode: 0o600 });
      copyFileSync(mimeTemporaryPath, target.savedPath, fsConstants.COPYFILE_EXCL);
      chmodSync(target.savedPath, 0o600);
      return true;
    } catch (err) {
      console.error(`Failed to write attachment to disk: ${err}`);
      return false;
    } finally {
      if (mimeTemporaryDirectory) {
        try {
          rmSync(mimeTemporaryDirectory, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup; the destination was never replaced by cleanup.
        }
      }
    }
  }

  /**
   * Fetch an attachment's bytes as base64 (B4) — the read counterpart to
   * sending inline base64 content. Reuses saveAttachment via a throwaway temp
   * dir (under an allowed root), then reads and encodes the file.
   */
  getAttachmentBase64(
    id: string,
    attachmentName: string
  ): { success: boolean; base64?: string; bytes?: number; error?: string } {
    let dir: string | null = null;
    try {
      dir = mkdtempSync("/private/tmp/amcp-fetch-");
      const dest = join(dir, attachmentName.replace(/[/\\]/g, "_"));
      const ok = this.saveAttachment(id, attachmentName, dir);
      if (!ok) {
        return {
          success: false,
          error: `Attachment "${attachmentName}" not found on message ${id}`,
        };
      }
      const buf = readFileSync(dest);
      return { success: true, base64: buf.toString("base64"), bytes: buf.length };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  // ===========================================================================
  // Mailbox Operations
  // ===========================================================================

  /**
   * List all mailboxes for an account.
   */
  listMailboxes(account?: string, options: { timeoutMs?: number } = {}): Mailbox[] {
    // #183: `account="On My Mac"` addresses the LOCAL store, which is not an
    // account — it has no `tell account` form. Only an EXPLICIT request selects
    // it; `resolveAccount()` is untouched and still can only ever return a real
    // account, so nothing implicitly lands in the local store.
    const local = isLocalStoreLabel(account);
    const targetAccount = local ? LOCAL_STORE_LABEL : this.resolveAccount(account);

    // One command text, parameterised only by what it iterates: the account
    // branch keeps today's bare `mailboxes` (which binds to the account inside
    // `tell account`), the local branch iterates the ownership-filtered `_mbs`.
    const listCommand = (iterExpr: string): string => `
      set mailboxList to {}
      repeat with mb in ${iterExpr}
        set mbName to name of mb
        set mbUnread to unread count of mb
        set mbCount to count of messages of mb
        set end of mailboxList to mbName & "${FIELD_SEP}" & mbUnread & "${FIELD_SEP}" & mbCount
      end repeat
      set AppleScript's text item delimiters to "${RECORD_SEP}"
      return mailboxList as text
    `;

    const script = local
      ? buildAppLevelScript(`${localMailboxBindingFragment()}
      ${listCommand("_mbs")}`)
      : buildAccountScopedScript(targetAccount, listCommand("mailboxes"));
    // Counts every mailbox's message total, so it needs more than the default
    // 30s on accounts with many/large mailboxes; a timeout here silently
    // returned an empty list (audit finding #8). A caller working to an overall
    // deadline can lower it — 60s alone overruns most clients' request
    // timeouts, so "the default is generous" is not a safe assumption (#135).
    const result = executeAppleScript(script, { timeoutMs: options.timeoutMs ?? 60000 });

    if (!result.success) {
      console.error(`Failed to list mailboxes: ${result.error}`);
      this.lastMailboxesError = result.error ?? "AppleScript transport failed";
      return [];
    }

    if (!result.output.trim()) return [];

    const items = result.output.split(RECORD_SEP);
    const mailboxes: Mailbox[] = [];

    for (const item of items) {
      const parts = item.split(FIELD_SEP);
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
   * listMailboxes() plus whether the underlying AppleScript read actually worked.
   *
   * An empty list is ambiguous on its own — Mail with no mailboxes and a timed-out
   * transport both produce `[]`, and folding the second into a total as 0 is the
   * silent-zero class #130 fixed elsewhere. A caller summing counts across
   * accounts needs to tell them apart. (#135)
   */
  listMailboxesChecked(
    account?: string,
    options: { timeoutMs?: number } = {}
  ): { mailboxes: Mailbox[]; failed: boolean; error?: string } {
    this.lastMailboxesError = null;
    const mailboxes = this.listMailboxes(account, options);
    const error = this.lastMailboxesError;
    return error ? { mailboxes, failed: true, error } : { mailboxes, failed: false };
  }

  /**
   * Get unread count for a mailbox.
   */
  getUnreadCount(mailbox?: string, account?: string): number {
    const targetAccount = this.resolveAccount(account);

    // No mailbox → INBOX. Summing unread across every mailbox was slow (audit
    // #8: could exceed 30s and then degrade silently to 0 = "all read") and
    // wrong on Gmail, where one unread message also lives in All Mail and each
    // of its labels and got counted several times. INBOX is the meaningful
    // "unread messages" figure; this mirrors an explicit mailbox:"INBOX".
    const targetMailbox = this.resolveMailbox(mailbox || "INBOX", targetAccount);
    const safeMailbox = escapeForAppleScript(targetMailbox);
    const command = `return unread count of mailbox "${safeMailbox}"`;

    const script = buildAccountScopedScript(targetAccount, command);
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success) {
      console.error(`Failed to get unread count: ${result.error}`);
      this.lastAccountsError = result.error ?? "AppleScript transport failed";
      return 0;
    }

    return parseInt(result.output) || 0;
  }

  /**
   * Create a new mailbox.
   */
  createMailbox(name: string, account?: string): { success: boolean; error?: string } {
    const targetAccount = this.resolveAccount(account);

    const disabled = this.disabledAccountGuard(targetAccount);
    if (disabled) {
      console.error(`Refusing to create mailbox: ${disabled}`);
      return { success: false, error: disabled };
    }

    // BUG B: never create a mailbox on a server-side account we couldn't later
    // delete/rename via AppleScript (IMAP-configured accounts are routed to IMAP
    // upstream and never reach here).
    const serverSide = this.serverSideCreateGuard(targetAccount, "create");
    if (serverSide) {
      console.error(`Refusing to create mailbox: ${serverSide}`);
      return { success: false, error: serverSide };
    }

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
      const raw = result.success
        ? result.output.replace(/^error:/, "")
        : result.error || "Unknown error";
      const error = describeMailboxOpError("create", raw);
      console.error(`Failed to create mailbox: ${error}`);
      return { success: false, error };
    }

    this.invalidateCache();
    return { success: true };
  }

  /**
   * Delete a mailbox.
   */
  deleteMailbox(name: string, account?: string): { success: boolean; error?: string } {
    const targetAccount = this.resolveAccount(account);

    const disabled = this.disabledAccountGuard(targetAccount);
    if (disabled) {
      console.error(`Refusing to delete mailbox: ${disabled}`);
      return { success: false, error: disabled };
    }

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
  renameMailbox(
    oldName: string,
    newName: string,
    account?: string
  ): { success: boolean; error?: string } {
    const targetAccount = this.resolveAccount(account);

    // BUG B: refuse a server-side rename UP FRONT, before creating the
    // destination. AppleScript can create the destination but can't delete the
    // source server-side, which historically left a half-created orphan. IMAP-
    // configured accounts are routed to IMAP upstream and never reach here.
    const serverSide = this.serverSideCreateGuard(targetAccount, "rename");
    if (serverSide) {
      console.error(`Refusing to rename mailbox: ${serverSide}`);
      return { success: false, error: serverSide };
    }

    // Create the new mailbox. createMailbox runs the disabled-account guard, so
    // a disabled target is refused here before anything is built — no orphan can
    // be created. Propagate its (more specific) error rather than a generic one.
    const created = this.createMailbox(newName, targetAccount);
    if (!created.success) {
      return {
        success: false,
        error:
          created.error ??
          `Could not create the destination mailbox "${newName}" needed for the rename.`,
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
      // Roll back the destination we just created so a failed rename doesn't
      // leave an orphan (as a partial-failure once did — the _amcp_rename_test_*
      // ghosts). deleteMailboxIfEmpty only removes it when empty, so any
      // messages that did move are never destroyed; the source is untouched
      // (its delete only runs after a verified-empty move).
      const rolledBack = this.deleteMailboxIfEmpty(resolvedNew, targetAccount);
      let error = describeMailboxOpError("rename", raw);
      error += rolledBack
        ? ` The empty destination mailbox "${resolvedNew}" was rolled back, so no orphan was left.`
        : ` The destination mailbox "${resolvedNew}" was created and could not be auto-removed; delete it manually if it is an empty leftover.`;
      console.error(`Failed to rename mailbox: ${error}`);
      this.invalidateCache();
      return { success: false, error };
    }

    if (result.output.startsWith("partial")) {
      const parts = result.output.split(FIELD_SEP);
      const remaining = parts[3] ?? "?";
      const total = parts[2] ?? "?";
      const error = `Only ${
        parts[1] ?? "?"
      } of ${total} messages moved, ${remaining} remain in "${resolvedOld}"; the source was NOT deleted (both mailboxes left intact). Retry to move the rest.`;
      console.error(`Failed to rename mailbox: ${error}`);
      this.invalidateCache(); // the new mailbox now exists and holds the moved messages
      return { success: false, error };
    }

    this.invalidateCache();
    return { success: true };
  }

  // ===========================================================================
  // Smart Mailbox (intelligente Postfächer) Operations
  // Uses plist manipulation because AppleScript terms for "smart mailbox"
  // / "intelligentes Postfach" do not compile reliably on German-localized
  // macOS (verified via osascript + JXA). Plist format is stable and
  // gives full control over criteria without UI/GUI scripting.
  // ===========================================================================

  private findSyncedSmartPlist(): string | null {
    const base = join(homedir(), "Library", "Mail");
    try {
      const versions = readdirSync(base).filter((d: string) => d.startsWith("V"));
      versions.sort().reverse();
      for (const v of versions) {
        const p = join(base, v, "MailData", "SyncedSmartMailboxes.plist");
        if (existsSync(p)) return p;
      }
    } catch {
      // no Mail data dir yet (Mail.app never launched) — treat as "no smart mailboxes"
    }
    return null;
  }

  /**
   * Read all smart-mailbox entries without ever mutating the plist.
   *
   * Fast path: `plutil -convert json`. That converter *rejects* any plist
   * containing <data>/<date> values ("Invalid object in plist for JSON
   * format") — and smart-mailbox date criteria can contain exactly those — so
   * on such libraries we fall back to structural probing with PlistBuddy. (The
   * previous implementation used the json path unconditionally and, on
   * failure, treated the whole file as empty, which then overwrote every
   * existing smart mailbox on the next save.)
   */
  private readSmartMailboxEntries(
    plistPath: string | null
  ): Array<{ name: string; id?: string; criteriaSummary?: string }> {
    if (!plistPath || !existsSync(plistPath)) return [];
    const j = spawnSync("plutil", ["-convert", "json", "-o", "-", plistPath], {
      encoding: "utf8",
    });
    if (j.status === 0 && j.stdout) {
      try {
        const data = JSON.parse(j.stdout);
        if (Array.isArray(data)) {
          return data.map((m: any) => ({
            name: m?.MailboxName ?? "",
            id: m?.MailboxID,
            criteriaSummary: this.summarizeCriteria(m?.MailboxCriteria),
          }));
        }
      } catch {
        // malformed json output — fall through to structural probing
      }
    }
    return this.probeSmartMailboxEntries(plistPath);
  }

  /**
   * Structural enumeration for plists the json converter rejects (date/data
   * criteria). Probes array indices via PlistBuddy until one is out of range.
   */
  private probeSmartMailboxEntries(plistPath: string): Array<{ name: string; id?: string }> {
    const buddy = "/usr/libexec/PlistBuddy";
    const out: Array<{ name: string; id?: string }> = [];
    for (let i = 0; i < 1000; i++) {
      const exists = spawnSync(buddy, ["-c", `Print :${i}`, plistPath], { encoding: "utf8" });
      if (exists.status !== 0) break;
      const nameR = spawnSync(buddy, ["-c", `Print :${i}:MailboxName`, plistPath], {
        encoding: "utf8",
      });
      const idR = spawnSync(buddy, ["-c", `Print :${i}:MailboxID`, plistPath], {
        encoding: "utf8",
      });
      out.push({
        name: nameR.status === 0 ? (nameR.stdout || "").trim() : "",
        id: idR.status === 0 ? (idR.stdout || "").trim() || undefined : undefined,
      });
    }
    return out;
  }

  private summarizeCriteria(crits: any): string | undefined {
    if (!Array.isArray(crits)) return undefined;
    const summary = crits
      .map((c: any) => {
        const n = c?.Name || c?.Header || "";
        return c?.Expression ? `${n}=${String(c.Expression).slice(0, 25)}` : n;
      })
      .filter(Boolean)
      .join("; ")
      .slice(0, 100);
    return summary || undefined;
  }

  /**
   * Back up `plistPath` to `<plist>.bak` and return a sibling temp-file path
   * (same directory → same filesystem, so the later rename is atomic) seeded
   * with the current contents. Callers mutate the temp copy, then
   * commitSmartPlist() lints and atomically renames it into place — so the live
   * plist is only ever replaced wholesale by a validated file, never edited in
   * place and never left half-written.
   */
  private prepareSmartPlistWrite(plistPath: string): string {
    copyFileSync(plistPath, `${plistPath}.bak`);
    const temp = `${plistPath}.tmp-${randomUUID()}`;
    copyFileSync(plistPath, temp);
    return temp;
  }

  /** Lint the mutated temp file and atomically move it into place. */
  private commitSmartPlist(temp: string, plistPath: string): boolean {
    const lint = spawnSync("plutil", ["-lint", temp], { encoding: "utf8" });
    if (lint.status !== 0) {
      try {
        unlinkSync(temp);
      } catch {
        // best effort
      }
      return false;
    }
    renameSync(temp, plistPath);
    return true;
  }

  private buildSmartMailboxEntry(
    name: string,
    fromContains = "",
    subjectContains = "",
    bodyContains = ""
  ): any {
    const newUuid = () => randomUUID().toUpperCase();

    const userExpr = fromContains || subjectContains || bodyContains || "";
    const userHeader = fromContains ? "From" : subjectContains ? "Subject" : "Body";

    const userCriterion = {
      AllCriteriaMustBeSatisfied: true,
      Criteria: [
        {
          CriterionUniqueId: newUuid(),
          Expression: userExpr,
          Header: userHeader,
        },
      ],
      CriterionUniqueId: newUuid(),
      Header: "Compound",
      Name: "user criteria",
    };

    return {
      IMAPMailboxAttributes: 17,
      MailboxAllCriteriaMustBeSatisfied: true,
      MailboxChildren: [],
      MailboxCriteria: [
        { CriterionUniqueId: newUuid(), Header: "NotInTrashMailbox", Name: "omit trash" },
        {
          CriterionUniqueId: newUuid(),
          Header: "NotInASpecialMailbox",
          Name: "omit sent",
          SpecialMailboxType: 3,
        },
        userCriterion,
        { CriterionUniqueId: newUuid(), Header: "NotInJunkMailbox", Name: "omit junk" },
      ],
      MailboxID: newUuid(),
      MailboxName: name,
      MailboxType: 7,
    };
  }

  /**
   * List all smart mailboxes (intelligente Postfächer).
   * Reads from the synced plist (works on German + English systems).
   */
  listSmartMailboxes(): SmartMailbox[] {
    const plist = this.findSyncedSmartPlist();
    return this.readSmartMailboxEntries(plist).map((m) => ({
      name: m.name || "",
      id: m.id,
      criteriaSummary: m.criteriaSummary,
    }));
  }

  /**
   * Create a new smart mailbox with a simple contains criterion.
   * Provide at least one of fromContains / subjectContains / bodyContains.
   *
   * The new entry is appended to SyncedSmartMailboxes.plist with a lossless
   * `plutil -insert -json` on a backed-up temp copy — existing smart mailboxes
   * (including any with date/data criteria) are preserved byte-for-byte, and
   * the live file is only ever replaced by a lint-validated copy. Does NOT quit
   * or restart Mail; the new mailbox appears the next time Mail is launched.
   */
  createSmartMailbox(
    name: string,
    fromContains = "",
    subjectContains = "",
    bodyContains = ""
  ): { created: boolean; alreadyExisted: boolean; error?: string } {
    if (!name || (!fromContains && !subjectContains && !bodyContains)) {
      return {
        created: false,
        alreadyExisted: false,
        error: "Provide a name and at least one of fromContains / subjectContains / bodyContains",
      };
    }
    const plist = this.findSyncedSmartPlist();
    if (!plist) {
      return {
        created: false,
        alreadyExisted: false,
        error: "No SyncedSmartMailboxes.plist found (launch Mail at least once)",
      };
    }
    return this.createSmartMailboxAtPath(plist, name, fromContains, subjectContains, bodyContains);
  }

  /** Path-injectable core of createSmartMailbox (unit-testable against a fixture plist). */
  private createSmartMailboxAtPath(
    plistPath: string,
    name: string,
    fromContains = "",
    subjectContains = "",
    bodyContains = ""
  ): { created: boolean; alreadyExisted: boolean; error?: string } {
    const entries = this.readSmartMailboxEntries(plistPath);
    if (entries.some((e) => e.name === name)) {
      return { created: false, alreadyExisted: true };
    }
    const entry = this.buildSmartMailboxEntry(name, fromContains, subjectContains, bodyContains);
    const temp = this.prepareSmartPlistWrite(plistPath);
    const ins = spawnSync(
      "plutil",
      ["-insert", String(entries.length), "-json", JSON.stringify(entry), temp],
      { encoding: "utf8" }
    );
    if (ins.status !== 0) {
      try {
        unlinkSync(temp);
      } catch {
        // best effort
      }
      return {
        created: false,
        alreadyExisted: false,
        error: (ins.stderr || "plutil insert failed").trim(),
      };
    }
    if (!this.commitSmartPlist(temp, plistPath)) {
      return {
        created: false,
        alreadyExisted: false,
        error: "Edited plist failed validation; original left untouched",
      };
    }
    return { created: true, alreadyExisted: false };
  }

  /**
   * Delete a smart mailbox by name. Removes exactly the matching entry via
   * PlistBuddy on a backed-up temp copy; every other smart mailbox is
   * preserved. Does NOT quit or restart Mail.
   */
  deleteSmartMailbox(name: string): { deleted: boolean; error?: string } {
    const plist = this.findSyncedSmartPlist();
    if (!plist) {
      return { deleted: false, error: "No SyncedSmartMailboxes.plist found" };
    }
    return this.deleteSmartMailboxAtPath(plist, name);
  }

  /** Path-injectable core of deleteSmartMailbox (unit-testable against a fixture plist). */
  private deleteSmartMailboxAtPath(
    plistPath: string,
    name: string
  ): { deleted: boolean; error?: string } {
    const entries = this.readSmartMailboxEntries(plistPath);
    const idx = entries.findIndex((e) => e.name === name);
    if (idx < 0) {
      return { deleted: false, error: `Smart mailbox "${name}" not found` };
    }
    const temp = this.prepareSmartPlistWrite(plistPath);
    const del = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${idx}`, temp], {
      encoding: "utf8",
    });
    if (del.status !== 0) {
      try {
        unlinkSync(temp);
      } catch {
        // best effort
      }
      return { deleted: false, error: (del.stderr || "PlistBuddy delete failed").trim() };
    }
    if (!this.commitSmartPlist(temp, plistPath)) {
      return { deleted: false, error: "Edited plist failed validation; original left untouched" };
    }
    return { deleted: true };
  }

  // --- Newsletter smart mailbox discovery (high level helper) ---

  private extractEmail(sender: string): string {
    const m = /<([^>]+)>/.exec(sender || "");
    return m ? m[1].toLowerCase().trim() : (sender || "").toLowerCase().trim();
  }

  /**
   * Scan recent INBOX messages and return raw [sender, subject, source] rows.
   * This is the only AppleScript-touching part of newsletter discovery; the
   * grouping/scoring is factored into groupAndScoreNewsletters() so it can be
   * unit-tested without a running Mail.
   */
  private scanInboxRows(days: number): Array<{ sender: string; subject: string; source: string }> {
    const script = `
tell application "Mail"
  set outLines to ""
  set cutoff to (current date) - (${days} * days)
  repeat with acc in accounts
    repeat with mb in mailboxes of acc
      if name of mb is "INBOX" or name of mb is "Inbox" then
        set msgs to (messages of mb whose date received > cutoff)
        set cnt to 0
        repeat with m in msgs
          if cnt > 400 then exit repeat
          try
            set snd to (sender of m as text)
            set subj to (subject of m as text)
            set src to (source of m as text)
            set outLines to outLines & snd & "|" & subj & "|" & src & linefeed
            set cnt to cnt + 1
          end try
        end repeat
      end if
    end repeat
  end repeat
  return outLines
end tell`;
    const res = executeAppleScript(script, { timeoutMs: 120000 });
    if (!res.success || !res.output) return [];
    const rows: Array<{ sender: string; subject: string; source: string }> = [];
    for (const line of res.output.split("\n")) {
      if (!line.includes("|")) continue;
      const [snd = "", subj = "", src = ""] = line.split("|", 3);
      rows.push({ sender: snd, subject: subj, source: src });
    }
    return rows;
  }

  /**
   * Pure grouping + scoring over scanned rows. Groups by sender email, keeps
   * senders at/above minCount, and scores by volume plus newsletter signals
   * (List-Unsubscribe, noreply/newsletter keywords, repetitive subjects).
   */
  private groupAndScoreNewsletters(
    rows: Array<{ sender: string; subject: string; source: string }>,
    minCount: number
  ): Array<{
    email: string;
    sender: string;
    count: number;
    score: number;
    signals: string[];
    suggestedName: string;
  }> {
    const groups: Record<string, any> = {};
    for (const { sender: snd, subject: subj, source: src } of rows) {
      const email = this.extractEmail(snd);
      if (!email || !email.includes("@")) continue;
      if (!groups[email]) {
        groups[email] = { email, sender: snd, count: 0, subjects: [] as string[], sample: "" };
      }
      const g = groups[email];
      g.count++;
      if (g.subjects.length < 6) g.subjects.push(subj);
      if (!g.sample) g.sample = (src || "").slice(0, 3000);
    }

    const out: any[] = [];
    for (const g of Object.values(groups) as any[]) {
      if (g.count < minCount) continue;
      let score = Math.min(g.count / 3, 8);
      const blob = g.email + " " + (g.sample || "").toLowerCase();
      const signals: string[] = [];
      if (/newsletter|digest|noreply|no-reply|list-unsubscribe/.test(blob)) {
        score += 4;
        signals.push("keyword_or_list");
      }
      if (g.sample && /list-unsubscribe/i.test(g.sample)) {
        score += 3;
        signals.push("list_unsubscribe");
      }
      const prefixes = g.subjects.slice(0, 5).map((s: string) => s.slice(0, 30));
      if (prefixes.length >= 2 && new Set(prefixes).size <= 2) {
        score += 2;
        signals.push("repetitive_subject");
      }
      const short = (g.sender.split("<")[0] || g.email).trim().slice(0, 30);
      out.push({
        email: g.email,
        sender: g.sender.slice(0, 80),
        count: g.count,
        score: Math.max(0.1, Math.round(score * 10) / 10),
        signals,
        suggestedName: `NL: ${short}`,
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 50);
  }

  /**
   * Scan recent messages and return likely newsletter senders with scores.
   */
  findNewsletterCandidates(
    days = 90,
    minCount = 3
  ): Array<{
    email: string;
    sender: string;
    count: number;
    score: number;
    signals: string[];
    suggestedName: string;
  }> {
    return this.groupAndScoreNewsletters(this.scanInboxRows(days), minCount);
  }

  /**
   * High-level: discover likely newsletters from INBOX and (optionally) create smart mailboxes for them.
   */
  createNewsletterSmartMailboxes(
    dryRun = true,
    minCount = 3,
    days = 90
  ): {
    dryRun: boolean;
    createdOrProposed: any[];
    count: number;
  } {
    const cands = this.findNewsletterCandidates(days, minCount);
    const results: any[] = [];
    for (const c of cands) {
      const nm = c.suggestedName;
      if (dryRun) {
        results.push({ name: nm, email: c.email, wouldCreate: true, score: c.score });
        continue;
      }
      const r = this.createSmartMailbox(nm, c.email);
      results.push({
        name: nm,
        email: c.email,
        success: r.created || r.alreadyExisted,
        alreadyExisted: r.alreadyExisted,
        error: r.error,
        score: c.score,
      });
    }
    return { dryRun, createdOrProposed: results, count: results.length };
  }

  // ===========================================================================
  // Account Operations
  // ===========================================================================

  /**
   * List all mail accounts (uses cache).
   */
  listAccounts(options: { timeoutMs?: number } = {}): Account[] {
    return this.getCachedAccounts(options);
  }

  /**
   * listAccounts() plus whether the underlying AppleScript read actually worked.
   *
   * `failed: true` means the list is a fallback (stale cache or empty) because the
   * transport errored — NOT that Mail has no accounts. (#130)
   *
   * `timeoutMs` bounds the AppleScript read when the cache is cold, so a caller
   * working to an overall deadline can spend a known slice here instead of the
   * blanket 30s. A cache hit costs nothing and ignores it. (#135)
   */
  listAccountsChecked(options: { timeoutMs?: number } = {}): {
    accounts: Account[];
    failed: boolean;
    error?: string;
  } {
    this.lastAccountsError = null;
    const accounts = this.getCachedAccounts(options);
    const error = this.lastAccountsError;
    return error ? { accounts, failed: true, error } : { accounts, failed: false };
  }

  /**
   * getUnreadCount() plus whether the AppleScript read actually worked.
   *
   * On failure the count is `null` rather than 0, so a caller can never mistake a
   * wedged transport for an empty inbox. (#130)
   */
  getUnreadCountChecked(
    mailbox?: string,
    account?: string
  ): { count: number | null; failed: boolean; error?: string } {
    this.lastAccountsError = null;
    const count = this.getUnreadCount(mailbox, account);
    const error = this.lastAccountsError;
    return error ? { count: null, failed: true, error } : { count, failed: false };
  }

  /**
   * Fetches account list directly from Mail.app via AppleScript.
   * Used internally by the cache; prefer getCachedAccounts() or listAccounts().
   *
   * Returns `null` when the AppleScript transport itself failed (timeout, wedged
   * Mail, denied Automation). That is deliberately distinct from `[]`, which means
   * "Mail answered, and there genuinely are no accounts" — collapsing the two is
   * what let a wedged transport report a confident "No Mail accounts found". (#130)
   */
  private fetchAccounts(options: { timeoutMs?: number } = {}): Account[] | null {
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

    // `execSync` blocks the event loop, so a caller cannot bound this with a
    // Promise race — the timer would not get to fire. A caller working to a
    // deadline has to pass its remaining time down here, where it becomes
    // execSync's own (SIGKILL-backed) timeout. (#135)
    const result = executeAppleScript(
      script,
      options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}
    );

    if (!result.success) {
      console.error(`Failed to list accounts: ${result.error}`);
      this.lastAccountsError = result.error ?? "AppleScript transport failed";
      return null;
    }

    if (!result.output.trim()) return [];

    const items = result.output.split(RECORD_SEP);
    const accounts: Account[] = [];

    for (const item of items) {
      const parts = item.split(FIELD_SEP);
      if (parts.length < 3) continue;

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
  private fetchMailboxNames(account: string): string[] {
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
  listRules(): MailRule[] {
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
    const rules: MailRule[] = [];

    for (const item of items) {
      const parts = item.split(FIELD_SEP);
      if (parts.length < 2) continue;
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
  setRuleEnabled(ruleName: string, enabled: boolean): boolean {
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
  createRule(opts: RuleSpec): { success: boolean; error?: string } {
    const safeName = escapeForAppleScript(opts.name);
    if (!opts.conditions?.length) {
      return { success: false, error: "A rule needs at least one condition." };
    }
    const ruleTypeMap: Record<RuleConditionField, string> = {
      from: "from header",
      to: "to header",
      cc: "cc header",
      subject: "subject header",
      content: "message content",
    };
    const qualifierMap: Record<RuleConditionOperator, string> = {
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

    const actionStmts: string[] = [];
    const a = opts.actions ?? {};
    if (a.markRead) actionStmts.push(`        set mark read of newRule to true`);
    if (a.markFlagged) actionStmts.push(`        set mark flagged of newRule to true`);
    if (a.delete) actionStmts.push(`        set delete message of newRule to true`);
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

    const enabled = opts.enabled === true;
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
  deleteRule(ruleName: string): boolean {
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
   * Search contacts by name, organization, nickname, or email address.
   *
   * Reads the macOS Contacts (AddressBook) SQLite databases directly via Full
   * Disk Access — it does NOT drive Contacts.app over AppleScript, so it raises
   * no Automation / Apple-Events permission prompt (the old path would hang on
   * that unanswerable prompt on headless/scheduled hosts). See
   * {@link searchContactsDb}.
   */
  searchContacts(query: string): Contact[] {
    return searchContactsDb(query);
  }

  // ===========================================================================
  // Email Templates
  // ===========================================================================

  // Templates persist to disk (B3 / #14) so they survive server restarts.
  private templateStore = new TemplateStore();

  /**
   * List all stored templates.
   */
  listTemplates(): EmailTemplate[] {
    return this.templateStore.list();
  }

  /**
   * Get a template by ID.
   */
  getTemplate(id: string): EmailTemplate | null {
    return this.templateStore.get(id);
  }

  /**
   * Create or update a template (persisted).
   */
  saveTemplate(
    name: string,
    subject: string,
    body: string,
    to?: string[],
    cc?: string[],
    id?: string
  ): EmailTemplate {
    return this.templateStore.save(name, subject, body, to, cc, id);
  }

  /**
   * Delete a template (persisted).
   */
  deleteTemplate(id: string): boolean {
    return this.templateStore.delete(id);
  }

  /**
   * Use a template to create a draft.
   */
  useTemplate(
    id: string,
    overrides?: { to?: string[]; cc?: string[]; subject?: string; body?: string }
  ): boolean {
    const template = this.templateStore.get(id);
    if (!template) return false;

    // Use `??` (not `||`) for subject/body so an intentional empty-string
    // override is honored rather than falling back to the template value
    // (audit finding #14).
    const to = overrides?.to ?? template.to ?? [];
    const cc = overrides?.cc ?? template.cc;
    const subject = overrides?.subject ?? template.subject;
    const body = overrides?.body ?? template.body;

    if (to.length === 0) return false;

    return this.createDraft(to, subject, body, cc);
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
      const errorHint = isPermissionDenied(mailCheck.error)
        ? " (check System Settings > Privacy & Security > Automation)"
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
      const isPermError = isPermissionDenied(permCheck.error);
      checks.push({
        name: "permissions",
        passed: !isPermError,
        message: isPermError
          ? "AppleScript permissions denied. Grant access in System Settings > Privacy & Security > Automation"
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
   * Counts messages in each account's receiving mailbox for performance
   * (scanning all mailboxes is too slow for large accounts): the literal
   * "INBOX" for ordinary accounts, or the "All Mail" superset for Gmail-style
   * accounts whose literal "INBOX" is an empty virtual shell (BUG A2).
   *
   * @returns Counts of messages received in last 24h, 7d, and 30d
   */
  getRecentlyReceivedStats(): RecentlyReceivedStats {
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

    // Scan each account's receiving mailbox for performance — scanning every
    // mailbox is too slow. For an ordinary account that's the literal "INBOX".
    // For a Gmail-style account (BUG A2) the literal "INBOX" is an empty shell,
    // so counting only it reported near-zero recent mail; instead we detect the
    // "All Mail" special mailbox (matched by `name of mb`, since it's nested in
    // the [Gmail] container and doesn't resolve by a flat name) and count that
    // superset of received mail.
    //
    // A `whose date received >=` filter is O(n) over the whole mailbox with no
    // AppleScript index, so on a huge "All Mail" (tens of thousands of messages)
    // three such counts blow past any reasonable timeout. Two safeguards keep
    // this fast and non-hanging:
    //   - a per-mailbox COUNT GUARD (the same APPLE_MAIL_MAX_SEARCH_MAILBOX
    //     threshold search uses): a receiving mailbox above the threshold is
    //     skipped rather than scanned. IMAP-configured accounts already get
    //     fast, correct recent counts via IMAP SEARCH SINCE upstream, so the
    //     skip only affects an un-IMAP-configured huge Gmail account — which
    //     previously also reported 0 here, just after a 60 s hang.
    //   - a single 30-day `whose` pass whose small result set is partitioned
    //     in-AppleScript into 24 h / 7 d / 30 d buckets — one O(n) scan, not
    //     three.
    const scanThreshold = getMailboxScanThreshold();
    const gmailNameList = appleScriptLowerNameList(["all mail"]);
    const countGuard =
      scanThreshold > 0
        ? `if (count of messages of theInbox) > ${scanThreshold} then error "too-large"`
        : "";
    // One 30-day pass, then bucket the (small) result by date without rescanning.
    const bucketScan = `
            ${countGuard}
            set recent30 to (messages of theInbox whose date received >= thirtyDaysAgo)
            repeat with _m in recent30
              set _d to date received of _m
              set last30d to last30d + 1
              if _d >= sevenDaysAgo then set last7d to last7d + 1
              if _d >= oneDayAgo then set last24h to last24h + 1
            end repeat`;
    const script = buildAppLevelScript(`
      set last24h to 0
      set last7d to 0
      set last30d to 0
      ${buildAppleScriptDate("oneDayAgo", oneDayAgo)}
      ${buildAppleScriptDate("sevenDaysAgo", sevenDaysAgo)}
      ${buildAppleScriptDate("thirtyDaysAgo", thirtyDaysAgo)}

      repeat with acct in accounts
        try
          -- Detect a Gmail-style account (has an "All Mail" special mailbox);
          -- if so, count its receiving superset instead of the empty "INBOX".
          set _gmailInbox to missing value
          set _wantNames to ${gmailNameList}
          repeat with mb in mailboxes of acct
            set mbName to ""
            try
              set mbName to name of mb
            end try
            ignoring case
              if _wantNames contains mbName then
                set _gmailInbox to mb
                exit repeat
              end if
            end ignoring
          end repeat

          if _gmailInbox is not missing value then
            try
              set theInbox to _gmailInbox
              ${bucketScan}
            end try
          else
            -- Ordinary account: try common inbox names.
            set inboxNames to {"INBOX", "Inbox", "inbox"}
            repeat with inboxName in inboxNames
              try
                set theInbox to mailbox inboxName of acct
                ${bucketScan}
                exit repeat
              end try
            end repeat
          end if
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
