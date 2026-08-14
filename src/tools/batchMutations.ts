/**
 * The two destructive batch tool handlers, lifted out of `index.ts` so the
 * wiring between the tool schema and the manager is executable in a test.
 *
 * Why this module exists (#156 item 4): `batch-delete-messages` and
 * `batch-move-messages` grew `sourceMailbox`/`sourceAccount` in #154 and had
 * their meaning tightened in #159 — but nothing exercised `index.ts` actually
 * *forwarding* those two fields into the manager. `index.ts` opens a stdio
 * transport at import, so no unit test can load it; the forwarding was verified
 * by reading the code. A silent swap of the two arguments, or dropping one,
 * would have passed the whole suite.
 *
 * The fix is the move #154 already made for `batchResults`: keep the handler
 * body here, behind an injected dependency bundle, and let `index.ts` supply the
 * real manager. The scope-forwarding contract is then a normal assertion.
 */
import type { BatchOperationResult } from "@/types.js";
import type { ToolResponse } from "@/tools/respond.js";
import type { ImapBatchResult } from "@/services/imapClient.js";
import { hybridBatchCounts, batchResponse } from "@/tools/batchResults.js";

/** The source scope a caller pins numeric ids to. Both fields or neither (#159). */
export interface BatchSourceScope {
  account?: string;
  mailbox?: string;
}

/** Forensic material a destructive batch produces (#155/#157). */
export interface BatchForensics {
  countDelta?: unknown;
  warnings: string[];
}

/**
 * Everything the handlers need from the module graph `index.ts` owns. Injected
 * rather than imported so a test can drive the handler without a live Mail.app,
 * an audit-log file, or a stdio transport.
 */
export interface BatchMutationDeps {
  batchDeleteMessages(ids: string[], scope: BatchSourceScope): BatchOperationResult[];
  batchMoveMessages(
    ids: string[],
    mailbox: string,
    account: string | undefined,
    scope: BatchSourceScope
  ): BatchOperationResult[];
  imapBatchDelete(ids: string[]): Promise<ImapBatchResult>;
  imapBatchMove(
    ids: string[],
    mailbox: string,
    opts: { account?: string }
  ): Promise<ImapBatchResult>;
  collectForensics(tool: string, args: Record<string, unknown>): BatchForensics;
}

/**
 * `sourceMailbox`/`sourceAccount` as the manager expects them.
 *
 * Named and exported so the mapping is a thing a test can point at: the tool
 * argument is `sourceAccount`, the manager field is `account`, and getting that
 * transposition wrong is exactly the defect class #154 and #159 were about.
 */
export function toManagerScope(args: {
  sourceAccount?: string;
  sourceMailbox?: string;
}): BatchSourceScope {
  return { account: args.sourceAccount, mailbox: args.sourceMailbox };
}

/** `batch-delete-messages`. */
export async function runBatchDelete(
  deps: BatchMutationDeps,
  args: { ids: string[]; sourceMailbox?: string; sourceAccount?: string }
): Promise<ToolResponse> {
  const { ids, sourceMailbox, sourceAccount } = args;
  let forensics: BatchForensics = { warnings: [] };
  const counts = await hybridBatchCounts(
    ids,
    (n) => {
      const res = deps.batchDeleteMessages(n, toManagerScope({ sourceAccount, sourceMailbox }));
      forensics = deps.collectForensics("batch-delete-messages", {
        ids,
        sourceMailbox,
        sourceAccount,
      });
      return res;
    },
    (im) => deps.imapBatchDelete(im)
  );
  return batchResponse(
    counts,
    {
      allSucceeded: (n) => `Successfully deleted ${n} message(s)`,
      allFailed: (n) => `Failed to delete all ${n} message(s)`,
      partial: (ok, failed) => `Deleted ${ok} message(s), ${failed} failed`,
    },
    forensics.countDelta ? { countDelta: forensics.countDelta } : {},
    forensics.warnings
  );
}

/** `batch-move-messages`. */
export async function runBatchMove(
  deps: BatchMutationDeps,
  args: {
    ids: string[];
    mailbox: string;
    account?: string;
    sourceMailbox?: string;
    sourceAccount?: string;
  }
): Promise<ToolResponse> {
  const { ids, mailbox, account, sourceMailbox, sourceAccount } = args;
  let forensics: BatchForensics = { warnings: [] };
  const counts = await hybridBatchCounts(
    ids,
    (n) => {
      // `account` is the DESTINATION account; `sourceAccount` pins where the ids
      // were listed FROM. They are different arguments and must not be conflated.
      const res = deps.batchMoveMessages(
        n,
        mailbox,
        account,
        toManagerScope({ sourceAccount, sourceMailbox })
      );
      forensics = deps.collectForensics("batch-move-messages", {
        ids,
        mailbox,
        account,
        sourceMailbox,
        sourceAccount,
      });
      return res;
    },
    (im) => deps.imapBatchMove(im, mailbox, { account })
  );
  return batchResponse(
    counts,
    {
      allSucceeded: (n) => `Successfully moved ${n} message(s) to "${mailbox}"`,
      allFailed: (n) => `Failed to move all ${n} message(s)`,
      partial: (ok, failed) => `Moved ${ok} message(s) to "${mailbox}", ${failed} failed`,
    },
    { mailbox, ...(forensics.countDelta ? { countDelta: forensics.countDelta } : {}) },
    forensics.warnings
  );
}
