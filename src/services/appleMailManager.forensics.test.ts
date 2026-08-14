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

const GROUP_SEP = "\x1d";
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
  /** id → the error text Mail raises for it instead of performing the op. */
  errorOn: {} as Record<string, string>,
  /** id → the "account/mailbox, " list Mail builds when an id is ambiguous. */
  ambiguousOn: {} as Record<string, string>,
  account: "me@example.com",
  mailboxName: "INBOX",
}));

/**
 * AppleScript's integer range stops at 2^29-1; a Mail id above it is a REAL, and
 * `as string` renders it in scientific notation. The simulator reproduces that,
 * because the id it emits is what the collateral diff has to match against the
 * caller's own id strings.
 */
const APPLESCRIPT_INT_MAX = 536870911;
function asMailWouldRenderId(id: string): string {
  const n = Number(id);
  if (!Number.isFinite(n) || Math.abs(n) <= APPLESCRIPT_INT_MAX) return id;
  return n.toExponential().replace("e", "E");
}

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
  // `_gids`/`_gpos` (ids bound to a source mailbox) and `_uids`/`_upos` (ids
  // with no recorded mailbox); the single-message path interpolates one literal.
  const targets: { id: string; pos: number; unlocated: boolean }[] = [];
  const pairs = (idsRe: RegExp, posRe: RegExp, unlocated: boolean): void => {
    const ids = idsRe.exec(script);
    const poss = posRe.exec(script);
    if (!ids || !poss) return;
    const idList = ids[1].split(",").map((s) => s.trim());
    const posList = poss[1].split(",").map((s) => Number(s.trim()));
    idList.forEach((id, i) => targets.push({ id, pos: posList[i], unlocated }));
  };
  pairs(/set _gids to \{([^}]*)\}/, /set _gpos to \{([^}]*)\}/, false);
  pairs(/set _uids to \{([^}]*)\}/, /set _upos to \{([^}]*)\}/, true);
  if (targets.length === 0) {
    const one = /whose id is (\d+)/.exec(script);
    if (one) targets.push({ id: one[1], pos: 1, unlocated: false });
  }

  const wantsPreImage =
    script.includes("message id of _msg") || script.includes("message id of msg");
  const wantsSubject = script.includes("subject of _msg") || script.includes("subject of msg");
  // Mail only strips the stream's structural bytes out of a value if the
  // generated script TOLD it to — and it is asked PER VARIABLE, so this is
  // checked per variable too. If the manager stops emitting the sanitizing
  // fragment for one value, this mock stops stripping that one value, and the
  // injection test for it fails: no defence here can pass vacuously, and one
  // emitter's fragment cannot vouch for another's.
  const asMailWouldEmit = (scriptVar: string, value: string): string => {
    if (!script.includes(`set _zParts to text items of ${scriptVar}`)) return value;
    let out = value;
    for (const d of [GROUP_SEP, RECORD_SEP, FIELD_SEP]) out = out.split(d).join("�");
    return out;
  };
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
    const payload = state
      .map((m) => `${asMailWouldRenderId(m.id)}${SNAP_PAIR}${asMailWouldEmit("_zSnapMid", m.mid)}`)
      .join(SNAP_ITEM);
    out += `${SNAP_TAG}${FIELD_SEP}${acct}${FIELD_SEP}${mbox}${FIELD_SEP}${phase}${FIELD_SEP}ok${FIELD_SEP}${payload}${RECORD_SEP}`;
  };

  emitSnapshot("before", before);

  for (const t of targets) {
    // An id Mail finds in several mailboxes: refused, naming the candidates it
    // built at runtime. Only the unlocated path can produce this.
    if (t.unlocated && h.ambiguousOn[t.id] !== undefined) {
      out +=
        `${t.pos}${FIELD_SEP}error:This message id is present in more than one mailbox ` +
        `(${asMailWouldEmit("_uname", h.ambiguousOn[t.id])}); list or search that mailbox ` +
        `first so the operation targets the right copy${RECORD_SEP}`;
      continue;
    }
    // Mail raised on this one. The text is Mail's, not ours.
    if (h.errorOn[t.id] !== undefined) {
      out += `${t.pos}${FIELD_SEP}error:${asMailWouldEmit("_zErr", h.errorOn[t.id])}${RECORD_SEP}`;
      continue;
    }
    const msg = h.mailbox.find((m) => m.id === t.id);
    if (!msg) {
      out += `${t.pos}${FIELD_SEP}notfound${RECORD_SEP}`;
      continue;
    }
    const pre = wantsPreImage
      ? `${FIELD_SEP}${asMailWouldEmit("_zMid", msg.mid)}${FIELD_SEP}Monday, January 1, 2026 at 0:00:00${
          wantsSubject ? `${FIELD_SEP}${asMailWouldEmit("_zSub", msg.subject)}` : ""
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
  falseOkWarning,
  type CountDelta,
  type CollateralDiff,
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
  h.errorOn = {};
  h.ambiguousOn = {};
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

  // A move whose destination IS the source removes nothing, so it must not
  // warn. It previously did: `expected` was pinned at 0 and any count movement
  // read as `over`, so the simulator's move — like Mail re-filing a message into
  // the mailbox it already occupies — fired the #155 warning at a caller who did
  // exactly the right thing. Three of three such probes warned before this fix,
  // while the code comment and this test's own title claimed the opposite.
  //
  // The honest answer is that there is nothing to compare: what Mail does to the
  // count in that case is unspecified. `expected: null` says so, and `unknown`
  // never warns.
  describe("a move whose destination IS the source mailbox", () => {
    const selfMove = (): void => {
      mgr.batchMoveMessages(["75811"], "INBOX", "me@example.com", {
        account: "me@example.com",
        mailbox: "INBOX",
      });
    };

    it("makes no comparison at all, and raises no warning", () => {
      selfMove();
      const report = mgr.consumeLastForensics()!;
      expect(report.countDeltas[0]).toMatchObject({ expected: null, status: "unknown" });
      expect(report.countDeltas[0].note).toMatch(/Destination is the source mailbox/);
      expect(reconciliationWarnings(report)).toEqual([]);
    });

    it("stays quiet for a batch of several ids too", () => {
      mgr.batchMoveMessages(["75811", "75812", "75813"], "INBOX", "me@example.com", {
        account: "me@example.com",
        mailbox: "INBOX",
      });
      const report = mgr.consumeLastForensics()!;
      expect(report.countDeltas[0]).toMatchObject({ expected: null, status: "unknown" });
      expect(reconciliationWarnings(report)).toEqual([]);
    });

    it("stays quiet on the single-message path too", () => {
      mgr.moveMessage("75811", "INBOX", "me@example.com");
      const report = mgr.consumeLastForensics()!;
      expect(report.countDeltas[0]).toMatchObject({ expected: null, status: "unknown" });
      expect(reconciliationWarnings(report)).toEqual([]);
    });

    it("does NOT blunt the detector for a move to a different mailbox", () => {
      // The suppression is scoped to the self-move case and nothing else: an
      // over-effective move elsewhere still warns.
      h.collateral = ["75814", "75815"];
      mgr.batchMoveMessages(["75811"], "Archive", "me@example.com", {
        account: "me@example.com",
        mailbox: "INBOX",
      });
      const report = mgr.consumeLastForensics()!;
      expect(report.countDeltas[0]).toMatchObject({ expected: 1, observed: 3, status: "over" });
      expect(reconciliationWarnings(report)).toHaveLength(1);
    });
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

  // A batch is a SET of messages. Counting a repeat as a second operand makes
  // `expected` disagree with the mailbox on an operation that did exactly the
  // right thing — and the always-on warning names #155 while it does it.
  describe("a repeated id names ONE message", () => {
    it("operates on it once and raises NO warning", () => {
      const results = mgr.batchDeleteMessages(["75811", "75811"], {
        account: h.account,
        mailbox: h.mailboxName,
      });
      // The headline claim first: the mailbox lost exactly the message it was
      // told to lose, so there is nothing to warn about.
      const report = mgr.consumeLastForensics()!;
      expect(reconciliationWarnings(report)).toEqual([]);
      expect(report.countDeltas[0]).toMatchObject({
        before: 5,
        after: 4,
        expected: 1,
        observed: 1,
        status: "match",
      });
      // One operand in, one result out — `success` counts messages, not slots.
      expect(results).toEqual([{ id: "75811", success: true }]);
      expect(report.outcomes).toEqual([{ id: "75811", status: "ok" }]);
      // The generated script named the id once, so Mail was asked once.
      const script = h.calls.find((s) => s.includes("delete _msg"))!;
      expect(/set _gids to \{([^}]*)\}/.exec(script)![1]).toBe("75811");
    });

    it("deduplicates on the numeric id Mail is actually given", () => {
      // "75811" and " 75811" are the same target as far as AppleScript is
      // concerned, so they must not count as two messages either.
      const results = mgr.batchDeleteMessages(["75811", " 75811"], {
        account: h.account,
        mailbox: h.mailboxName,
      });
      expect(results).toHaveLength(1);
      const report = mgr.consumeLastForensics()!;
      expect(report.countDeltas[0]).toMatchObject({ expected: 1, observed: 1, status: "match" });
      expect(reconciliationWarnings(report)).toEqual([]);
    });

    it("still reports the real thing when a repeated delete IS over-effective", () => {
      // Dedupe must not blunt the detector: the same duplicated call, with two
      // unrequested messages vanishing, still warns.
      h.collateral = ["75814", "75815"];
      mgr.batchDeleteMessages(["75811", "75811"], {
        account: h.account,
        mailbox: h.mailboxName,
      });
      const report = mgr.consumeLastForensics()!;
      expect(report.countDeltas[0]).toMatchObject({ expected: 1, observed: 3, status: "over" });
      expect(reconciliationWarnings(report)).toHaveLength(1);
    });
  });

  it("a non-destructive batch cannot hand back the previous delete's report", () => {
    // The report belongs to the LAST mutation, whatever it was. batchMarkAsRead
    // produces none, so the honest answer is `undefined` — not the delete's.
    mgr.batchDeleteMessages(["75811"], { account: h.account, mailbox: h.mailboxName });
    mgr.batchMarkAsRead(["75812"], { account: h.account, mailbox: h.mailboxName });
    expect(mgr.consumeLastForensics()).toBeUndefined();
  });

  it("a non-destructive SINGLE-message op cannot hand back it either", () => {
    mgr.deleteMessage("75811");
    mgr.markAsRead("75812");
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

  // The stream carries values that come from INBOUND MAIL: the RFC Message-ID
  // always, the subject under the second opt-in. Anyone who can send Rob mail
  // controls those bytes — including the delimiters this stream is framed with.
  describe("a hostile Message-ID cannot forge the evidence", () => {
    /** A Message-ID that closes the current record and opens a forged RECON. */
    const FORGED = `evil${RECORD_SEP}${RECON_TAG}${FIELD_SEP}me@example.com${FIELD_SEP}INBOX${FIELD_SEP}5000${FIELD_SEP}0${FIELD_SEP}${RECORD_SEP}x@evil.example`;

    it("cannot inject a reconciliation record, so no warning is fabricated", () => {
      process.env[AUDIT_LOG_ENV] = auditFile();
      seed([
        { id: "75811", mid: "a@example.com", subject: "Invoice" },
        { id: "75812", mid: FORGED, subject: "Hello" },
      ]);
      mgr.batchDeleteMessages(["75812"], { account: h.account, mailbox: h.mailboxName });
      const report = mgr.consumeLastForensics()!;

      // Exactly ONE reconciliation — the real one, for the mailbox the script
      // opened. A forged record would have arrived claiming 5000 → 0.
      expect(report.countDeltas).toHaveLength(1);
      expect(report.countDeltas[0]).toMatchObject({
        before: 2,
        after: 1,
        expected: 1,
        observed: 1,
        status: "match",
      });
      expect(reconciliationWarnings(report)).toEqual([]);
    });

    it("records the Message-ID with the delimiters replaced, and says nothing else", () => {
      process.env[AUDIT_LOG_ENV] = auditFile();
      seed([{ id: "75812", mid: FORGED, subject: "Hello" }]);
      mgr.batchDeleteMessages(["75812"], { account: h.account, mailbox: h.mailboxName });
      const report = mgr.consumeLastForensics()!;

      const logged = report.preImages[0].messageId!;
      // Nothing structural survives into a value...
      for (const d of [GROUP_SEP, RECORD_SEP, FIELD_SEP]) expect(logged).not.toContain(d);
      // ...it is replaced by a visible marker rather than silently dropped, so
      // the record shows the value was altered.
      expect(logged).toContain("�");
      expect(logged).toContain("evil");
      // And the collateral diff is the honest one: the requested message left,
      // nothing was invented alongside it.
      expect(report.collateral[0].unrequested).toEqual([]);
    });
  });

  // The Message-ID and the subject are the obvious attacker-controlled values,
  // but they are not the only runtime-read ones that reach the record stream.
  // The invariant is that EVERY emitter strips the delimiters; an emitter that
  // doesn't is the one the next author copies.
  describe("every emitter strips the delimiters, not just the obvious ones", () => {
    /** Text that closes the current record and opens a forged RECON. */
    const forged = (lead: string): string =>
      `${lead}${RECORD_SEP}${RECON_TAG}${FIELD_SEP}me@example.com${FIELD_SEP}INBOX${FIELD_SEP}5000${FIELD_SEP}0${FIELD_SEP}${RECORD_SEP}`;

    it("sanitizes the error text MAIL composed", () => {
      // Mail writes this string, and it routinely quotes back a property of the
      // thing that failed. It was interpolated raw.
      const results = mgr.batchDeleteMessages(["75811", "75812"], {
        account: h.account,
        mailbox: h.mailboxName,
      });
      expect(results).toHaveLength(2); // sanity: the batch ran

      h.errorOn = { "75812": forged("Can't get message 75812") };
      seed(SAMPLE);
      mgr.batchDeleteMessages(["75811", "75812"], {
        account: h.account,
        mailbox: h.mailboxName,
      });
      const report = mgr.consumeLastForensics()!;

      // ONE reconciliation — the real one. A forged record would have arrived
      // claiming 5000 -> 0, and warned.
      expect(report.countDeltas).toHaveLength(1);
      expect(report.countDeltas[0]).toMatchObject({ status: "match" });
      expect(reconciliationWarnings(report)).toEqual([]);
      // The error still reaches the caller, with the structural bytes replaced.
      const failed = report.outcomes.find((o) => o.id === "75812")!;
      expect(failed.status).toBe("error");
      expect(failed.error).toContain("Can't get message 75812");
      for (const d of [GROUP_SEP, RECORD_SEP, FIELD_SEP]) expect(failed.error).not.toContain(d);
    });

    it("sanitizes the ambiguity candidate list Mail builds at runtime", () => {
      // `_unames` is accumulated inside the script from `name of acct` and
      // `name of mb`, so TypeScript-side escaping never sees it.
      h.ambiguousOn = { "88888": forged("me@example.com/INBOX, me@example.com/All Mail") };
      const [res] = mgr.batchDeleteMessages(["88888"]); // no scope -> unlocated path
      expect(res.success).toBe(false);
      expect(res.error).toContain("present in more than one mailbox");
      for (const d of [GROUP_SEP, RECORD_SEP, FIELD_SEP]) expect(res.error).not.toContain(d);
      const report = mgr.consumeLastForensics()!;
      // Nothing forged: no reconciliation claiming the mailbox emptied, and no
      // warning off one.
      expect(report.countDeltas.some((d) => d.before === 5000 || d.after === 0)).toBe(false);
      expect(reconciliationWarnings(report)).toEqual([]);
    });

    it("strips the names in the 'source mailbox not found' record, visibly", () => {
      // Not a live hole: escapeForAppleScript already removes every control
      // character from an interpolated literal, so this record could not carry a
      // delimiter into the stream either way. What changes is that the value now
      // shows it was ALTERED (U+FFFD) instead of being silently shortened into
      // something that reads as a real mailbox name — which is the stated reason
      // DELIMITER_REPLACEMENT is a visible marker rather than "".
      mgr.batchDeleteMessages(["75811"], {
        account: `acct${RECORD_SEP}x`,
        mailbox: `INBOX${RECORD_SEP}${RECON_TAG}`,
      });
      const script = h.calls.find((s) => s.includes("not found in account"))!;
      // Everything up to the record terminator: the VALUES, not the framing.
      const record = /error:source mailbox[^\n]*/.exec(script)![0].split(RECORD_SEP)[0];
      for (const d of [GROUP_SEP, RECORD_SEP, FIELD_SEP]) expect(record).not.toContain(d);
      expect(record).toContain("INBOX�");
      expect(record).toContain("acct�x");
    });
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

  // A Mail id above AppleScript's 2^29 integer range comes back from the
  // snapshot in scientific notation ("999999999" -> "9.99999999E+8"), while the
  // caller's id list is plain decimal. The membership test that decides
  // `unrequested` compared those two strings directly, so on a large-id mailbox
  // every REQUESTED message was reported as collateral: the log named innocent
  // messages as destroyed, in the one situation (#155) where someone is reading
  // it to find out what was destroyed.
  describe("a Mail id above 2^29", () => {
    const BIG: FakeMsg[] = [
      { id: "999999999", mid: "big-a@example.com", subject: "Invoice" },
      { id: "1234567891", mid: "big-b@example.com", subject: "Standup notes" },
      { id: "2147483647", mid: "big-c@example.com", subject: "Renewal" },
    ];

    it("is rendered by Mail in scientific notation — the premise of this test", () => {
      // Guard the simulator's own fidelity: if this stops being true the two
      // tests below stop meaning anything.
      expect(asMailWouldRenderId("999999999")).toBe("9.99999999E+8");
      expect(asMailWouldRenderId("75811")).toBe("75811");
    });

    it("is NOT reported as collateral when the caller requested it", () => {
      process.env[AUDIT_LOG_ENV] = auditFile();
      seed(BIG);
      mgr.batchDeleteMessages(["999999999", "1234567891"], {
        account: h.account,
        mailbox: h.mailboxName,
      });
      const [c] = mgr.consumeLastForensics()!.collateral;
      expect(c.snapshot).toBe("ok");
      // Both left, both were asked for, so nothing is collateral.
      expect(c.disappeared).toEqual([
        { id: "999999999", messageId: "big-a@example.com" },
        { id: "1234567891", messageId: "big-b@example.com" },
      ]);
      expect(c.unrequested).toEqual([]);
    });

    it("is still NAMED when it really was unrequested, in decimal", () => {
      // Normalising must not blunt the detector — and the id handed back has to
      // be the form the caller passed in, not "2.147483647E+9".
      process.env[AUDIT_LOG_ENV] = auditFile();
      seed(BIG);
      h.collateral = ["2147483647"];
      mgr.batchDeleteMessages(["999999999"], { account: h.account, mailbox: h.mailboxName });
      const report = mgr.consumeLastForensics()!;
      expect(report.collateral[0].unrequested).toEqual([
        { id: "2147483647", messageId: "big-c@example.com" },
      ]);
      expect(reconciliationWarnings(report)).toHaveLength(1);
    });
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

describe("false-ok detection (#155)", () => {
  const delta = (o: Partial<CountDelta> = {}): CountDelta => ({
    account: "iCloud",
    mailbox: "INBOX",
    before: 29,
    after: 29,
    expected: 4,
    observed: 0,
    status: "under",
    ...o,
  });
  const clean = (o: Partial<CollateralDiff> = {}): CollateralDiff => ({
    account: "iCloud",
    mailbox: "INBOX",
    snapshot: "ok",
    disappeared: [],
    unrequested: [],
    appeared: [],
    ...o,
  });

  it("warns when everything reported ok but nothing observably happened", () => {
    // scottstern0325's exact record from #155, on iCloud against 2.10.17.
    const w = falseOkWarning(delta(), clean());
    expect(w).toMatch(/Reported success with no observed effect/);
    expect(w).toContain("issues/155");
  });

  it("stays silent when the snapshot could not be taken", () => {
    // The flag-only account and a total no-op are genuinely indistinguishable
    // here, so warning would cry wolf on ordinary deletes.
    expect(falseOkWarning(delta(), clean({ snapshot: "unavailable" }))).toBeNull();
    expect(falseOkWarning(delta(), clean({ snapshot: "skipped" }))).toBeNull();
    expect(falseOkWarning(delta(), undefined)).toBeNull();
  });

  it("stays silent when messages did leave the mailbox", () => {
    expect(
      falseOkWarning(delta(), clean({ disappeared: [{ id: "1", messageId: "<a@b>" }] }))
    ).toBeNull();
  });

  it("stays silent on a PARTIAL under, where flag-only and partial failure look alike", () => {
    expect(falseOkWarning(delta({ after: 26, observed: 3 }), clean())).toBeNull();
  });

  it("stays silent on match, over and unknown", () => {
    expect(falseOkWarning(delta({ status: "match", observed: 4, after: 25 }), clean())).toBeNull();
    expect(falseOkWarning(delta({ status: "over", observed: 6, after: 23 }), clean())).toBeNull();
    expect(falseOkWarning(delta({ status: "unknown", expected: null }), clean())).toBeNull();
  });

  it("is surfaced by reconciliationWarnings alongside the over warning", () => {
    const warnings = reconciliationWarnings({
      countDeltas: [delta()],
      preImages: [],
      outcomes: [],
      collateral: [clean()],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Reported success with no observed effect/);
  });
});
