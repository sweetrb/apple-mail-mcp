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
/** How many messages the snapshot reads from Mail in ONE request. */
export const AUDIT_SNAPSHOT_CHUNK_ENV = "APPLE_MAIL_MCP_AUDIT_SNAPSHOT_CHUNK";

/** Default collateral-snapshot ceiling (messages per mailbox). */
export const DEFAULT_SNAPSHOT_MAX = 2000;

/** Default snapshot slice size (messages per Apple Event round trip). */
export const DEFAULT_SNAPSHOT_CHUNK = 250;

/** How many times one slice is attempted before it is recorded as unobserved. */
export const SNAPSHOT_SLICE_ATTEMPTS = 2;

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
 * Snapshot slice size: how many messages are read from Mail per request.
 *
 * The snapshot used to issue ONE whole-mailbox read (`id of messages of mb`).
 * That is the cheapest possible shape when it works, and it is also the shape
 * that fails outright when Mail declines — which it does more often the bigger
 * the mailbox is. So the one mechanism that can attribute collateral damage was
 * least reliable exactly when the blast radius was largest (#176). Reading in
 * bounded slices trades a few more Apple Events for a request size that stays
 * constant as the mailbox grows, and lets a failure cost one slice instead of
 * the whole snapshot.
 *
 * Clamped to at least 1 — a zero or negative slice would loop forever.
 */
export function auditSnapshotChunk(): number {
  const raw = process.env[AUDIT_SNAPSHOT_CHUNK_ENV]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_SNAPSHOT_CHUNK;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SNAPSHOT_CHUNK;
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
   * `ok` — both snapshots were read in full and diffed.
   * `partial` — at least one snapshot has a hole: some slices of the mailbox
   *   could not be read even after a retry. Some of the diff is still sound and
   *   is reported; the rest is withheld. See `unobserved` and the rules below.
   * `skipped` — deliberately not taken (over the ceiling, or the ids had no
   *   single source mailbox). `skipReason` says which.
   * `unavailable` — Mail produced no usable snapshot at all.
   *
   * ## Why `partial` withholds rather than reports whatever it has (#176)
   *
   * A hole in the AFTER snapshot poisons `disappeared`: a message read before
   * and not read after may have left, or may simply be sitting in the range
   * that could not be read. Reporting it would put an innocent message's name
   * in front of someone mid-incident as evidence of data loss — a fabricated
   * finding, which is worse than the gap it papers over. Symmetrically, a hole
   * in the BEFORE snapshot poisons `appeared`.
   *
   * So each half of the diff is gated on the completeness of the snapshot that
   * can refute it, not on both:
   *
   * - `disappeared` / `unrequested` — present only when the AFTER snapshot is
   *   complete. A hole in BEFORE only makes them an UNDERCOUNT (a message never
   *   read before cannot be missed after), which is honest as far as it goes.
   * - `appeared` — present only when the BEFORE snapshot is complete.
   *
   * An absent array therefore means "not computable", never "empty". Consumers
   * must not read `disappeared?.length ?? 0` as "nothing disappeared" — check
   * `snapshot === "ok"` first, which is what `falseOkWarning` does.
   */
  snapshot: "ok" | "partial" | "skipped" | "unavailable";
  skipReason?: string;
  /**
   * The slices of the mailbox that could not be read, per phase — 1-based
   * position ranges as Mail indexes them (`"251-500,900-1000"`). Present only
   * when `snapshot === "partial"`, and this is what makes the gap nameable:
   * "nothing unrequested left the 400 messages I could see, and I could not see
   * the other 120" is strictly more useful than no diff at all.
   */
  unobserved?: { phase: "before" | "after"; ranges: string }[];
  /**
   * Messages present before and absent after. Omitted when the after snapshot
   * is incomplete — see the `partial` rules above.
   */
  disappeared?: { id: string; messageId: string }[];
  /**
   * The subset of `disappeared` whose numeric id was NEVER in the caller's id
   * list. A non-empty array here IS the #155 symptom, with names attached.
   */
  unrequested?: { id: string; messageId: string }[];
  /**
   * Messages absent before and present after (new mail arriving mid-op).
   * Omitted when the before snapshot is incomplete.
   */
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

/**
 * The one `under` reading that is NOT routine: a total no-op reported as success.
 *
 * The blanket `under` suppression above is justified by accounts that flag
 * `\Deleted` without removing the message, so the source count never drops. That
 * argument holds for the *shape* of the account, not for every reading — and it
 * suppressed a real defect (#155, reported on iCloud against 2.10.17):
 *
 * ```json
 * {"outcomes":[{"id":"68196","status":"ok"}, ...4 ids all "ok"],
 *  "countDeltas":[{"before":29,"after":29,"expected":4,"observed":0,"status":"under"}],
 *  "collateral":[{"snapshot":"ok","disappeared":[],"unrequested":[],"appeared":[]}]}
 * ```
 *
 * Four successes reported for an operation in which, by this server's own
 * measurement, nothing happened.
 *
 * The discriminator is the collateral snapshot. A flag-only account removes
 * nothing observably — but so does a total no-op, and the two are
 * indistinguishable *only when the snapshot could not be taken*. Here it was
 * taken, it read the mailbox fine, and it says nothing left. Requiring
 * `snapshot === "ok"` and an empty `disappeared` is what keeps this from firing
 * on the ordinary flag-only delete the blanket suppression exists to protect.
 *
 * Deliberately narrow: `observed === 0` only. A partial under (3 of 4 removed)
 * stays unwarned, because that is exactly where a flag-only account and a
 * partial failure DO look alike.
 *
 * `snapshot === "ok"` also excludes a PARTIAL snapshot (#176), and must keep
 * doing so. A partial snapshot's `disappeared` is either absent or an
 * undercount, so "nothing left the mailbox" is precisely the claim it cannot
 * support — warning off it would fire on a flag-only account whose snapshot
 * merely had a hole in it.
 */
export function falseOkWarning(d: CountDelta, collateral?: CollateralDiff): string | null {
  if (d.status !== "under" || d.expected === null) return null;
  if (d.observed !== 0 || d.expected <= 0) return null;
  if (!collateral || collateral.snapshot !== "ok") return null;
  if ((collateral.disappeared?.length ?? 0) !== 0) return null;

  const where = d.account ? `"${d.mailbox}" in account "${d.account}"` : `"${d.mailbox}"`;
  return (
    `⚠️ Reported success with no observed effect in ${where}: ${d.expected} message(s) were ` +
    `operated on and reported ok, but the mailbox count did not move (${d.before} → ${d.after}) ` +
    `and the collateral snapshot — which read this mailbox successfully — shows no message left ` +
    `it. Either the operation silently did nothing, or Mail's count and listing are both stale ` +
    `and the messages did move. Check the destination (Trash for a delete) before assuming ` +
    `either: if they are there, this is a measurement-timing bug; if they are still in the ` +
    `source mailbox minutes later, the operation failed while reporting success. Please report ` +
    `at https://github.com/sweetrb/apple-mail-mcp/issues/155 with ` +
    `${AUDIT_LOG_ENV}=/path/to/audit.ndjson set.`
  );
}

/** Every warning a report has to raise, in mailbox order. */
export function reconciliationWarnings(report: DestructiveOpReport): string[] {
  const collateralFor = (d: CountDelta) =>
    report.collateral.find((c) => c.account === d.account && c.mailbox === d.mailbox);
  return report.countDeltas
    .flatMap((d) => [countDeltaWarning(d), falseOkWarning(d, collateralFor(d))])
    .filter((w): w is string => w !== null);
}
