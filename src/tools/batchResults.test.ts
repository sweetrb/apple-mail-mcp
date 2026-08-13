/**
 * The error-surfacing half of the #152/#153 follow-up.
 *
 * 2.10.15 gave a batch a real diagnostic — an id that matches in several
 * mailboxes is refused, naming every mailbox that holds it — and then threw the
 * string away: `hybridBatchCounts` kept only a count, so the caller saw
 * "Deleted 22 message(s), 2 failed" and had no way to learn which ids were
 * refused or what to do next. These tests pin the whole path from a per-id
 * BatchOperationResult to what the client actually receives, in BOTH channels
 * (text and structuredContent), because a fix that reaches only one of them is
 * how this shipped half-done the first time.
 */
import { describe, it, expect } from "vitest";
import {
  hybridBatchCounts,
  formatBatchErrors,
  batchResponse,
  MAX_STRUCTURED_BATCH_ERRORS,
} from "@/tools/batchResults.js";

/** The real refusal text runBatchOperation emits for an ambiguous numeric id. */
const ambiguous = (mailboxes: string) =>
  `This message id is present in more than one mailbox (${mailboxes}); ` +
  `list or search that mailbox first so the operation targets the right copy`;

const DELETE_MESSAGES = {
  allSucceeded: (n: number) => `Successfully deleted ${n} message(s)`,
  allFailed: (n: number) => `Failed to delete all ${n} message(s)`,
  partial: (ok: number, failed: number) => `Deleted ${ok} message(s), ${failed} failed`,
};

const text = (res: ReturnType<typeof batchResponse>): string => res.content[0].text;
const structured = (res: ReturnType<typeof batchResponse>): Record<string, unknown> | undefined =>
  (res as { structuredContent?: Record<string, unknown> }).structuredContent;

const noImap = () => Promise.resolve({ success: 0, failed: 0, errors: [] });

describe("hybridBatchCounts — per-id reasons survive the count", () => {
  it("carries each AppleScript failure's reason, not just the tally", async () => {
    const counts = await hybridBatchCounts(
      ["1", "2", "3"],
      () => [
        { success: true },
        { success: false, error: "Message not found" },
        { success: false, error: ambiguous("acct/INBOX, acct/[Gmail]/All Mail, ") },
      ],
      noImap
    );

    expect(counts).toMatchObject({ success: 1, fail: 2 });
    expect(counts.errors).toHaveLength(2);
    expect(counts.errors[1]).toContain("present in more than one mailbox");
  });

  it("merges the IMAP path's errors with the AppleScript path's", async () => {
    const counts = await hybridBatchCounts(
      ["1", "imap:abc"],
      () => [{ success: false, error: "Message not found" }],
      () => Promise.resolve({ success: 0, failed: 1, errors: ["imap: mailbox gone"] })
    );

    expect(counts.fail).toBe(2);
    expect(counts.errors).toEqual(["Message not found", "imap: mailbox gone"]);
  });

  it("does not invent an entry for a failure with no reason attached", async () => {
    const counts = await hybridBatchCounts(["1"], () => [{ success: false }], noImap);
    expect(counts).toEqual({ success: 0, fail: 1, errors: [] });
  });
});

describe("formatBatchErrors — the human-readable tail", () => {
  it("appends the distinct reasons", () => {
    expect(formatBatchErrors(["a", "b", "a"])).toBe(": a; b");
  });

  it("caps at 5 distinct reasons and says how many were withheld", () => {
    const out = formatBatchErrors(["a", "b", "c", "d", "e", "f", "g"]);
    expect(out).toBe(": a; b; c; d; e (+2 more)");
  });

  it("contributes nothing when there is nothing to say", () => {
    expect(formatBatchErrors([])).toBe("");
    expect(formatBatchErrors(["", ""])).toBe("");
  });
});

describe("batchResponse — what the caller actually receives", () => {
  it("reports reasons in BOTH channels on a partial batch", () => {
    const res = batchResponse(
      { success: 22, fail: 2, errors: ["Message not found", "Message not found"] },
      DELETE_MESSAGES
    );

    expect(text(res)).toBe("Deleted 22 message(s), 2 failed: Message not found");
    expect(structured(res)).toMatchObject({
      ok: false,
      success: 22,
      failed: 2,
      errors: ["Message not found"],
    });
  });

  it("gets the ambiguous-id refusal all the way to the caller", () => {
    const reason = ambiguous(
      "rob@superiortech.io/[Gmail]/All Mail, rob@superiortech.io/Sales Spam, "
    );
    const res = batchResponse({ success: 1, fail: 1, errors: [reason] }, DELETE_MESSAGES);

    expect(text(res)).toContain("Sales Spam");
    expect(text(res)).toContain("list or search that mailbox first");
    expect((structured(res)?.errors as string[])[0]).toBe(reason);
  });

  // The all-fail branch used to call errorResponse(msg) with no structured
  // payload, so `errors` existed in the text and nowhere in structuredContent —
  // a client reading only the typed channel learned nothing at all from the
  // worst outcome of the three.
  it("still returns structuredContent when EVERY id fails", () => {
    const reason = ambiguous("acct/INBOX, acct/[Gmail]/Important, ");
    const res = batchResponse(
      { success: 0, fail: 3, errors: [reason, reason, reason] },
      DELETE_MESSAGES
    );

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text(res)).toContain("Failed to delete all 3 message(s)");
    expect(text(res)).toContain("present in more than one mailbox");
    expect(structured(res)).toMatchObject({ ok: false, success: 0, failed: 3 });
    expect(structured(res)?.errors).toEqual([reason]);
  });

  it("dedupes the structured errors instead of repeating one reason per id", () => {
    const res = batchResponse(
      { success: 0, fail: 100, errors: Array.from({ length: 100 }, () => "Message not found") },
      DELETE_MESSAGES
    );

    expect(structured(res)?.errors).toEqual(["Message not found"]);
    expect(structured(res)?.errorsTruncated).toBeUndefined();
  });

  it("caps the structured errors so a 100-id batch cannot emit 100 long strings", () => {
    const errors = Array.from({ length: 100 }, (_, i) => ambiguous(`acct/Mailbox ${i}, `));
    const res = batchResponse({ success: 0, fail: 100, errors }, DELETE_MESSAGES);

    const reported = structured(res)?.errors as string[];
    expect(reported).toHaveLength(MAX_STRUCTURED_BATCH_ERRORS);
    expect(reported).toEqual(errors.slice(0, MAX_STRUCTURED_BATCH_ERRORS));
    expect(structured(res)?.errorsTruncated).toBe(true);
  });

  it("omits the errors key entirely on a clean run, and carries tool extras", () => {
    const res = batchResponse({ success: 5, fail: 0, errors: [] }, DELETE_MESSAGES, {
      mailbox: "Archive",
    });

    expect((res as { isError?: boolean }).isError).toBeUndefined();
    expect(text(res)).toBe("Successfully deleted 5 message(s)");
    expect(structured(res)).toEqual({ ok: true, success: 5, failed: 0, mailbox: "Archive" });
  });
});
