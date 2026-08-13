/**
 * Regression tests for #152 — batch operations mutating the WRONG message.
 *
 * A Mail.app numeric id can match in more than one mailbox (Gmail-over-IMAP
 * label aliasing makes one message reachable through INBOX, [Gmail]/All Mail
 * and [Gmail]/Important at once). The old `runBatchOperation` applied its
 * operation to `item 1` of the FIRST mailbox the account/mailbox walk happened
 * to reach and then reported `ok`, so a batch could mutate the All Mail copy of
 * a message the caller had listed from another mailbox — and still claim
 * success.
 *
 * executeAppleScript is mocked, so nothing here touches a real Mail.app. Rather
 * than assert on script text alone, the mock is a small INTERPRETER: it reads
 * the id/scope list literals out of the generated script, replays the same
 * account→mailbox walk against a fake tree, and records which (mailbox, id) the
 * operation would actually have been applied to. That is what lets these tests
 * distinguish "operated on the intended message" from "operated on some message
 * with that id".
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

/** Fake account→mailbox→ids tree, in Mail's own (unsorted) walk order. */
type Tree = { account: string; mailboxes: { name: string; ids: string[] }[] }[];

const h = vi.hoisted(() => ({
  scripts: [] as string[],
  /** (mailbox, id) pairs the batch actually applied its operation to. */
  applied: [] as { account: string; mailbox: string; id: string }[],
  tree: [] as Tree,
}));

const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";
const DIAG_ITEM_SEP = "\x1dM\x1d";

/** Pull `set _name to {a, b, c}` / `{"a", "b"}` list literals out of the script. */
function readList(script: string, name: string): string[] {
  const m = new RegExp(`set ${name} to \\{([^}]*)\\}`).exec(script);
  if (!m) return [];
  const body = m[1].trim();
  if (!body) return [];
  return body.split(",").map((s) => s.trim().replace(/^"/, "").replace(/"$/, ""));
}

/**
 * Replay the batch walk the way Mail would, and produce the same
 * `position<FS>status<RS>` output the real script returns.
 */
