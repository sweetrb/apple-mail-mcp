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
import { imapSearchMessages, imapListMessages, resolveImapConfigs, } from "../services/imapClient.js";
/**
 * Normalize a Message-ID for comparison: strip surrounding angle brackets and
 * whitespace, lowercase. Returns undefined when the row has no usable id.
 */
function normalizeMessageId(row) {
    const raw = typeof row.messageId === "string" ? row.messageId.trim() : "";
    if (!raw)
        return undefined;
    const inner = raw.replace(/^<+|>+$/g, "").trim();
    return inner ? inner.toLowerCase() : undefined;
}
/**
 * Normalize a subject the same way the thread tool does for grouping: drop
 * leading Re:/Fwd: prefixes, collapse whitespace, lowercase. Kept local (and
 * deliberately simple) so the merge has no dependency cycle with the thread
 * module; exactness isn't required — this only feeds the fallback dedup key.
 */
function normalizeSubjectForKey(subject) {
    const s = typeof subject === "string" ? subject : "";
    return s
        .replace(/^(\s*(re|fwd|fw|aw|sv|antw)\s*:\s*)+/i, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}
/** Epoch ms of the row's dateReceived (ISO string or Date), or 0 when absent. */
function dateEpoch(row) {
    const d = row.dateReceived;
    if (d instanceof Date)
        return d.getTime();
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
export function dedupKey(row) {
    const mid = normalizeMessageId(row);
    if (mid)
        return `mid:${mid}`;
    const subject = normalizeSubjectForKey(row.subject);
    const sender = (typeof row.sender === "string" ? row.sender : "").trim().toLowerCase();
    return `k:${subject}|${sender}|${dateEpoch(row)}`;
}
/**
 * Merge IMAP rows with AppleScript rows: concatenate, de-dup by {@link dedupKey}
 * preferring the IMAP copy (IMAP rows are passed first and win on collision),
 * sort newest-first by dateReceived, then apply `limit`.
 */
export function mergeMessages(imapRows, appleRows, limit) {
    const byKey = new Map();
    // IMAP first so its copy wins; AppleScript only fills keys IMAP didn't supply.
    for (const r of imapRows) {
        const k = dedupKey(r);
        if (!byKey.has(k))
            byKey.set(k, r);
    }
    for (const r of appleRows) {
        const k = dedupKey(r);
        if (!byKey.has(k))
            byKey.set(k, r);
    }
    const merged = [...byKey.values()];
    merged.sort((a, b) => dateEpoch(b) - dateEpoch(a)); // newest first
    return limit >= 0 ? merged.slice(0, limit) : merged;
}
/** Gmail/Workspace IMAP host? Its `[Gmail]/All Mail` virtual mailbox is Gmail-only. */
export function isGmailHost(host) {
    return /(^|\.)gmail\.com$/i.test(host.trim());
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
export async function fanOutImapMessages(args, kind, deps = {}, configs = resolveImapConfigs()) {
    const rows = [];
    const accountsQueried = [];
    const accountsFailed = [];
    for (const config of configs) {
        // Default-mailbox resolution is PER-ACCOUNT: the single-account search default
        // ("[Gmail]/All Mail") is Gmail-only, so fanning it out to a non-Gmail account
        // (e.g. iCloud) makes that SELECT fail and the account silently drops from the
        // merged results. When the caller pinned no mailbox, give Gmail hosts their
        // All-Mail default (undefined → resolved downstream) and every other host a
        // universal "INBOX". (limit is applied AFTER the cross-account merge so the
        // global newest-N is correct even when one account dominates.)
        const mailbox = args.mailbox ?? (isGmailHost(config.host) ? undefined : "INBOX");
        const perAccountArgs = { ...args, account: undefined, mailbox };
        try {
            const res = kind === "search"
                ? await imapSearchMessages(perAccountArgs, { ...deps, config })
                : await imapListMessages(perAccountArgs, { ...deps, config });
            rows.push(...res.messages);
            accountsQueried.push(config.accountLabel);
        }
        catch (e) {
            accountsFailed.push(config.accountLabel);
            console.error(`IMAP fan-out failed for account "${config.accountLabel}": ${String(e)}`);
        }
    }
    return { rows, accountsQueried, accountsFailed };
}
// ---------------------------------------------------------------------------
// Account coverage + count partitioning (reads, get-unread-count, get-mail-stats)
//
// Coverage is decided per (config, Mail-account) PAIR by configMatchesAccount.
// - Message-list reads use partitionAccountsForCounts to run AppleScript ONLY
//   for accounts no IMAP config covers (IMAP fans out over the configs), so an
//   all-IMAP user runs zero AppleScript and never depends on composite dedup.
// - Count tools use planCountSources, which assigns each account EXACTLY ONE
//   source (its matching config, else AppleScript) and adds any config that
//   matched no account once — so even a heuristic MISS can't double-count.
//
// Matching is case-insensitive on the config's accountLabel/user vs. the Mail
// account's name/email. accountLabel defaults to the login address and users
// typically set it to the Mail.app account NAME, so checking both against both
// catches the common setups (label=accountName, label=email, login=email).
// ---------------------------------------------------------------------------
/**
 * Per-pair matcher: does this IMAP config correspond to this Mail.app account?
 * Compared case-insensitively, the config's `accountLabel` AND `user` against the
 * Mail account's `name` AND `email`. An empty email can't match (avoids
 * `"" === ""` false positives). This is the single source of truth for coverage;
 * everything else delegates here.
 */
export function configMatchesAccount(config, account) {
    const name = account.name.trim().toLowerCase();
    const email = (account.email ?? "").trim().toLowerCase();
    const label = config.accountLabel.trim().toLowerCase();
    const user = config.user.trim().toLowerCase();
    return (label === name || (!!email && label === email) || user === name || (!!email && user === email));
}
/** True when ANY config matches this Mail account (delegates to the per-pair matcher). */
export function isAccountCoveredByImap(account, configs) {
    return configs.some((c) => configMatchesAccount(c, account));
}
/**
 * Split Mail.app accounts into those covered by IMAP (counted via IMAP) and the
 * rest (counted via AppleScript), so reads/counts skip the AppleScript scan for
 * IMAP-covered accounts.
 */
export function partitionAccountsForCounts(accounts, configs) {
    const imapCovered = [];
    const appleScriptOnly = [];
    for (const a of accounts) {
        if (isAccountCoveredByImap(a, configs))
            imapCovered.push(a);
        else
            appleScriptOnly.push(a);
    }
    return { imapCovered, appleScriptOnly };
}
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
export function planCountSources(accounts, configs) {
    const sources = [];
    const usedConfigs = new Set();
    for (const account of accounts) {
        const match = configs.find((c) => !usedConfigs.has(c) && configMatchesAccount(c, account));
        if (match) {
            usedConfigs.add(match);
            sources.push({ kind: "imap", config: match, label: account.name });
        }
        else {
            sources.push({ kind: "applescript", account, label: account.name });
        }
    }
    // IMAP accounts that exist in config but not in Mail.app — count them once.
    for (const config of configs) {
        if (!usedConfigs.has(config)) {
            sources.push({ kind: "imap", config, label: config.accountLabel });
        }
    }
    return sources;
}
/**
 * Render the structured message rows into the human text block the read tools
 * emit (`  - ID: … | date | subject (from: sender) [read|unread]`). Shared so the
 * merged path matches the single-backend formatting. `showReadState` mirrors
 * search/list (which show [read]) vs. plain list rows.
 */
export function formatMergedRows(rows, showReadState = true) {
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
