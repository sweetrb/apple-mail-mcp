/**
 * Forensic instrumentation for destructive message operations (#155).
 *
 * ## Why this exists
 *
 * Until now a destructive operation reported success because the AppleScript
 * did not throw — never because a message was observed to go away. #152 reported
 * a `batch-delete-messages` that removed two messages whose ids were never
 * passed, and a 2-id `batch-move-messages` that moved ~7. #153/#154 fixed a real
 * mis-targeting defect (by-id resolution walking every mailbox and acting on
 * whichever alias came first), but that mechanism explains operating on the
 * WRONG COPY OF A LISTED MESSAGE. It does not explain operating on a message
 * whose id was never named. #155 tracks that residual, and it is unreproducible
 * today for one reason: nothing recorded what a delete actually did.
 *
 * Three layers, deliberately separated by cost:
 *
 * 1. **Effect reconciliation — ALWAYS ON, zero extra `osascript` calls.** The
 *    same AppleScript that performs the mutation counts the affected mailbox
 *    before the loop and after it. The observed delta is compared with the
 *    expected one and reported on the tool result as `countDelta`. Every user
 *    gets this, so the defect self-reports instead of being invisible.
 * 2. **Audit log — opt-in** (`APPLE_MAIL_MCP_AUDIT_LOG`). One NDJSON record per
 *    destructive operation: arguments, the PRE-IMAGE of every message the op
 *    resolved (account, mailbox, numeric id, RFC Message-ID, date), the per-id
 *    outcome, and the reconciliation.
 * 3. **Collateral identification — opt-in, gated on (2).** The mailbox's
 *    (numeric id, Message-ID) pairs are snapshotted before and after and diffed,
 *    so the log NAMES the messages that disappeared, including ones the caller
 *    never listed. That is the missing evidence in #155. It is O(mailbox size),
 *    so it is bounded by `APPLE_MAIL_MCP_AUDIT_SNAPSHOT_MAX` — and when the
 *    bound bites, the skip is RECORDED. A silently skipped snapshot would read
 *    as "nothing collateral happened", which is the same failure class as the
 *    vacuous test this whole feature exists to replace.
 *
 * ## stdout is the JSON-RPC transport
 *
 * Nothing here may write to stdout. The audit record goes to the configured
 * file; failures to write are reported on **stderr** and never throw — losing an
 * audit line must not fail a mutation that already happened.
 *
 * ## Privacy
 *
 * The default logs what IDENTIFIES a message for diagnosis — RFC Message-ID,
 * date received, mailbox, numeric id — and nothing that reveals what it says.
 * **Subjects are behind a second, separate opt-in**
 * (`APPLE_MAIL_MCP_AUDIT_SUBJECTS`) because a subject line is frequently the
 * whole sensitive payload ("Re: your biopsy results"), and a diagnostician
 * chasing #155 does not need it: the Message-ID already pins the message
 * uniquely and can be resolved back to the mail by the person who owns it.
 * **Message bodies are never logged, under any setting.**
 *
 * @module services/auditLog
 */
import { appendFileSync } from "node:fs";

/** Path of the NDJSON audit log. Unset/blank disables all opt-in layers. */
export const AUDIT_LOG_ENV = "APPLE_MAIL_MCP_AUDIT_LOG";
/** Second, separate opt-in that adds message SUBJECTS to the pre-image. */
export const AUDIT_SUBJECTS_ENV = "APPLE_MAIL_MCP_AUDIT_SUBJECTS";
/** Ceiling on the collateral snapshot, in messages per mailbox. `0` disables it. */
export const AUDIT_SNAPSHOT_MAX_ENV = "APPLE_MAIL_MCP_AUDIT_SNAPSHOT_MAX";

/** Default collateral-snapshot ceiling (messages per mailbox). */
export const DEFAULT_SNAPSHOT_MAX = 2000;

/** Truthy-string test shared with the rest of the server's env knobs. */
function isOn(raw: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((raw ?? "").trim());
}

/** Configured audit-log path, or null when the audit log is off. */
export function auditLogPath(): string | null {
  const raw = process.env[AUDIT_LOG_ENV]?.trim();
  return raw ? raw : null;
}

/** True when the opt-in audit log (and therefore the collateral diff) is on. */
export function isAuditEnabled(): boolean {
  return auditLogPath() !== null;
}

/** True when the SECOND opt-in for message subjects is also on. */
export function auditSubjectsEnabled(): boolean {
  return isAuditEnabled() && isOn(process.env[AUDIT_SUBJECTS_ENV]);
}

