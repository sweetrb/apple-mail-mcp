/**
 * Multi-account read merge (v2.6.0 — prefer-IMAP reads).
 *
 * v2.6.0 flips the read tools to PREFER direct IMAP whenever IMAP is configured
 * (see `shouldUseImap` in imapClient.ts). When a read is issued with NO explicit
 * account, results must still cover EVERY account the user has — so we:
 *
 *   1. fan the IMAP query out over every configured IMAP account
 *      (`resolveImapConfigs()`), and
 *   2. ALSO run the existing AppleScript all-accounts path,
 *
 * then merge the two, de-duplicating any message that appears in both backends
 * (e.g. a Gmail account that is both IMAP-configured AND visible to Mail.app's
 * AppleScript scan) and preferring the IMAP copy (it carries the round-trippable
 * `imap:` id that the mutation tools need).
 *
 * This module holds the backend-agnostic merge/dedup/sort + the per-account IMAP
 * fan-out so the three message-list sites (search-messages, get-thread,
 * list-messages) don't each re-implement it.
 *
 * @module services/imapMultiAccount
 */
import {
  imapSearchMessages,
  imapListMessages,
  resolveImapConfigs,
  type ImapSearchArgs,
  type ImapConfig,
  type ImapDeps,
} from "@/services/imapClient.js";
import type { Account } from "@/types.js";

/** A structured message row as emitted by either backend (permissive on keys). */
export type MessageRow = Record<string, unknown>;

/**
 * Normalize a Message-ID for comparison: strip surrounding angle brackets and
 * whitespace, lowercase. Returns undefined when the row has no usable id.
 */
function normalizeMessageId(row: MessageRow): string | undefined {
  const raw = typeof row.messageId === "string" ? row.messageId.trim() : "";
  if (!raw) return undefined;
  const inner = raw.replace(/^<+|>+$/g, "").trim();
  return inner ? inner.toLowerCase() : undefined;
}

/**
 * Normalize a subject the same way the thread tool does for grouping: drop
 * leading Re:/Fwd: prefixes, collapse whitespace, lowercase. Kept local (and
 * deliberately simple) so the merge has no dependency cycle with the thread
 * module; exactness isn't required — this only feeds the fallback dedup key.
 */