function interpretBatch(script: string): string {
  const ids = readList(script, "_ids");
  // A script with no `_sAcct` list is the pre-#152 shape: no per-id scope at
  // all. Emulating it here (rather than only the fixed shape) is what lets
  // these tests be run against the broken implementation to confirm they fail.
  const legacy = !script.includes("set _sAcct to");
  const sAcct = legacy ? [] : readList(script, "_sAcct");
  const sMb = legacy ? [] : readList(script, "_sMb");
  let out = "";

  ids.forEach((id, i) => {
    const wantA = sAcct[i] ?? "";
    const wantM = sMb[i] ?? "";
    const hits: { account: string; mailbox: string }[] = [];

    for (const acct of h.tree) {
      for (const mb of acct.mailboxes) {
        if (wantA) {
          if (acct.account.toLowerCase() !== wantA.toLowerCase()) continue;
          if (mb.name.toLowerCase() !== wantM.toLowerCase()) continue;
        }
        if (mb.ids.includes(id)) hits.push({ account: acct.account, mailbox: mb.name });
      }
    }

    const pos = i + 1;
    if (legacy) {
      // Pre-#152: apply to the FIRST mailbox the walk matches, report ok.
      if (hits.length === 0) {
        out += `${pos}${FIELD_SEP}notfound${RECORD_SEP}`;
      } else {
        h.applied.push({ account: hits[0].account, mailbox: hits[0].mailbox, id });
        out += `${pos}${FIELD_SEP}ok${RECORD_SEP}`;
      }
      return;
    }
    if (hits.length === 0) {
      out += `${pos}${FIELD_SEP}notfound${RECORD_SEP}`;
    } else if (!wantA && hits.length > 1) {
      // Unscoped and ambiguous: the real script refuses and applies nothing.
      const list = hits.map((x) => `${x.account}${FIELD_SEP}${x.mailbox}`).join(DIAG_ITEM_SEP);
      out += `${pos}${FIELD_SEP}ambiguous:${list}${RECORD_SEP}`;
    } else {
      // Scoped (exactly one mailbox can match) or unscoped with a single home.
      h.applied.push({ account: hits[0].account, mailbox: hits[0].mailbox, id });
      out += `${pos}${FIELD_SEP}ok${RECORD_SEP}`;
    }
  });

  return out;
}

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string) => {
      h.scripts.push(script);
      // Only the batch script declares `_ids` — true of BOTH the fixed and the
      // pre-#152 shape, so this same mock can drive either. Everything else
      // (account / mailbox-name resolution lookups) gets a benign empty answer.
      if (!script.includes("set _ids to")) {
        return { success: true, output: "", error: undefined as string | undefined };
      }
      return { success: true, output: interpretBatch(script), error: undefined };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

/**
 * The reproduction from the issue, as a fixture. Numeric id "79345" is
 * reachable from BOTH "[Gmail]/All Mail" (walk position 2) and "Sales Spam"
 * (walk position 4) — All Mail is reached first, so a first-match walk mutates
 * the wrong copy. "555" lives only in INBOX of the second account, which the
 * walk does not reach until every mailbox of the first account is exhausted.
 */
const GMAIL_TREE: Tree = [
  {
    account: "rob@superiortech.io",
    mailboxes: [
      { name: "INBOX", ids: ["79464"] },
      { name: "[Gmail]/All Mail", ids: ["79345", "79464"] },
      { name: "[Gmail]/Important", ids: [] },
      { name: "Sales Spam", ids: ["79345"] },
    ],
  },
  {
    account: "second@example.com",
    mailboxes: [{ name: "INBOX", ids: ["555"] }],
  },
];

describe("#152 batch operations resolve within a known scope", () => {
  let mgr: AppleMailManager;

  beforeEach(() => {
    h.scripts.length = 0;
    h.applied.length = 0;
    h.tree = GMAIL_TREE;
    mgr = new AppleMailManager();
  });

  it("operates on the INTENDED mailbox when an id exists in several mailboxes", () => {
    const res = mgr.batchDeleteMessages(["79345"], {
      account: "rob@superiortech.io",
      mailbox: "Sales Spam",
    });

    expect(res).toEqual([{ id: "79345", success: true }]);
    // The whole point: NOT "[Gmail]/All Mail", which the walk reaches first.
    expect(h.applied).toEqual([
      { account: "rob@superiortech.io", mailbox: "Sales Spam", id: "79345" },
    ]);
  });

  it("uses the id→location index as scope when the caller gives none", () => {
    // Simulate the id having been produced by list-messages("Sales Spam"),
    // which is what records the location.
    mgr.noteMessageLocation("79345", "rob@superiortech.io", "Sales Spam");

    const res = mgr.batchDeleteMessages(["79345"]);

    expect(res).toEqual([{ id: "79345", success: true }]);
    expect(h.applied).toEqual([
      { account: "rob@superiortech.io", mailbox: "Sales Spam", id: "79345" },
    ]);
  });

  it("refuses (does not guess) when the scope is unknown and the id is ambiguous", () => {
    const res = mgr.batchDeleteMessages(["79345"]);

    expect(res[0].success).toBe(false);
    expect(res[0].error).toMatch(/matches in 2 mailboxes/);
    // Both candidates are named, as the move-destination resolution already does.
    expect(res[0].error).toContain('"[Gmail]/All Mail"');
    expect(res[0].error).toContain('"Sales Spam"');
    expect(res[0].error).toMatch(/refusing to guess/);
    // Nothing was mutated.
    expect(h.applied).toEqual([]);
  });

  it("never reports ok for an id whose intended target was not touched", () => {
    // Scoped to a mailbox that does not hold this id: the old code would have
    // wandered off and found it in All Mail, reporting success.
    const res = mgr.batchDeleteMessages(["79345"], {
      account: "rob@superiortech.io",
      mailbox: "INBOX",
    });

    expect(res).toEqual([{ id: "79345", success: false, error: "Message not found" }]);
    expect(h.applied).toEqual([]);
  });

  it("does not reach into another account's mailbox for a scoped id", () => {
    const res = mgr.batchDeleteMessages(["555"], {
      account: "rob@superiortech.io",
      mailbox: "INBOX",
    });

    expect(res[0].success).toBe(false);
    expect(h.applied).toEqual([]);
  });

  it("still resolves an unambiguous id with no scope at all", () => {
    const res = mgr.batchDeleteMessages(["555"]);

    expect(res).toEqual([{ id: "555", success: true }]);
    expect(h.applied).toEqual([{ account: "second@example.com", mailbox: "INBOX", id: "555" }]);
  });

  it("scopes a mixed batch per id, not per batch", () => {
    mgr.noteMessageLocation("79464", "rob@superiortech.io", "INBOX");
    const res = mgr.batchMarkAsRead(["79464", "555"]);

    expect(res.map((r) => r.success)).toEqual([true, true]);
    expect(h.applied).toEqual([
      { account: "rob@superiortech.io", mailbox: "INBOX", id: "79464" },
      { account: "second@example.com", mailbox: "INBOX", id: "555" },
    ]);
  });

  it("keeps the single-osascript-walk property (issue #31)", () => {
    mgr.noteMessageLocation("79345", "rob@superiortech.io", "Sales Spam");
    mgr.noteMessageLocation("79464", "rob@superiortech.io", "INBOX");
    h.scripts.length = 0;

    mgr.batchDeleteMessages(["79345", "79464", "555"]);

    const batchScripts = h.scripts.filter((s) => s.includes("set _sAcct to"));
    expect(batchScripts).toHaveLength(1);
  });

  it("verifies the matched id by string, not just the whose-clause result", () => {
    // Guards AppleScript coercing integer literals above 2^29 to reals, which
    // would let `whose id is N` match a neighbouring message imprecisely.
    mgr.noteMessageLocation("79345", "rob@superiortech.io", "Sales Spam");
    mgr.batchDeleteMessages(["79345"]);

    const script = h.scripts.find((s) => s.includes("set _sAcct to")) ?? "";
    expect(script).toContain("set _idStrs to");
    expect(script).toContain("((id of _c) as string) is (item _idx of _idStrs)");
  });

  it("does not apply the operation mid-walk for an unscoped id", () => {
    // The operation must appear only on the scoped branch and the
    // resolved-single-candidate branch — never unconditionally inside the walk.
    mgr.batchDeleteMessages(["555"]);
    const script = h.scripts.find((s) => s.includes("set _sAcct to")) ?? "";
    expect(script).toContain("if _isScoped then");
    expect(script).toContain("set item _idx of _cand to");
  });
});