/**
 * Collateral-snapshot ceiling. A mailbox with more messages than this is not
 * snapshotted — the skip is recorded in the log rather than silently omitted.
 * `0` (or a negative/unparseable value) turns the snapshot off entirely.
 */
export function auditSnapshotMax(): number {
  const raw = process.env[AUDIT_SNAPSHOT_MAX_ENV]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_SNAPSHOT_MAX;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SNAPSHOT_MAX;
  return Math.floor(n);
}

/**
 * Reconciliation of one affected mailbox: what the mutation was expected to
 * remove from it versus what actually left.
 *
 * `status` is the honest classification, and it is deliberately not a boolean:
 *
 * - `match`   — observed === expected. Nothing to say.
 * - `over`    — MORE messages left the mailbox than the operation acted on.
 *               This is the #155 signature and the data-loss direction, but it
 *               is a SIGNAL, not a proof — see `countDeltaWarning`. It is the
 *               only status that raises a warning in the tool response.
 * - `under`   — FEWER left than expected. This has legitimate causes on real
 *               stores (see `note`), so it is reported but never warned about.
 * - `unknown` — no comparison was possible: either the count could not be read
 *               (`before`/`after` null), or the expected delta is not
 *               predictable for this operation (`expected` null — a move whose
 *               destination IS the source mailbox is the one case, see `note`).
 *               Said plainly rather than guessed, and never warned about: a
 *               warning computed against a number nobody can justify is exactly
 *               the false alarm this instrumentation must not produce.
 */
export interface CountDelta {
  /** Account holding the affected mailbox ("" when Mail would not say). */
  account: string;
  /** The affected (source) mailbox. For a move this is where the ids came FROM. */
  mailbox: string;
  /** Message count before the mutation; null when Mail would not report it. */
  before: number | null;
  /** Message count after the mutation; null when Mail would not report it. */
  after: number | null;
  /**
   * How many messages this operation should have removed from `mailbox`, or
   * null when that is not predictable and no honest comparison exists. Null
   * always pairs with `status: "unknown"`.
   */
  expected: number | null;
  /** `before - after`; null when either count is unavailable. */
  observed: number | null;
  status: "match" | "over" | "under" | "unknown";
  /** Why the numbers are what they are, when that needs saying. */
  note?: string;
}

/**
 * What a message WAS, immediately before the operation touched it. This is the
 * evidence that proves which message was targeted — a numeric Mail.app id is
 * unique only within a mailbox and is reused, so on its own it proves nothing
 * after the fact.
 */
export interface AuditPreImage {
  /** The id as the caller passed it. */
  id: string;
  account: string;
  mailbox: string;
  /** RFC 5322 Message-ID — the stable, backend-independent identity. */
  messageId: string | null;
  /** `date received`, as Mail rendered it. */
  date: string | null;
  /** Only present when APPLE_MAIL_MCP_AUDIT_SUBJECTS is also on. */
  subject?: string;
}

/** Per-id outcome, exactly as the AppleScript reported it. */
export interface AuditOutcome {
  id: string;
  status: "ok" | "notfound" | "error";
  error?: string;
}

/**
 * Before/after set difference for one mailbox — the layer that answers #155 by
 * NAMING what disappeared, whether or not the caller asked for it.
 */
export interface CollateralDiff {
  account: string;
  mailbox: string;
  /**
   * `ok` — both snapshots were taken and diffed.
   * `skipped` — deliberately not taken (over the ceiling, or the ids had no
   *   single source mailbox). `skipReason` says which.
   * `unavailable` — Mail would not produce the snapshot.
   */
  snapshot: "ok" | "skipped" | "unavailable";
  skipReason?: string;
  /** Messages present before and absent after. */
  disappeared?: { id: string; messageId: string }[];
  /**
   * The subset of `disappeared` whose numeric id was NEVER in the caller's id
   * list. A non-empty array here IS the #155 symptom, with names attached.
   */
  unrequested?: { id: string; messageId: string }[];
  /** Messages absent before and present after (new mail arriving mid-op). */
  appeared?: { id: string; messageId: string }[];
}

/** Everything one destructive operation observed about its own effect. */
export interface DestructiveOpReport {
  countDeltas: CountDelta[];
  preImages: AuditPreImage[];
  outcomes: AuditOutcome[];
  collateral: CollateralDiff[];
}

/** Fields the caller (index.ts) contributes: which tool ran, with what. */
export interface AuditContext {
  tool: string;
  args: Record<string, unknown>;
  serverVersion: string;
}

