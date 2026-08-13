/**
 * Regression guard for #152 — by-id mutations must target the mailbox the id
 * was listed from.
 *
 * A Mail.app numeric message id is unique only *within a mailbox*, and a label
 * store (Gmail, iCloud) exposes ONE message in several mailboxes under the SAME
 * id: on a real account, id 75816 is reported by "Important", "All Mail" AND
 * "INBOX" for the same mail. The old implementation walked every account's every
 * mailbox and applied the operation to the FIRST match; `mailboxes of account`
 * yields INBOX late, so a batch of ids listed from INBOX was reliably applied to
 * the "Important" copies instead — every id reported `ok` while the INBOX
 * messages stayed put and other copies were moved/deleted.
 *
 * These tests assert the generated AppleScript is mailbox-scoped, and that the
 * unscoped first-match-wins walk is gone. executeAppleScript is fully mocked, so
 * no running Mail.app is needed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";
const DIAG_MARKER = "\x1dDIAG\x1d";
const DIAG_FIELD_SEP = "\x1dF\x1d";

const h = vi.hoisted(() => ({ calls: [] as string[] }));

/** A list-messages payload: two ids, six fields each (mailbox = the one asked for). */
function listPayload(ids: string[]): string {
  const rows = ids
    .map((id) =>
      [
        id,
        "Subject",
        "sender@example.com",
        "Monday, January 1, 2026 at 0:00:00",
        "false",
        "false",
      ].join(FIELD_SEP)
    )
    .join(RECORD_SEP);
  return `${rows}${DIAG_MARKER}timedOut=false${DIAG_FIELD_SEP}skipped=${DIAG_FIELD_SEP}notSearched=`;
}

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string) => {
      h.calls.push(script);
      // The list script is the only one that builds `outputText`; everything
      // else (mutations) just needs a benign success.
      const output = script.includes("outputText") ? listPayload(["75816", "75791"]) : "ok";
      return { success: true, output, error: undefined as string | undefined };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

const lastScript = () => h.calls[h.calls.length - 1] ?? "";

describe("#152 — by-id mutations are scoped to the source mailbox", () => {
  let mgr: AppleMailManager;

  beforeEach(() => {
    h.calls.length = 0;
    mgr = new AppleMailManager();
    // Seed the id→location index the way real usage does: list the mailbox
    // first, which is exactly the reporter's flow (list INBOX, then batch-op).
    mgr.listMessages("INBOX", "me@example.com", 50);
  });

  it("batch delete opens the listed mailbox instead of walking every mailbox", () => {
    mgr.batchDeleteMessages(["75816", "75791"]);
    const s = lastScript();

    // Scoped: resolves one specific account+mailbox into _tmb, then operates there.
    expect(s).toContain("set _tmb to missing value");
    expect(s).toContain('"INBOX"');
    expect(s).toContain('"me@example.com"');
    expect(s).toContain("messages of _tmb whose id is");
    expect(s).toContain("delete _msg");

    // The pre-fix bug: applying the op to the first hit found while iterating
    // every mailbox of every account. That shape must not reappear.
    expect(s).not.toContain("set _m to (messages of mb whose id is _theId)");
  });

  it("batch move scopes the SOURCE lookup while still resolving the destination", () => {
    mgr.batchMoveMessages(["75816"], "Archive", "me@example.com");
    const s = lastScript();

    expect(s).toContain("set _tmb to missing value");
    expect(s).toContain("messages of _tmb whose id is");
    expect(s).toContain("move _msg to destMailbox");
    // Destination resolution (the pre-existing, correct half) is untouched.
    expect(s).toContain("set destMailbox to item 1 of destMatches");
  });

  it("single delete is scoped the same way as the batch path", () => {
    mgr.deleteMessage("75816");
    const s = lastScript();

    expect(s).toContain("set _tmb to missing value");
    expect(s).toContain("messages of _tmb whose id is 75816");
    expect(s).toContain("delete msg");
    // Old shape: unscoped `repeat with mb in mailboxes of acct` around the op.
    expect(s).not.toContain("messages of mb whose id is 75816");
  });

  it("single move is scoped to the mailbox the id was listed from", () => {
    mgr.moveMessage("75791", "Archive", "me@example.com");
    const s = lastScript();

    expect(s).toContain("set _tmb to missing value");
    expect(s).toContain("messages of _tmb whose id is 75791");
    expect(s).not.toContain("messages of mb whose id is 75791");
  });

  it("an id with no recorded mailbox is refused when ambiguous, never guessed", () => {
    // 999 was never listed, so there is no source mailbox to scope to.
    mgr.batchDeleteMessages(["999"]);
    const s = lastScript();

    // It counts every mailbox holding the id...
    expect(s).toContain("set item _k of _uhit to ((item _k of _uhit) + 1)");
    // ...and refuses rather than acting when more than one does.
    expect(s).toContain("is present in more than one mailbox");
    // The op is still reachable for the unambiguous single-hit case.
    expect(s).toContain("delete _msg");
  });

  it("single-op with an unrecorded id also refuses ambiguity instead of first-match", () => {
    mgr.deleteMessage("999");
    const s = lastScript();

    expect(s).toContain("if (count of _hits) > 1 then");
    expect(s).toContain("is present in more than one mailbox");
  });

  it("mixes located and unlocated ids in one batch without losing either", () => {
    mgr.batchMarkAsRead(["75816", "999"]);
    const s = lastScript();

    // Located id → scoped block; unlocated id → ambiguity-checked block.
    expect(s).toContain("set _tmb to missing value");
    expect(s).toContain("is present in more than one mailbox");
    // Positions are what map results back to input order — both must appear.
    expect(s).toContain("set _gpos to {1}");
    expect(s).toContain("set _upos to {2}");
  });
});
