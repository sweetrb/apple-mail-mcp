/**
 * Destructive-operation forensics (#155).
 *
 * #155 is an OPEN, unexplained symptom: a `batch-delete-messages` removed two
 * messages whose ids were never passed. #153/#154 fixed a real mis-targeting
 * defect, but that mechanism explains acting on the wrong COPY of a listed
 * message — never on a message nobody named. It is unreproducible today for one
 * reason: nothing recorded what a delete actually did.
 *
 * These tests exercise the instrumentation that changes that, through the
 * repo's mocked `executeAppleScript` layer. No Mail.app, no real mail.
 *
 * ## The mock is a SIMULATOR, not a canned string
 *
 * `executeAppleScript` here parses the generated script — the id list, the
 * snapshot ceiling — mutates a fake mailbox, and emits the record stream Mail
 * would emit. Two consequences that matter:
 *
 *   • It can inject the #155 defect (delete ids the script never asked for) and
 *     see whether the instrumentation notices. That is the acceptance test.
 *   • It emits a pre-image / snapshot ONLY when the generated script actually
 *     asked for one. So if the manager stops emitting those fragments, the mock
 *     stops emitting the data, and the assertions fail — the test cannot pass
 *     vacuously on instrumentation that was silently removed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";
const DIAG_MARKER = "\x1dDIAG\x1d";
const DIAG_FIELD_SEP = "\x1dF\x1d";
const RECON_TAG = "\x1dRECON\x1d";
const SNAP_TAG = "\x1dSNAP\x1d";
const SNAP_PAIR = "\x1dP\x1d";
const SNAP_ITEM = "\x1dI\x1d";

interface FakeMsg {
  id: string;
  mid: string;
  subject: string;
}

const h = vi.hoisted(() => ({
  calls: [] as string[],
  /** The simulated source mailbox, in order. */
  mailbox: [] as { id: string; mid: string; subject: string }[],
  /** Ids that ALSO vanish on the next mutation — the injected #155 defect. */
  collateral: [] as string[],
  /** When true, the store "succeeds" without the message leaving the mailbox. */
  flagOnlyDelete: false,
  account: "me@example.com",
  mailboxName: "INBOX",
}));

/** A list-messages payload: the ids, six fields each. */
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
      if (script.includes("outputText")) {
        return { success: true, output: listPayload(h.mailbox.map((m) => m.id)) };
      }
      if (!/delete _msg|delete msg|move _msg to destMailbox|move msg to destMailbox/.test(script)) {
        return { success: true, output: "ok" };
      }
      return { success: true, output: simulateDestructive(script) };
    },
  };
});

/**
 * Simulate Mail executing a destructive script against `h.mailbox`, honouring
 * exactly the instrumentation the generated script asked for.
 */