/**
 * Append one NDJSON record. Never throws and never writes to stdout: an audit
 * failure must not fail a mutation that has already happened, and stdout is the
 * JSON-RPC transport.
 */
export function writeAuditRecord(record: Record<string, unknown>): void {
  const path = auditLogPath();
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    console.error(
      `[apple-mail-mcp] audit log write failed (${path}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Assemble and write the audit record for one destructive operation. A no-op
 * when the audit log is off, so callers need no guard of their own.
 */
export function writeDestructiveAudit(ctx: AuditContext, report: DestructiveOpReport): void {
  if (!isAuditEnabled()) return;
  writeAuditRecord({
    ts: new Date().toISOString(),
    tool: ctx.tool,
    serverVersion: ctx.serverVersion,
    args: ctx.args,
    preImages: report.preImages,
    outcomes: report.outcomes,
    countDeltas: report.countDeltas,
    collateral: report.collateral,
    subjectsLogged: auditSubjectsEnabled(),
  });
}

/**
 * The human-readable warning for one reconciliation, or null when there is
 * nothing honest to warn about.
 *
 * ONLY `over` warns, and the asymmetry is the whole design — but it is worth
 * stating exactly how strong it is, because a warning is only useful for as long
 * as it is trusted.
 *
 * **What `over` establishes.** More messages left the source mailbox across the
 * window of this operation than the operation accounted for. That is the
 * data-loss direction, and it is the #155 signature.
 *
 * **What `over` does NOT establish.** That *this server* removed them. The count
 * is a before/after pair around a window, so anything else that removes mail
 * from that mailbox inside the window produces the same reading:
 *
 * - a Mail.app rule firing mid-batch (filing or deleting messages),
 * - a server-side filter doing the same thing,
 * - another client — phone, webmail, a second Mail.app — deleting or moving,
 * - an IMAP expunge landing between the two counts, publishing deletions some
 *   other session had already flagged.
 *
 * Concurrent DEPARTURE is therefore the benign cause a reader should rule out
 * first, and the warning says so. What the asymmetry argument really shows is
 * only that concurrent ARRIVAL cannot cause it: a message arriving mid-operation
 * raises the after-count, which biases a reading toward `under`. So `over` is
 * the interesting direction and a strong signal — not a proof of a defect.
 *
 * **What is never warned about, by construction.** `over` requires an `expected`
 * this server can justify. When it cannot — a move whose destination IS the
 * source mailbox, where Mail's behaviour for re-filing a message into the
 * mailbox it already occupies is unspecified — the delta is classified `unknown`
 * with `expected: null` and no comparison is made at all. Warning off a guessed
 * expectation would fire on an operation that did exactly what it was asked to.
 *
 * `under`, by contrast, is routine and never warns. Apple Mail's `delete` on an
 * account whose deleted mail is not moved to Trash only sets `\Deleted`, so the
 * message stays in the mailbox and the count does not drop; a Gmail label
 * mailbox can behave the same way while the operation genuinely succeeded.
 * Warning there would fire on ordinary deletes on ordinary accounts — and a
 * warning that cries wolf is ignored precisely when it matters.
 */
export function countDeltaWarning(d: CountDelta): string | null {
  // `expected: null` means no comparison was possible, so there is nothing to
  // be over. The status check alone would already cover it; both are asserted
  // so a future status change cannot resurrect a warning without an expectation.
  if (d.status !== "over" || d.expected === null) return null;
  const extra = (d.observed ?? 0) - d.expected;
  const where = d.account ? `"${d.mailbox}" in account "${d.account}"` : `"${d.mailbox}"`;
  return (
    `⚠️ Effect mismatch in ${where}: ${d.observed} message(s) left the mailbox but only ` +
    `${d.expected} were operated on (count ${d.before} → ${d.after}). ${extra} message(s) are ` +
    `unaccounted for. Anything else removing mail from this mailbox at the same moment — a ` +
    `Mail rule, a server-side filter, another client, an IMAP expunge — reads the same way, so ` +
    `rule that out first. If nothing else was touching it, this is the signature of ` +
    `https://github.com/sweetrb/apple-mail-mcp/issues/155 — please report it there, and set ` +
    `${AUDIT_LOG_ENV}=/path/to/audit.ndjson to capture which messages disappeared.`
  );
}

/** Every warning a report has to raise, in mailbox order. */
export function reconciliationWarnings(report: DestructiveOpReport): string[] {
  return report.countDeltas.map(countDeltaWarning).filter((w): w is string => w !== null);
}
