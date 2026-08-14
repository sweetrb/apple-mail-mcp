/**
 * Executable coverage for the batch tool wiring (#156 item 4).
 *
 * Before this, `sourceMailbox`/`sourceAccount` were forwarded from the tool
 * schema into the manager by code that no test could load — `index.ts` opens a
 * stdio transport at import. Swapping the two, or dropping one, passed the
 * entire suite. These tests assert the forwarding itself.
 */
import { describe, it, expect, vi } from "vitest";
import {
  runBatchDelete,
  runBatchMove,
  toManagerScope,
  type BatchMutationDeps,
} from "@/tools/batchMutations.js";

function deps(overrides: Partial<BatchMutationDeps> = {}) {
  const batchDeleteMessages = vi.fn((ids: string[]) => ids.map((id) => ({ id, success: true })));
  const batchMoveMessages = vi.fn((ids: string[]) => ids.map((id) => ({ id, success: true })));
  const imapBatchDelete = vi.fn(async () => ({ success: 0, failed: 0, fail: 0, errors: [] }));
  const imapBatchMove = vi.fn(async () => ({ success: 0, failed: 0, fail: 0, errors: [] }));
  const collectForensics = vi.fn(() => ({ warnings: [] as string[] }));
  return {
    batchDeleteMessages,
    batchMoveMessages,
    imapBatchDelete,
    imapBatchMove,
    collectForensics,
    ...overrides,
  } as unknown as BatchMutationDeps & {
    batchDeleteMessages: ReturnType<typeof vi.fn>;
    batchMoveMessages: ReturnType<typeof vi.fn>;
    imapBatchMove: ReturnType<typeof vi.fn>;
  };
}

describe("toManagerScope", () => {
  it("maps sourceAccount -> account and sourceMailbox -> mailbox", () => {
    expect(toManagerScope({ sourceAccount: "Work", sourceMailbox: "INBOX" })).toEqual({
      account: "Work",
      mailbox: "INBOX",
    });
  });

  it("does not transpose the two fields", () => {
    const scope = toManagerScope({ sourceAccount: "Work", sourceMailbox: "Archive" });
    expect(scope.account).toBe("Work");
    expect(scope.mailbox).toBe("Archive");
  });

  it("leaves both undefined when neither is supplied", () => {
    expect(toManagerScope({})).toEqual({ account: undefined, mailbox: undefined });
  });
});

describe("batch-delete-messages wiring", () => {
  it("forwards sourceMailbox/sourceAccount into the manager as a scope pair", async () => {
    const d = deps();
    await runBatchDelete(d, {
      ids: ["101", "102"],
      sourceMailbox: "INBOX",
      sourceAccount: "iCloud",
    });

    expect(d.batchDeleteMessages).toHaveBeenCalledTimes(1);
    const [ids, scope] = d.batchDeleteMessages.mock.calls[0];
    expect(ids).toEqual(["101", "102"]);
    expect(scope).toEqual({ account: "iCloud", mailbox: "INBOX" });
  });

  it("passes an unscoped call through as both-undefined, not as a partial scope", async () => {
    const d = deps();
    await runBatchDelete(d, { ids: ["101"] });
    expect(d.batchDeleteMessages.mock.calls[0][1]).toEqual({
      account: undefined,
      mailbox: undefined,
    });
  });

  it("surfaces reconciliation warnings from the forensics report", async () => {
    const d = deps({
      collectForensics: () => ({ warnings: ['⚠️ Effect mismatch in "INBOX"'] }),
    } as Partial<BatchMutationDeps>);
    const res = await runBatchDelete(d, {
      ids: ["101"],
      sourceMailbox: "INBOX",
      sourceAccount: "A",
    });
    expect(JSON.stringify(res)).toContain("Effect mismatch");
  });
});

describe("batch-move-messages wiring", () => {
  it("keeps the destination account distinct from the source scope", async () => {
    const d = deps();
    await runBatchMove(d, {
      ids: ["201"],
      mailbox: "Archive",
      account: "Destination",
      sourceMailbox: "INBOX",
      sourceAccount: "Source",
    });

    const [ids, mailbox, account, scope] = d.batchMoveMessages.mock.calls[0];
    expect(ids).toEqual(["201"]);
    expect(mailbox).toBe("Archive");
    // The DESTINATION account — conflating this with sourceAccount would move
    // messages out of the wrong account entirely.
    expect(account).toBe("Destination");
    expect(scope).toEqual({ account: "Source", mailbox: "INBOX" });
  });

  it("routes imap: ids to the IMAP path with the destination account only", async () => {
    const d = deps();
    await runBatchMove(d, {
      ids: ["imap:a/INBOX/7"],
      mailbox: "Archive",
      account: "Destination",
      sourceMailbox: "INBOX",
      sourceAccount: "Source",
    });
    expect(d.imapBatchMove).toHaveBeenCalledWith(["imap:a/INBOX/7"], "Archive", {
      account: "Destination",
    });
  });
});