function simulateDestructive(script: string): string {
  // Which ids and positions the script targets. The batch path names them in
  // `_gids`/`_gpos`; the single-message path interpolates one literal id.
  let targets: { id: string; pos: number }[];
  const gids = /set _gids to \{([^}]*)\}/.exec(script);
  const gpos = /set _gpos to \{([^}]*)\}/.exec(script);
  if (gids && gpos) {
    const ids = gids[1].split(",").map((s) => s.trim());
    const poss = gpos[1].split(",").map((s) => Number(s.trim()));
    targets = ids.map((id, i) => ({ id, pos: poss[i] }));
  } else {
    const one = /whose id is (\d+)/.exec(script);
    targets = one ? [{ id: one[1], pos: 1 }] : [];
  }

  const wantsPreImage =
    script.includes("message id of _msg") || script.includes("message id of msg");
  const wantsSubject = script.includes("subject of _msg") || script.includes("subject of msg");
  const wantsCount = script.includes("count of messages of");
  const snapMax = (() => {
    const m = /APPLE_MAIL_MCP_AUDIT_SNAPSHOT_MAX=(\d+)/.exec(script);
    return m ? Number(m[1]) : null;
  })();

  // Echo back the account/mailbox the script's own RECON emitter names, exactly
  // as Mail would. A separate test asserts those literals are the mailbox the
  // script actually opened, so this cannot paper over a scope mismatch.
  const recon = new RegExp(
    `& "${RECON_TAG}${FIELD_SEP}" & "([^"]*)" & "${FIELD_SEP}" & "([^"]*)"`
  ).exec(script);
  const acct = recon?.[1] ?? h.account;
  const mbox = recon?.[2] ?? h.mailboxName;
  const before = h.mailbox.slice();
  let out = "";

  const emitSnapshot = (phase: "before" | "after", state: FakeMsg[]): void => {
    if (snapMax === null) return;
    if (state.length > snapMax) {
      out +=
        `${SNAP_TAG}${FIELD_SEP}${acct}${FIELD_SEP}${mbox}${FIELD_SEP}${phase}${FIELD_SEP}skipped${FIELD_SEP}` +
        `mailbox holds ${state.length} messages, above APPLE_MAIL_MCP_AUDIT_SNAPSHOT_MAX=${snapMax}${RECORD_SEP}`;
      return;
    }
    const payload = state.map((m) => `${m.id}${SNAP_PAIR}${m.mid}`).join(SNAP_ITEM);
    out += `${SNAP_TAG}${FIELD_SEP}${acct}${FIELD_SEP}${mbox}${FIELD_SEP}${phase}${FIELD_SEP}ok${FIELD_SEP}${payload}${RECORD_SEP}`;
  };

  emitSnapshot("before", before);

  for (const t of targets) {
    const msg = h.mailbox.find((m) => m.id === t.id);
    if (!msg) {
      out += `${t.pos}${FIELD_SEP}notfound${RECORD_SEP}`;
      continue;
    }
    const pre = wantsPreImage
      ? `${FIELD_SEP}${msg.mid}${FIELD_SEP}Monday, January 1, 2026 at 0:00:00${
          wantsSubject ? `${FIELD_SEP}${msg.subject}` : ""
        }`
      : "";
    if (!h.flagOnlyDelete) h.mailbox = h.mailbox.filter((m) => m.id !== t.id);
    out += `${t.pos}${FIELD_SEP}ok${pre}${RECORD_SEP}`;
  }

  // The injected #155 defect: messages leave that the script never named.
  if (h.collateral.length > 0) {
    h.mailbox = h.mailbox.filter((m) => !h.collateral.includes(m.id));
  }

  emitSnapshot("after", h.mailbox);
  if (wantsCount) {
    out += `${RECON_TAG}${FIELD_SEP}${acct}${FIELD_SEP}${mbox}${FIELD_SEP}${before.length}${FIELD_SEP}${h.mailbox.length}${FIELD_SEP}${RECORD_SEP}`;
  }
  return out;
}

import { AppleMailManager } from "@/services/appleMailManager.js";
import {
  AUDIT_LOG_ENV,
  AUDIT_SUBJECTS_ENV,
  AUDIT_SNAPSHOT_MAX_ENV,
  reconciliationWarnings,
  writeDestructiveAudit,
} from "@/services/auditLog.js";

let tmp: string;
let mgr: AppleMailManager;

/** Seed the mailbox and the id→location index the way real usage does. */
function seed(messages: FakeMsg[]): void {
  h.mailbox = messages.map((m) => ({ ...m }));
  mgr = new AppleMailManager();
  mgr.listMessages(h.mailboxName, h.account, 50);
}

const SAMPLE: FakeMsg[] = [
  { id: "75811", mid: "a@example.com", subject: "Invoice" },
  { id: "75812", mid: "b@example.com", subject: "Standup notes" },
  { id: "75813", mid: "c@example.com", subject: "Biopsy results" },
  { id: "75814", mid: "d@example.com", subject: "Lunch?" },
  { id: "75815", mid: "e@example.com", subject: "Renewal" },
];