function normalizeSubjectForKey(subject: unknown): string {
  const s = typeof subject === "string" ? subject : "";
  return s
    .replace(/^(\s*(re|fwd|fw|aw|sv|antw)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Epoch ms of the row's dateReceived (ISO string or Date), or 0 when absent. */
function dateEpoch(row: MessageRow): number {
  const d = row.dateReceived;
  if (d instanceof Date) return d.getTime();
  if (typeof d === "string" && d) {
    const t = new Date(d).getTime();
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

/**
 * Cross-backend dedup key for a message row.
 *
 *   - PREFER the normalized Message-ID when present (`mid:<id>`). It's the only
 *     globally-unique identity, so two IMAP accounts that both hold the very
 *     same message (rare, but possible with multi-delivery) collapse to one.
 *   - FALL BACK to `normalizedSubject|sender|dateReceivedEpoch` when no
 *     Message-ID is available. The AppleScript backend never exposes a
 *     Message-ID, so this composite is what actually dedups the common case: a
 *     Gmail account surfaced by BOTH the IMAP fan-out and the AppleScript
 *     all-accounts scan. The IMAP and AppleScript copies of one message share
 *     the same subject, sender, and received timestamp, so they collide here.
 *
 * Limitation (note for live testing): the composite key assumes the two backends
 * report the SAME received timestamp to the second. If Mail.app and the IMAP
 * server disagree on `dateReceived` (timezone/rounding), a message could escape
 * dedup and appear twice. Message-ID dedup (IMAP-vs-IMAP) is exact; the
 * composite is best-effort.
 */
export function dedupKey(row: MessageRow): string {
  const mid = normalizeMessageId(row);
  if (mid) return `mid:${mid}`;
  const subject = normalizeSubjectForKey(row.subject);
  const sender = (typeof row.sender === "string" ? row.sender : "").trim().toLowerCase();
  return `k:${subject}|${sender}|${dateEpoch(row)}`;
}

/**
 * Merge IMAP rows with AppleScript rows: concatenate, de-dup by {@link dedupKey}
 * preferring the IMAP copy (IMAP rows are passed first and win on collision),
 * sort newest-first by dateReceived, then apply `limit`.
 */
export function mergeMessages(
  imapRows: MessageRow[],
  appleRows: MessageRow[],
  limit: number
): MessageRow[] {
  const byKey = new Map<string, MessageRow>();
  // IMAP first so its copy wins; AppleScript only fills keys IMAP didn't supply.
  for (const r of imapRows) {
    const k = dedupKey(r);
    if (!byKey.has(k)) byKey.set(k, r);
  }
  for (const r of appleRows) {
    const k = dedupKey(r);
    if (!byKey.has(k)) byKey.set(k, r);
  }
  const merged = [...byKey.values()];
  merged.sort((a, b) => dateEpoch(b) - dateEpoch(a)); // newest first
  return limit >= 0 ? merged.slice(0, limit) : merged;
}

/**
 * Fan an IMAP message query out over EVERY configured IMAP account and return
 * the concatenated structured rows (not yet merged with AppleScript, not yet
 * limited — the caller merges + limits). `kind` picks the underlying query so
 * the mailbox-default and unreadOnly semantics match the single-account path.
 *
 * Per-account failures are swallowed (logged) so one unreachable account doesn't
 * sink the whole read; the returned `accountsQueried`/`accountsFailed` let the
 * caller surface partial-coverage diagnostics.
 */
export async function fanOutImapMessages(
  args: ImapSearchArgs,
  kind: "search" | "list",
  deps: Omit<ImapDeps, "config" | "account"> = {},
  configs: ImapConfig[] = resolveImapConfigs()
): Promise<{ rows: MessageRow[]; accountsQueried: string[]; accountsFailed: string[] }> {
  const rows: MessageRow[] = [];
  const accountsQueried: string[] = [];
  const accountsFailed: string[] = [];
  // Over-fetch per account (limit applied AFTER the cross-account merge so the
  // global newest-N is correct even when one account dominates).
  const perAccountArgs: ImapSearchArgs = { ...args, account: undefined };
  for (const config of configs) {
    try {
      const res =
        kind === "search"
          ? await imapSearchMessages(perAccountArgs, { ...deps, config })
          : await imapListMessages(perAccountArgs, { ...deps, config });
      rows.push(...res.messages);
      accountsQueried.push(config.accountLabel);
    } catch (e) {
      accountsFailed.push(config.accountLabel);
      console.error(`IMAP fan-out failed for account "${config.accountLabel}": ${String(e)}`);
    }
  }
  return { rows, accountsQueried, accountsFailed };
}

// ---------------------------------------------------------------------------
// Count partitioning (get-unread-count / get-mail-stats)
//
// For COUNT tools the merge must not double-count: an account covered by an IMAP
// config must be counted via IMAP only, never also via the AppleScript scan. We
// therefore split the Mail.app account list into the ones IMAP covers (skip on
// the AppleScript side — IMAP already counts them) and the rest (count via
// AppleScript). The IMAP totals come from summing over `resolveImapConfigs()`.
// ---------------------------------------------------------------------------

/**
 * Heuristic: is this Mail.app account covered by one of the IMAP configs?
 *
 * Matched case-insensitively against each IMAP config's `accountLabel` AND
 * `user`, compared to the Mail account's `name` AND `email`. The IMAP
 * `accountLabel` defaults to the login address (see listImapAccountSpecs), and
 * users typically set it to the Mail.app account NAME, so checking both the
 * label and the user against both the account name and email catches the common
 * configurations (label=accountName, label=email, or login=email).
 *
 * Uncertainty (note for live testing): if a user's IMAP `accountLabel` matches
 * NEITHER the Mail account name NOR its email (e.g. a freeform label), the
 * account won't be recognized as covered, and it would be counted by BOTH
 * backends. To stay safe we bias toward NOT double-counting: see
 * partitionAccountsForCounts, which treats an account as IMAP-covered (and thus
 * skipped on the AppleScript side) on any match. The trade-off is that an
 * unmatched-but-actually-IMAP account is counted once via AppleScript, which is
 * still correct (no double-count) — we just lose the IMAP speed for it.
 */
export function isAccountCoveredByImap(account: Account, configs: ImapConfig[]): boolean {
  const name = account.name.trim().toLowerCase();
  const email = (account.email ?? "").trim().toLowerCase();
  return configs.some((c) => {
    const label = c.accountLabel.trim().toLowerCase();
    const user = c.user.trim().toLowerCase();
    // Match the IMAP label/login against the Mail account's name/email. An empty
    // email can't match (avoids "" === "" false positives).
    return (
      label === name ||
      (!!email && label === email) ||
      user === name ||
      (!!email && user === email)
    );
  });
}

/**
 * Split Mail.app accounts into those covered by IMAP (counted via IMAP) and the
 * rest (counted via AppleScript), so counts merge without double-counting.
 */
export function partitionAccountsForCounts(
  accounts: Account[],
  configs: ImapConfig[]
): { imapCovered: Account[]; appleScriptOnly: Account[] } {
  const imapCovered: Account[] = [];
  const appleScriptOnly: Account[] = [];
  for (const a of accounts) {
    if (isAccountCoveredByImap(a, configs)) imapCovered.push(a);
    else appleScriptOnly.push(a);
  }
  return { imapCovered, appleScriptOnly };
}

/**
 * Render the structured message rows into the human text block the read tools
 * emit (`  - ID: … | date | subject (from: sender) [read|unread]`). Shared so the
 * merged path matches the single-backend formatting. `showReadState` mirrors
 * search/list (which show [read]) vs. plain list rows.
 */
export function formatMergedRows(rows: MessageRow[], showReadState = true): string {
  return rows
    .map((m) => {
      const date = (() => {
        const e = dateEpoch(m);
        return e ? new Date(e).toLocaleDateString() : "";
      })();
      const subject = typeof m.subject === "string" ? m.subject : "(no subject)";
      const sender = typeof m.sender === "string" ? m.sender : "(unknown)";
      const state = showReadState ? ` [${m.isRead ? "read" : "unread"}]` : "";
      return `  - ID: ${String(m.id)} | ${date} | ${subject} (from: ${sender})${state}`;
    })
    .join("\n");
}
