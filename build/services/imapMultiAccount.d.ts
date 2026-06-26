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
import { type ImapSearchArgs, type ImapConfig, type ImapDeps } from "../services/imapClient.js";
import type { Account } from "../types.js";
/** A structured message row as emitted by either backend (permissive on keys). */
export type MessageRow = Record<string, unknown>;
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
export declare function dedupKey(row: MessageRow): string;
/**
 * Merge IMAP rows with AppleScript rows: concatenate, de-dup by {@link dedupKey}
 * preferring the IMAP copy (IMAP rows are passed first and win on collision),
 * sort newest-first by dateReceived, then apply `limit`.
 */
export declare function mergeMessages(imapRows: MessageRow[], appleRows: MessageRow[], limit: number): MessageRow[];
/** Gmail/Workspace IMAP host? Its `[Gmail]/All Mail` virtual mailbox is Gmail-only. */
export declare function isGmailHost(host: string): boolean;
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
export declare function fanOutImapMessages(args: ImapSearchArgs, kind: "search" | "list", deps?: Omit<ImapDeps, "config" | "account">, configs?: ImapConfig[]): Promise<{
    rows: MessageRow[];
    accountsQueried: string[];
    accountsFailed: string[];
}>;
/**
 * Per-pair matcher: does this IMAP config correspond to this Mail.app account?
 * Compared case-insensitively, the config's `accountLabel` AND `user` against the
 * Mail account's `name` AND `email`. An empty email can't match (avoids
 * `"" === ""` false positives). This is the single source of truth for coverage;
 * everything else delegates here.
 */
export declare function configMatchesAccount(config: ImapConfig, account: Account): boolean;
/** True when ANY config matches this Mail account (delegates to the per-pair matcher). */
export declare function isAccountCoveredByImap(account: Account, configs: ImapConfig[]): boolean;
/**
 * Split Mail.app accounts into those covered by IMAP (counted via IMAP) and the
 * rest (counted via AppleScript), so reads/counts skip the AppleScript scan for
 * IMAP-covered accounts.
 */
export declare function partitionAccountsForCounts(accounts: Account[], configs: ImapConfig[]): {
    imapCovered: Account[];
    appleScriptOnly: Account[];
};
/**
 * One unit to count for the count tools (get-unread-count / get-mail-stats),
 * carrying exactly ONE source so every account is counted once and only once:
 *   - `{ kind: "imap", config }`        — count this account via IMAP STATUS;
 *   - `{ kind: "applescript", account }`— count this Mail account via AppleScript.
 */
export type CountSource = {
    kind: "imap";
    config: ImapConfig;
    label: string;
} | {
    kind: "applescript";
    account: Account;
    label: string;
};
/**
 * Plan the count sources so NO account is double-counted even when the coverage
 * heuristic mis-matches (the failure mode the naive `Σimap(all configs) +
 * Σapple(uncovered)` had: a config that fails to match its Mail account lands in
 * BOTH sums).
 *
 * Account-centric: walk the Mail.app accounts; each is counted via its FIRST
 * matching config (IMAP) or, if none matches, via AppleScript. Then any IMAP
 * config that matched NO Mail account (configured-but-not-present-in-Mail.app) is
 * added once as an IMAP source. A config is consumed by at most one Mail account,
 * so two Mail accounts can't both claim the same config and inflate the total.
 */
export declare function planCountSources(accounts: Account[], configs: ImapConfig[]): CountSource[];
/**
 * Render the structured message rows into the human text block the read tools
 * emit (`  - ID: … | date | subject (from: sender) [read|unread]`). Shared so the
 * merged path matches the single-backend formatting. `showReadState` mirrors
 * search/list (which show [read]) vs. plain list rows.
 */
export declare function formatMergedRows(rows: MessageRow[], showReadState?: boolean): string;
//# sourceMappingURL=imapMultiAccount.d.ts.map