beforeEach(() => {
  h.calls.length = 0;
  h.collateral = [];
  h.flagOnlyDelete = false;
  tmp = mkdtempSync(join(tmpdir(), "amcp-audit-"));
  delete process.env[AUDIT_LOG_ENV];
  delete process.env[AUDIT_SUBJECTS_ENV];
  delete process.env[AUDIT_SNAPSHOT_MAX_ENV];
  seed(SAMPLE);
});

afterEach(() => {
  delete process.env[AUDIT_LOG_ENV];
  delete process.env[AUDIT_SUBJECTS_ENV];
  delete process.env[AUDIT_SNAPSHOT_MAX_ENV];
  rmSync(tmp, { recursive: true, force: true });
});

const auditFile = (): string => join(tmp, "audit.ndjson");
const readAudit = (): Record<string, unknown>[] =>
  existsSync(auditFile())
    ? readFileSync(auditFile(), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

// ===========================================================================
// Part 1 — ALWAYS-ON effect reconciliation
// ===========================================================================

describe("effect reconciliation (always on, no audit log configured)", () => {
  it("counts the mailbox inside the SAME script — no extra osascript invocation", () => {
    const beforeCalls = h.calls.length;
    mgr.batchDeleteMessages(["75811", "75812"]);
    // The whole batch — mutation, both counts, reconciliation — is ONE script.
    // The single-osascript property from issue #31 is intact.
    const mutations = h.calls.slice(beforeCalls).filter((s) => s.includes("delete _msg"));
    expect(mutations).toHaveLength(1);
    const script = mutations[0];
    expect(script).toContain("count of messages of _tmb");
    expect(script).toContain(RECON_TAG);
    // Nothing was written to a log and no snapshot was requested: the opt-in
    // layers cost nothing when off.
    expect(script).not.toContain(SNAP_TAG);
    expect(script).not.toContain("message id of _msg");
  });

  it("reconciles the mailbox it actually opened", () => {
    mgr.batchDeleteMessages(["75811"]);
    const script = h.calls.find((s) => s.includes("delete _msg"))!;
    const opened = /if \(name of _m\) is "([^"]*)"/.exec(script)![1];
    const openedAccount = /if \(name of _a\) is "([^"]*)"/.exec(script)![1];
    const [delta] = mgr.consumeLastForensics()!.countDeltas;
    expect(delta.mailbox).toBe(opened);
    expect(delta.account).toBe(openedAccount);
  });

  it("reports a matching delta with status 'match' and raises no warning", () => {
    mgr.batchDeleteMessages(["75811", "75812"]);
    const report = mgr.consumeLastForensics();
    expect(report?.countDeltas).toEqual([
      {
        account: "me@example.com",
        mailbox: "INBOX",
        before: 5,
        after: 3,
        expected: 2,
        observed: 2,
        status: "match",
      },
    ]);
    expect(reconciliationWarnings(report!)).toEqual([]);
  });

  it("detects a mismatch when MORE messages disappear than were operated on", () => {
    h.collateral = ["75814", "75815"]; // never passed to the tool
    mgr.batchDeleteMessages(["75811", "75812"]);
    const report = mgr.consumeLastForensics()!;
    expect(report.countDeltas[0]).toMatchObject({
      before: 5,
      after: 1,
      expected: 2,
      observed: 4,
      status: "over",
    });
    const warnings = reconciliationWarnings(report);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("4 message(s) left the mailbox but only 2 were operated on");
    expect(warnings[0]).toContain("issues/155");
  });

  it("does NOT cry wolf when fewer messages leave than expected", () => {
    // A store that flags deletions instead of removing them — the operation
    // genuinely succeeded and the count did not move. Reported, never warned.
    h.flagOnlyDelete = true;
    mgr.batchDeleteMessages(["75811", "75812"]);
    const report = mgr.consumeLastForensics()!;
    expect(report.countDeltas[0]).toMatchObject({ expected: 2, observed: 0, status: "under" });
    expect(report.countDeltas[0].note).toMatch(/flags deletions instead of removing them/);
    expect(reconciliationWarnings(report)).toEqual([]);
  });

  it("expects a delta of 0 — and stays quiet — when a move's destination IS the source", () => {
    mgr.batchMoveMessages(["75811"], "INBOX", "me@example.com", {
      account: "me@example.com",
      mailbox: "INBOX",
    });
    const report = mgr.consumeLastForensics()!;
    expect(report.countDeltas[0]).toMatchObject({ expected: 0, status: "over" });
    expect(report.countDeltas[0].note).toMatch(/Destination is the source mailbox/);
  });

  it("instruments the single-message delete path too", () => {
    h.collateral = ["75815"];
    const res = mgr.deleteMessage("75811");
    expect(res.success).toBe(true);
    const report = mgr.consumeLastForensics()!;
    expect(report.countDeltas[0]).toMatchObject({ expected: 1, observed: 2, status: "over" });
    expect(reconciliationWarnings(report)).toHaveLength(1);
  });

  it("does not instrument the non-destructive batches", () => {
    mgr.batchMarkAsRead(["75811"]);
    expect(h.calls[1]).not.toContain(RECON_TAG);
    expect(mgr.consumeLastForensics()).toBeUndefined();
  });

  it("clears a previous report so it cannot be attributed to a later call", () => {
    h.collateral = ["75815"];
    mgr.batchDeleteMessages(["75811"]);
    expect(mgr.consumeLastForensics()).toBeDefined();
    expect(mgr.consumeLastForensics()).toBeUndefined();
  });
});

