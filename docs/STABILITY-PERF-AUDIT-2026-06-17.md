# apple-mail-mcp — Stability & Performance Audit

**Date:** 2026-06-17 · **Version audited:** 1.6.1 (`main` @ `4b5610d`)
**Scope:** full codebase — `appleMailManager.ts` (2652 LOC), `index.ts`, `utils/{applescript,serialize,mimeParse}.ts`, CI/publish workflows.

This audit looks only at robustness and speed; feature gaps and style are out of scope. Findings are ranked by **impact × likelihood**, with effort estimates so they can be scheduled. Line numbers are against `main` @ `4b5610d`.

## Summary

The architecture is sound and several hard problems are already solved well (serial gate for Mail's single-threaded dispatch #11, the `with timeout`/SIGKILL executor, the `error:`-prefix protocol that surfaces AppleScript failures, the #24 search count-guard). The remaining risks cluster into four themes:

1. **Swallowed failures that masquerade as empty/zero success** — the #24 family. Several read methods still do this (`list-messages`, `get-mail-stats`, `get-recently-received`, by-id lookups). This is the single highest-value theme because it produces *confidently wrong* answers.
2. **The `1 MB execSync buffer** — every osascript call is capped at Node's default `maxBuffer`, so large messages/sources silently fail.
3. **`|||` delimiter collisions** — the string serialization corrupts on any field containing `|||`.
4. **N× full-tree-walk fan-out** in batch operations — correct but pathologically slow at scale.

## Priority table

| # | Sev | Type | Finding | Effort |
|---|-----|------|---------|--------|
| 1 | High | stability | No `maxBuffer` on `execSync` → 1 MB cap truncates/throws on large messages, `getRawSource`, attachment extraction | S |
| 2 | High | stability | `get-mail-stats` / `get-recently-received` reintroduce the #15 locale bug + swallow → silent `0/0/0` | S |
| 3 | High | stability | `list-messages` & by-id lookups still have the #24 unbounded-all-mailbox + swallowed-timeout pattern (false empty) | M |
| 4 | High | stability | `\|\|\|` / `\|\|\|ITEM\|\|\|` delimiter collisions corrupt every parser on hostile/odd field values | M |
| 5 | High | perf | Batch ops are N separate osascript spawns, each a full account→mailbox→`whose id` tree walk | M |
| 6 | Med | perf/stability | `get-message` always reads full `source of msg` for attachmentless messages (slow; trips finding #1) | S |
| 7 | Med | stability | `get-message preferHtml` returns raw MIME source mislabeled as `htmlContent` (dumps base64 into context) | S |
| 8 | Med | stability | All-mailbox stat methods (`list-mailboxes`, `get-unread-count`, `get-sync-status`) on default 30s → silent empty/zero on timeout | S |
| 9 | Med | stability | `rename-mailbox` move-then-delete has no rollback / partial-move accounting (data-loss risk on large mailboxes) | M |
| 10 | Med | stability | `escapeForAppleScript` doesn't neutralize newlines/control chars in interpolated names/subjects | S |
| 11 | Low | perf | Per-message property round-trips in search/list (≥6 reads/msg); could bulk-read on small mailboxes | M |
| 12 | Low | stability | `saveAttachment` path-prefix check uses bare `startsWith` (sibling-prefix bypass: `/Volumes` vs `/Volumes-evil`) | S |
| 13 | Low | stability | `searchContacts` lacks per-person `try` → one bad contact aborts the whole search | S |
| 14 | Low | stability | `useTemplate` `overrides.x || template.x` drops intentional empty-string overrides; templates in-memory only | S |
| 15 | Low | process | Integration suite can't run in CI; real-Mail regressions only caught by local `npm run test:all` | M |

Effort: S ≈ <½ day, M ≈ ½–2 days.

---

## High severity

### 1. No `maxBuffer` on `execSync` — 1 MB cap truncates large outputs
`executeAppleScript` (`utils/applescript.ts:349`) calls `execSync` with `encoding`, `timeout`, `killSignal`, `stdio` — but **no `maxBuffer`**, so Node's 1 MB default applies to every Mail operation. `getRawSource` (`appleMailManager.ts:922`) explicitly anticipates *20 MB* sources; `getMessageContent` returns full `source of msg` as `htmlContent`; large `search`/`list` outputs accumulate too. When output exceeds 1 MB, `execSync` throws `ENOBUFS`, which the executor reports as a failure, and the caller returns `null` → the user sees "message not found" / "attachment not found" or missing body for exactly the large/attachment-bearing messages where it matters most.
**Fix:** set a generous `maxBuffer` (e.g. 64 MB) in the `execSync` options, ideally configurable via env. Cheap and high-value.

### 2. `get-mail-stats` / `get-recently-received` — locale bug + swallow → silent `0/0/0`
`getRecentlyReceivedStats` (`appleMailManager.ts:2506`) builds AppleScript date thresholds with hard-coded English month names: `date "January 5, 2026"` (`formatDate`, lines 2514–2539). This is the exact construct issue **#15** replaced with the locale-independent `buildAppleScriptDate` (line ~246) because `date "May 30, 2026"` throws *"Invalid date and time (-30720)"* on non-English system locales. The throw is swallowed by the nested per-account/per-inbox `try` blocks (2542, 2546), so on any non-English locale the method returns `{last24h:0, last7d:0, last30d:0}` as a clean success — and it feeds `getMailStats`. A correctness regression of the same class as #24.
**Fix:** build the three thresholds with `buildAppleScriptDate`; surface failure instead of returning zero.

### 3. `list-messages` and by-id lookups still carry the #24 pattern
The #24 fix landed only on `searchMessages`. `listMessages` (all-mailboxes branch, `appleMailManager.ts:803–842`) still iterates every mailbox with an unbounded `messages of mb` materialization and a swallowing per-mailbox `try`, returning `[]` on timeout — a false "No messages found" on large multi-account setups. `getMessageById` / `getMessageContent` / `getRawSource` (789–942) likewise walk every mailbox of every account with no count-guard and a swallowing `on error … return ""`, so a slow account makes a real message look deleted.
**Fix:** extend the #24 approach (count-guard via `APPLE_MAIL_MAX_SEARCH_MAILBOX`, per-account budget, partial-result diagnostics) to `listMessages`; for by-id lookups, add the count-guard and distinguish "not found" from "timed out."

### 4. `|||` delimiter collisions corrupt parsing
Results are serialized by concatenating fields with the literal `"|||"` and records with `"|||ITEM|||"`, then split in TS. No field value is sanitized first. Any subject, sender, contact name, attachment filename, or mailbox name containing `|||` shifts every subsequent field. Vulnerable parsers include `parseMessageList` (~1086), `getMessageById` (843), `getMessageContent` (898), `listAttachments` (~1785), `listMailboxes` (~1938), `fetchAccounts` (~2127), `listRules` (~2193), `searchContacts` (~2285), `getSyncStatus` (~2639). Concretely, an attachment named `report|||v2.pdf` makes the parser read `v2.pdf` as the MIME type and `parseInt` the size as `0`. `fetchMailboxNames` (~2148) is a separate variant that splits on `", "`, colliding with any mailbox name containing a comma-space.
**Fix:** switch field/record separators to ASCII control characters that cannot appear in mail text (Unit Separator ``, Record Separator ``), or length-prefix/JSON-encode each record. Update both the AppleScript emitters and the TS parsers together.

### 5. Batch operations are N× full-tree-walk osascript spawns
`batchDeleteMessages` (1656), `batchMoveMessages` (1679), `batchMarkAsRead/Unread` (1697/1709), `batchFlag/Unflag` (1725+) each loop over the ids calling the single-id method. Every single-id method spawns its own osascript and walks `accounts → mailboxes of acct → messages whose id is …` to locate one message. So a 100-id batch = 100 processes, each a full breadth-first tree scan with a `whose id` query per mailbox, all serialized through the gate — minutes to hours on large accounts. (The batch APIs are capped at 100 ids, which bounds but doesn't fix it.)
**Fix:** one AppleScript that takes the whole id list, walks the tree once, and returns a per-id result vector; parse into `BatchOperationResult[]`.

---

## Medium severity

### 6. `get-message` always full-source-scans attachmentless messages
`getMessageById` (789) computes `hasAttachments` by reading the entire `source of msg` whenever the fast attachment count is 0 (819–824), to catch MIME-embedded attachments. That's the slowest part of the common path and it interacts badly with finding #1 (1 MB cap). **Fix:** make the source-scan opt-in (e.g. a `deepAttachmentCheck` flag) or skip it when the fast count suffices for the caller.

### 7. `preferHtml` returns raw MIME, not HTML
`getMessageContent` (865) sets `htmlContent = source of msg` — the entire raw MIME (headers + base64 attachments), not the HTML body. `get-message preferHtml:true` (`index.ts:256`) then returns that whole blob into the model context: token blowup plus the 1 MB buffer risk. **Fix:** extract the `text/html` MIME part (you already have `mimeParse.ts`), or rename/redocument and bound the size.

### 8. All-mailbox stat methods silently degrade on 30s timeout
`listMailboxes` (~1913), `getUnreadCount` no-mailbox path (~1966), `getSyncStatus` (~2607) iterate all mailboxes/accounts at the **default 30s** timeout and return `[]`/`0` on timeout — a false "all read"/"no mailboxes." **Fix:** raise timeouts for these aggregate scans and surface partial/error rather than benign zeros.

### 9. `rename-mailbox` partial-move data-loss risk
`renameMailbox` (~2046) creates the destination, moves messages in a loop, then deletes the source — all in one `try`. A mid-loop error jumps to `on error` with no rollback and no count of how many moved, leaving messages split across two mailboxes; mutating `messages of srcMailbox` while iterating it is itself unsafe. On a large mailbox the move can also exceed the 60s timeout and be SIGKILLed before completion. **Fix:** snapshot ids, verify source/destination counts match before deleting the source, and report partial moves.

### 10. `escapeForAppleScript` doesn't handle newlines/control chars
`escapeForAppleScript` (155) escapes `\` and `"` but not raw newlines. AppleScript string literals can't span raw newlines, so a mailbox/template/contact name or subject containing `\n` can terminate the literal and inject a statement (or just error). Inputs are otherwise nicely escaped/validated — this is the one gap. **Fix:** strip or escape control characters (`\n`, `\r`, `\t`, line-continuation) in the escape function.

---

## Low severity

- **11 — per-message round-trips** (search/list): each emitted message does ≥6 property reads (`subject of msg`, `sender of msg`, …); on a mailbox these are serial Apple Events. Bulk list-property reads (`subject of msgs`, `sender of msgs`) cut round-trips on the small mailboxes that survive the #24 guard. Measure first.
- **12 — `saveAttachment` prefix check** (~1831/1890): `startsWith(homedir())` allows `/Users/robother`; `startsWith("/Volumes")` allows `/Volumes-evil`. Compare against `prefix + path.sep` or use a `path.relative` containment check.
- **13 — `searchContacts`** (~2250): no per-person `try`, so one contact with no `emails` aborts the scan and returns `[]`. Wrap the per-person read.
- **14 — templates**: `useTemplate` `overrides.subject || template.subject` (~2358) discards an intentional `""` override; the `Map` is in-memory and `nextTemplateId` resets to 1 each start, so ids collide across restarts. Documented limitation — note in README or persist.
- **15 — CI can't run integration tests**: `ci.yml` runs unit tests/lint/typecheck/build + a nice "committed build/ matches source" guard, but the real-Mail `test:integration` suite needs a GUI Mail.app and so only runs locally. Real AppleScript regressions can ship. Mitigation: make `npm run test:all` a documented pre-release gate (or a self-hosted runner).

---

## What's already done well (don't regress these)

- **Serial gate** (`utils/serialize.ts`) — correctly funnels all Mail calls through one promise chain with a settle delay; the right fix for Mail's single-threaded dispatch (#11).
- **Executor hardening** (`utils/applescript.ts`) — `with timeout` a few seconds under the process timeout so Mail aborts cleanly from inside its own dispatch, `SIGKILL` to reap wedged osascript, retry with backoff on transient errors, user-friendly error mapping.
- **`error:`-prefix protocol** — move/delete/reply/forward/mark/mailbox ops return `"error:" & errMsg` from `on error` and TS checks for it, surfacing AppleScript-level failures that `result.success` alone misses. The methods that *don't* use it (findings #2, #3, #8) are exactly where the swallow bugs live.
- **`moveMessageInternal`** — account-scoped resolution, explicit ambiguity refusal, distinct error strings, `{success,error}` return; the model the batch path should adopt.
- **Attachment input validation** — rejects path traversal/separators/null in names; resolves + prefix-checks save paths (modulo the `startsWith` nit in #12).
- **Cache stores mailbox *names* only** (not counts) with invalidation wired on the three structure-changing ops — the right call.
- **#24 search fix** — count-guard + per-account budget + partial diagnostics; findings #2/#3/#8 are about extending that discipline to the rest of the read surface.

## Suggested sequencing

1. **Quick wins (one small PR):** #1 maxBuffer, #2 locale/swallow, #10 escape control chars, #12 prefix check. All small, all pure stability.
2. **The swallow-family PR:** #3 (extend #24 guard to list/by-id) + #8 (aggregate stat timeouts) — shares code with the #24 work.
3. **The serialization PR:** #4 delimiters (touches many emitters/parsers; do it once, carefully, with tests).
4. **The perf PR:** #5 batch single-walk, then measure #11 before investing.
5. #6/#7/#9 as standalone medium fixes.
