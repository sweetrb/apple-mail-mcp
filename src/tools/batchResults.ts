/**
 * Batch tool result plumbing: run a batch across both backends, then turn the
 * counts + per-id failure reasons into one MCP response.
 *
 * Extracted from index.ts so the six batch tools share ONE shaping path (they
 * had six copies of the same three-branch block, and the branches had drifted),
 * and so this half is unit-testable at all — index.ts connects a stdio transport
 * at import time, so nothing in it can be imported by a test.
 *
 * @module tools/batchResults
 */
import { successResponse, errorResponse, type ToolResponse } from "@/tools/respond.js";
import type { ImapBatchResult } from "@/services/imapClient.js";

/**
 * Split a batch of ids into numeric (AppleScript) and imap: (IMAP) groups, run
 * each path, and merge into success/fail counts (I2). imap: ids apply in a
 * single UID command per mailbox; numeric ids use the existing AppleScript batch.
 *
 * A batch is a SET of messages: a repeated id names the same message, so it is
 * operated on — and counted — once. Deduping here makes that true for both
 * backends at the tool boundary, and keeps `success` a count of messages rather
 * than of list positions. (The AppleScript path dedupes again on the numeric
 * value it actually sends, where the #155 effect reconciliation needs it: two
 * occurrences of one id would otherwise make `expected` disagree with the
 * mailbox and fire the always-on warning on a correct delete.)
 */
export async function hybridBatchCounts(
  ids: string[],
  appleFn: (numericIds: string[]) => { success: boolean; error?: string }[],
  imapFn: (imapIds: string[]) => Promise<ImapBatchResult>
): Promise<{ success: number; fail: number; errors: string[] }> {
  const distinctIds = [...new Set(ids)];
  const imapIds = distinctIds.filter((i) => i.startsWith("imap:"));
  const numericIds = distinctIds.filter((i) => !i.startsWith("imap:"));
  let success = 0;
  let fail = 0;
  const errors: string[] = [];
  if (numericIds.length > 0) {
    const res = appleFn(numericIds);
    const s = res.filter((r) => r.success).length;
    success += s;
    fail += res.length - s;
    // Surface WHY an id failed. These were dropped before, so an id the batch
    // refused as ambiguous (#152) showed up only as an anonymous failure count.
    errors.push(...res.filter((r) => !r.success && r.error).map((r) => r.error as string));
  }
  if (imapIds.length > 0) {
    const r = await imapFn(imapIds);
    success += r.success;
    fail += r.failed;
    errors.push(...r.errors);
  }
  return { success, fail, errors };
}

/** The distinct, non-empty failure reasons, in first-seen order. */
function distinctErrors(errors: string[]): string[] {
  return [...new Set(errors.filter(Boolean))];
}

/** Append the distinct per-id failure reasons to a batch summary line, capped so
 *  a 100-id batch can't produce an unreadable wall of text. */
export function formatBatchErrors(errors: string[], max = 5): string {
  const distinct = distinctErrors(errors);
  if (distinct.length === 0) return "";
  const shown = distinct.slice(0, max);
  const more = distinct.length - shown.length;
  return `: ${shown.join("; ")}${more > 0 ? ` (+${more} more)` : ""}`;
}

/**
 * Cap on `errors` in `structuredContent`.
 *
 * The reasons are per-id, so an all-ambiguous 100-id batch produced 100 strings
 * — each naming every mailbox holding that id — while the text channel showed 5.
 * Deduping collapses the common case (one reason repeated); this bounds the
 * pathological one (every id ambiguous in a different set of mailboxes). Higher
 * than the text cap on purpose: a program can use more detail than a summary
 * line can carry. When it bites, `errorsTruncated: true` says so, rather than
 * letting a caller read a short list as the whole story.
 */
export const MAX_STRUCTURED_BATCH_ERRORS = 20;

/**
 * Shape a completed batch into its MCP response: text for humans, and the same
 * facts as `structuredContent` for programs.
 *
 * All three outcomes carry `structuredContent`, INCLUDING the all-failed one.
 * That branch used to answer with text only, so the single outcome a caller most
 * needs to act on was the one it could not read from the typed channel.
 *
 * `warnings` (the always-on effect reconciliation, #155) is appended to the text
 * on its own lines and NEVER changes the success/failure verdict: by the time it
 * is known the mutation has already happened, and the point is to report it
 * truthfully, not to fail retroactively.
 */
export function batchResponse(
  counts: { success: number; fail: number; errors: string[] },
  messages: {
    allSucceeded: (succeeded: number) => string;
    allFailed: (failed: number) => string;
    partial: (succeeded: number, failed: number) => string;
  },
  extra: Record<string, unknown> = {},
  warnings: string[] = []
): ToolResponse {
  const { success, fail, errors } = counts;
  const distinct = distinctErrors(errors);
  const reported = distinct.slice(0, MAX_STRUCTURED_BATCH_ERRORS);
  const structured: Record<string, unknown> = {
    ok: fail === 0,
    success,
    failed: fail,
    ...extra,
    ...(reported.length > 0 ? { errors: reported } : {}),
    ...(distinct.length > reported.length ? { errorsTruncated: true } : {}),
  };
  const suffix = formatBatchErrors(distinct);
  const warn = warnings.length > 0 ? `\n\n${warnings.join("\n")}` : "";

  if (fail === 0) return successResponse(`${messages.allSucceeded(success)}${warn}`, structured);
  if (success === 0)
    return errorResponse(`${messages.allFailed(fail)}${suffix}${warn}`, structured);
  return successResponse(`${messages.partial(success, fail)}${suffix}${warn}`, structured);
}