// ===========================================================================
// Part 2 — OPT-IN forensic audit log
// ===========================================================================

describe("audit log (opt-in)", () => {
  it("writes nothing at all when the env var is unset", () => {
    mgr.batchDeleteMessages(["75811"]);
    expect(existsSync(auditFile())).toBe(false);
  });

  it("records the pre-image and the per-id outcome", () => {
    process.env[AUDIT_LOG_ENV] = auditFile();
    mgr.batchDeleteMessages(["75811", "99999"], { account: h.account, mailbox: h.mailboxName });
    writeDestructiveAudit(
      { tool: "batch-delete-messages", args: { ids: ["75811", "99999"] }, serverVersion: "test" },
      mgr.consumeLastForensics()!
    );

    const [rec] = readAudit();
    expect(rec.tool).toBe("batch-delete-messages");
    expect(rec.preImages).toEqual([
      {
        id: "75811",
        account: "me@example.com",
        mailbox: "INBOX",
        messageId: "a@example.com",
        date: "Monday, January 1, 2026 at 0:00:00",
      },
    ]);
    expect(rec.outcomes).toEqual([
      { id: "75811", status: "ok" },
      { id: "99999", status: "notfound" },
    ]);
    // Privacy default: identifying metadata only, no subject.
    expect(JSON.stringify(rec)).not.toContain("Invoice");
    expect(rec.subjectsLogged).toBe(false);
  });

  it("adds subjects only behind the SECOND opt-in", () => {
    process.env[AUDIT_LOG_ENV] = auditFile();
    process.env[AUDIT_SUBJECTS_ENV] = "1";
    mgr.batchDeleteMessages(["75813"], { account: h.account, mailbox: h.mailboxName });
    const report = mgr.consumeLastForensics()!;
    expect(report.preImages[0].subject).toBe("Biopsy results");
  });

  it("never writes to stdout — stdout is the JSON-RPC transport", () => {
    process.env[AUDIT_LOG_ENV] = auditFile();
    process.env[AUDIT_SUBJECTS_ENV] = "1";
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      h.collateral = ["75815"];
      mgr.batchDeleteMessages(["75811"], { account: h.account, mailbox: h.mailboxName });
      writeDestructiveAudit(
        { tool: "batch-delete-messages", args: { ids: ["75811"] }, serverVersion: "test" },
        mgr.consumeLastForensics()!
      );
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
    expect(readAudit()).toHaveLength(1);
  });

  it("survives an unwritable log path without failing the mutation", () => {
    process.env[AUDIT_LOG_ENV] = join(tmp, "no", "such", "dir", "audit.ndjson");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = mgr.batchDeleteMessages(["75811"], {
        account: h.account,
        mailbox: h.mailboxName,
      });
      writeDestructiveAudit(
        { tool: "batch-delete-messages", args: {}, serverVersion: "test" },
        mgr.consumeLastForensics()!
      );
      expect(res[0].success).toBe(true);
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
});

// ===========================================================================
// Part 3 — OPT-IN collateral identification
// ===========================================================================

describe("collateral identification (opt-in, gated on the audit log)", () => {
  it("names a message that disappeared but was never requested", () => {
    process.env[AUDIT_LOG_ENV] = auditFile();
    h.collateral = ["75814"];
    mgr.batchDeleteMessages(["75811"], { account: h.account, mailbox: h.mailboxName });
    const report = mgr.consumeLastForensics()!;
    const [c] = report.collateral;
    expect(c.snapshot).toBe("ok");
    expect(c.disappeared).toEqual([
      { id: "75811", messageId: "a@example.com" },
      { id: "75814", messageId: "d@example.com" },
    ]);
    expect(c.unrequested).toEqual([{ id: "75814", messageId: "d@example.com" }]);
  });

  it("RECORDS the skip when the mailbox is above the ceiling", () => {
    process.env[AUDIT_LOG_ENV] = auditFile();
    process.env[AUDIT_SNAPSHOT_MAX_ENV] = "2";
    mgr.batchDeleteMessages(["75811"], { account: h.account, mailbox: h.mailboxName });
    const report = mgr.consumeLastForensics()!;
    const [c] = report.collateral;
    expect(c.snapshot).toBe("skipped");
    expect(c.skipReason).toBe(
      "mailbox holds 5 messages, above APPLE_MAIL_MCP_AUDIT_SNAPSHOT_MAX=2"
    );
    expect(c.disappeared).toBeUndefined();
    // The always-on reconciliation is unaffected by the skip.
    expect(report.countDeltas[0]).toMatchObject({ status: "match" });
  });

  it("takes no snapshot at all when the ceiling is 0", () => {
    process.env[AUDIT_LOG_ENV] = auditFile();
    process.env[AUDIT_SNAPSHOT_MAX_ENV] = "0";
    mgr.batchDeleteMessages(["75811"], { account: h.account, mailbox: h.mailboxName });
    expect(h.calls[1]).not.toContain(SNAP_TAG);
    expect(mgr.consumeLastForensics()!.collateral).toEqual([]);
  });
});

// ===========================================================================
// ACCEPTANCE — would this have caught #155?
// ===========================================================================

describe("#155 acceptance: N ids passed, N+2 messages disappear", () => {
  it("fires the reconciliation warning AND names the two unrequested messages", () => {
    process.env[AUDIT_LOG_ENV] = auditFile();
    // The reported shape: a 2-id delete where 4 messages leave the mailbox, two
    // of which the caller never named.
    h.collateral = ["75814", "75815"];
    mgr.batchDeleteMessages(["75811", "75812"], {
      account: h.account,
      mailbox: h.mailboxName,
    });
    const report = mgr.consumeLastForensics()!;
    writeDestructiveAudit(
      {
        tool: "batch-delete-messages",
        args: { ids: ["75811", "75812"], sourceMailbox: "INBOX", sourceAccount: "me@example.com" },
        serverVersion: "test",
      },
      report
    );

    const warnings = reconciliationWarnings(report);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("2 message(s) are unaccounted for");

    const [rec] = readAudit();
    const collateral = (rec.collateral as Record<string, unknown>[])[0];
    expect(collateral.unrequested).toEqual([
      { id: "75814", messageId: "d@example.com" },
      { id: "75815", messageId: "e@example.com" },
    ]);
  });
});
