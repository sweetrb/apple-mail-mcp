# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.8.3] - 2026-07-06
### Fixed
- **A bare git clone now runs the server with nothing but Node present (fixes #78).** The committed `build/` gave a fresh clone the entrypoints, but the compiled output still imported its runtime dependencies from `node_modules/`, which a git clone never has. Claude Code's marketplace auto-update re-clones the plugin from scratch, so every refresh left the server dying at session start on `ERR_MODULE_NOT_FOUND: Cannot find package '@modelcontextprotocol/sdk'`, with no install step anywhere between "marketplace refresh" and "server process starts". `npm run build` now typechecks (`tsc --noEmit`) and bundles `src/index.ts` and `src/cli.ts` with esbuild into self-contained `build/index.js` and `build/cli.js` (shebangs preserved, `@/` path aliases resolved from tsconfig, plus a `createRequire` banner so the CJS dependencies' dynamic `require` calls of Node builtins work under ESM). The only runtime file the bundles read is `../package.json` (for the version string), which every distribution layout ships. `tsc-alias` is no longer needed and was dropped; the per-module compiled files and `.d.ts` output under `build/` are gone (the unused `types` field went with them), and only the two bundled entrypoints are tracked in git. (Thanks @oliverames — #79.)

## [2.8.2] - 2026-07-03
Gmail virtual-INBOX scoping/stats and symmetric server-side mailbox create/delete/rename.

### Fixed
- **Gmail virtual-INBOX handling (AppleScript path).** On Gmail / Google-Workspace accounts the literal `INBOX` mailbox Mail.app exposes is an empty virtual shell — the real received mail lives under the `All Mail` / `Important` special mailboxes (nested in Mail.app's `[Gmail]` container, so they don't resolve via a flat `mailbox "All Mail"` lookup). Two symptoms are fixed:
  - `search-messages` and `get-thread` scoped with `mailbox="INBOX"` returned `{count:0}` on such accounts even when an unscoped call found the message. INBOX-scoped searches on a Gmail-style account now scan the real receiving set (`All Mail` + `Important`, matched by `name of mb` and de-duped) instead of the empty `INBOX`, so scoped and unscoped calls agree. Non-Gmail accounts and non-INBOX scopes are unchanged.
  - `get-mail-stats` → `recentlyReceived` (last 24h/7d/30d) only scanned the literal `INBOX`, reporting near-zero on Gmail. It now detects the `All Mail` superset and counts that. The `whose date received` filter is O(n) with no AppleScript index, so a per-mailbox count guard (`APPLE_MAIL_MAX_SEARCH_MAILBOX`, default 5000) skips an oversized `All Mail` rather than hang, and a huge account's fast, correct recent counts come from the IMAP path (IMAP `SEARCH SINCE`) when configured. A single 30-day pass is bucketed in-AppleScript into the three windows rather than three separate scans.
- **Symmetric mailbox create/delete/rename on server-side accounts (BUG B).** `create-mailbox` used to succeed on a server-side (IMAP / iCloud / Exchange) account via AppleScript while `delete-mailbox`/`rename-mailbox` failed there, orphaning mailboxes; a failed rename could also leave a half-created destination behind. IMAP-configured accounts already route all three through the server (imapflow `mailboxCreate`/`mailboxDelete`/`mailboxRename`, an atomic server-side RENAME). For a server-side account **without** IMAP configured, the AppleScript path now refuses `create` and `rename` up front (before any destination is created) with an actionable message, so it never creates a folder it cannot later remove. POP / local "On My Mac" mailboxes are unaffected; an inconclusive account-type probe fails open.

## [2.8.1] - 2026-07-03
Dependency maintenance.

### Changed
- Bumped the npm group (6 updates): `imapflow` 1.4.2→1.4.3, `nodemailer` 9.0.1→9.0.3, `@typescript-eslint/*` 8.62.0→8.62.1, `prettier` 3.8.4→3.9.4, `vite` 8.1.0→8.1.2, `@oxc-project/types` 0.137.0→0.138.0. Reformatted `src/types.ts` to satisfy prettier 3.9.4's `format:check` (collapsed a short union type onto one line — no behavior change).

## [2.8.0] - 2026-07-01
Resolve `imap:` ids to numeric Mail.app ids (so flag colors can stick over IMAP).

### Added
- **`resolve-message-id` tool.** Maps `imap:` message id(s) to their numeric Mail.app id(s) via the message's RFC822 Message-ID (the backend-independent join key). This unblocks applying a flag **color** to an IMAP-routed message: colors only apply on the AppleScript numeric-id path — IMAP `\Flagged` is colorless, so a smart mailbox keyed on flag color never matches an IMAP-flagged message. Resolve the id first, then `flag-message` / `batch-flag-messages` the numeric id with `color`. Numeric ids pass through unchanged; unresolvable ids return `numericId: null`. The lookup scopes to the message's account and checks its INBOX first to avoid scanning large All Mail/Archive mailboxes.

## [2.7.0] - 2026-06-30
Flag colors.

### Added
- **`flag-message` and `batch-flag-messages` accept an optional `color`.** One of `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `gray` (`grey` accepted as an alias). The color is applied via Mail.app as the message's AppleScript `flag index` (0 red … 6 gray) — the same property a Mail smart mailbox can match on. Omitting `color` keeps the previous behavior (Mail's default flag). The response includes `colorApplied` so a caller can confirm.

### Notes
- Flag colors are a Mail.app feature. For an **IMAP-routed** message id (`imap:…`) the flag is still set, but the color is **not** applied (IMAP's `\Flagged` is colorless); the response says so. Use a message's AppleScript (numeric) id to color its flag.
- **Removing flags** is unchanged and confirmed: `unflag-message` / `batch-unflag-messages` clear the flag entirely (which also clears any color) on both the AppleScript and IMAP paths.

## [2.6.2] - 2026-06-30
Low-severity hardening and documentation refinements from a code review — no behavior change for normal use.

### Changed
- **`limit`/`offset` inputs are now bounded.** `search-messages`/`list-messages` `limit` is constrained to an integer `1–500` (default `50`) and `list-messages` `offset` to an integer `≥ 0`. Previously these were unbounded `z.number()`, so on the IMAP read path a huge `limit` flowed straight into a comma-joined FETCH UID range with no cap. Defaults and existing callers are unaffected.

### Fixed
- **MIME multipart parsing is now depth-bounded.** `walkLeafParts` (attachment/HTML-body extraction) threads a depth counter and stops descending past 20 nested `multipart/*` levels, returning what it has parsed so far instead of recursing without bound on a pathologically nested message. Defense-in-depth; the input is the user's own mail. Real messages nest only a few levels.

### Docs
- Documented two previously read-but-undocumented environment variables in the README:
  - **`APPLE_MAIL_MCP_DEFAULT_ACCOUNT`** — pins the account used when a tool call omits `account` (matched by account name or email; a disabled account is otherwise never selected implicitly). Documented in "Working with Accounts".
  - **`APPLE_MAIL_MCP_MAX_BUFFER`** — overrides the `osascript` output-buffer size in bytes (default 64 MB); the knob for reading messages whose raw MIME (e.g. a large attachment) exceeds the default. Documented under `get-message`.
- `search-messages`/`list-messages` parameter tables now state the `limit` (1–500) and `offset` (≥ 0) bounds.

## [2.6.1] - 2026-06-29
Connection-footprint hardening — keep this server's IMAP usage small so multiple coexisting instances (the Claude desktop app spawns a separate set of MCP servers per open conversation) are less likely to exhaust **Gmail's 15-simultaneous-IMAP-connections-per-account cap** and starve Apple Mail of slots.

### Fixed
- **Self-exit when orphaned.** A host (claude-code) that is force-quit or crashes delivers neither a signal nor stdin-EOF, so the server could linger as an orphan holding its pooled IMAP sockets against the per-account cap. The server now runs a lightweight watchdog: on macOS an orphan is reparented to launchd (`process.ppid === 1`), so it polls every 30s and, when detected, runs the same clean shutdown (drops all pooled IMAP connections, then exits). The watchdog is `unref`'d (never keeps the process alive on its own), can't misfire at startup (ppid is the real parent then), and is cleared when shutdown begins. Decision extracted into a pure, unit-tested helper `isOrphaned(ppid)`.

### Changed
- **Pooled IMAP connections now close after ~30s idle instead of ~60s** (`APPLE_MAIL_MCP_IMAP_IDLE_MS` default `60000` → `30000`; still overridable, `0` = never close), so an instance that isn't actively serving IMAP calls gives its connection slot back sooner.

### Docs
- README and CLAUDE.md gained a **"Connection footprint (playing nice with Gmail)"** note: one pooled connection per account closed after ~30s idle, IMAP IDLE opt-in adds one persistent connection per account, Gmail's 15-per-account cap, how many concurrent instances multiply the footprint, the shutdown + orphan self-exit behavior, and how to mitigate (close idle conversations, keep IDLE off, lower the idle timeout).

## [2.6.0] - 2026-06-26
### Changed
- **Reads now PREFER direct IMAP whenever IMAP is configured** (previously IMAP was used only when a call passed an `account` exactly matching a configured IMAP account; an omitted account fell to AppleScript). This affects the six read tools — `search-messages`, `get-thread`, `list-messages`, `list-mailboxes`, `get-unread-count`, `get-mail-stats` — and is why this is a minor release. Three cases:
  - **Explicit IMAP account** → single-account IMAP (fast server-side path, unchanged).
  - **Explicit non-IMAP account** → AppleScript (unchanged).
  - **No `account` given** → **merge across all accounts**, with the Mail-account list partitioned so each account is served by exactly one backend (never both):
    - **Message lists** (`search-messages`/`get-thread`/`list-messages`): IMAP fans out over *every* configured account; AppleScript runs **only for the accounts no IMAP config covers** (an all-IMAP setup runs zero AppleScript and never depends on cross-backend dedup). Results are merged, sorted newest-first, and de-duplicated as a safety net — keyed by normalized `Message-ID` when available, else a `normalizedSubject|sender|dateReceivedEpoch` composite — preferring the IMAP copy (which carries the round-trippable `imap:` id). The default mailbox is resolved **per account** on a no-mailbox fan-out: Gmail/Workspace hosts use `[Gmail]/All Mail`, every other host uses `INBOX` (selecting Gmail's All-Mail folder on a non-Gmail account, e.g. iCloud, would otherwise fail and silently drop it); pin a `mailbox` for a wider non-Gmail scope.
    - **Counts** (`get-unread-count`, `get-mail-stats`): account-centric — each Mail account is counted via its matching IMAP config, or via AppleScript if no config matches; any IMAP config matching no Mail account is counted once via IMAP. A config is consumed by at most one account, so even a coverage-heuristic mismatch can never double-count.
    - **`list-mailboxes`**: concatenates each IMAP account's mailboxes (prefixed with the account label) plus the AppleScript mailboxes of any non-IMAP accounts.
  - When IMAP is **not** configured at all, every read behaves exactly as before (pure AppleScript) — this change is inert without IMAP config.
- The three mailbox-**write** ops (`create-mailbox`, `delete-mailbox`, `rename-mailbox`) are intentionally **unchanged**: they still route to IMAP only for an explicitly-named IMAP account, never on an omitted account.

### Docs
- README and CLAUDE.md now document the prefer-IMAP read behavior and the no-account multi-account merge, and clarify that `reply-to-message`/`forward-message` send via clean direct SMTP with RFC 5322 threading when SMTP is configured (AppleScript `without opening window` fallback otherwise) — mirroring the `send-email` prefer-direct model shipped in v2.5.0.

## [2.5.0] - 2026-06-26
### Added
- **Reply and forward now send via direct SMTP with proper RFC 5322 threading** (`In-Reply-To` / `References`) whenever the SMTP transport is configured — a clean, correctly-threaded MIME message instead of driving Mail.app's `reply`/`forward` AppleScript (which threads, but wraps the injected body in a `blockquote` on macOS 15+). `reply-to-message` addresses the original sender (or `Reply-To`), adds the other recipients as `Cc` on `replyAll`, prefixes `Re:`, and quotes the original; `forward-message` builds a clean `Fwd:` with a forwarded-header block. The Mail.app path is used automatically as a fallback when SMTP is not configured, the original can't be fetched, or it has no `Message-ID` to thread on. Drafts (`send=false`) still go through Mail.app.
- `send-serial-email` (mail-merge) now sends via direct SMTP when configured — one individual, personalized message per recipient, with the same `{{Key}}` substitution and per-recipient delay as the AppleScript path. Mail.app fallback when SMTP is not configured.
- **Disabled-account guard + rename rollback** for structural mailbox operations. Creating, deleting, or renaming a mailbox on an account that is *disabled* in Mail fails inside Mail with an opaque AppleEvent `-10000` and can leave a half-built (orphaned) destination mailbox behind. These ops now detect a disabled target account up front and refuse with an actionable message ("Enable the account … and retry"), and a failed `rename-mailbox` rolls back an *empty* orphaned destination so no ghost mailbox is left behind (mailboxes that actually received messages are never deleted). The account-state probe fails open — an inconclusive check never blocks an otherwise-valid operation.

### Changed
- `AppleMailManager.createMailbox` / `renameMailbox` now return `{ success, error }` (internal API) so the guard can surface a precise reason. The MCP tool responses are unchanged.

### Fixed
- Removed a stray NUL byte in `imapClient.ts` — an internal pool-group-key separator was a raw `\0` byte; it is now the `\0` string escape. No behavior change (the runtime key is identical), but the source is clean ASCII again so tooling (grep, etc.) no longer treats the file as binary.

## [2.4.2] - 2026-06-25
### Fixed
- IMAP connections no longer leak past the per-account limit. The request-pool connections are torn down on EVERY exit path — SIGINT/SIGTERM and stdin-EOF (when the MCP client/parent goes away) — so a killed, restarted, or orphaned instance never leaves IMAP sockets occupying slots against Gmail's ~15-per-account cap. Added a single-flight connect guard so concurrent reads for one account share one connection instead of orphaning duplicate sockets.
- list-mailboxes (and any AppleScript op) no longer leaks the raw "Command failed: osascript -e <script>" when osascript exits abnormally (killed under load, Mail.app relaunching, or Automation denied) — returns a clean, actionable message instead; a SIGKILL-killed osascript is now classified as a timeout.


## [2.4.1] - 2026-06-25
### Fixed
- IMAP idle watcher and connection pool now attach an error listener before connecting, so an unhandled ImapFlow socket error/timeout (idle Gmail/iCloud drop, server BYE, network blip) can no longer crash the server. Added a process-level uncaughtException/unhandledRejection safety net (clean exit on stdout EPIPE).


## [2.4.0] - 2026-06-24
### Added
- **`apple-mail-send` CLI — clean SMTP sending without a running MCP server.** A new `bin` (`src/cli.ts` → `build/cli.js`) wraps the existing `sendViaSmtp()` so cron jobs, scheduled tasks, and scripts can send clean MIME from the command line. Flags mirror a standard mail sender (`--from`, repeatable `--to`/`--cc`/`--bcc`, `--subject`, `--body-file`, `--html-body-file`, repeatable `--attach`) and it reuses the same `APPLE_MAIL_MCP_SMTP_*` env + Keychain config as the MCP `send-email` tool. Exit codes follow `sysexits.h` (`0`/`64`/`66`/`78`).
- **HTML-alternative bodies over SMTP.** `sendViaSmtp()` now accepts an optional `htmlBody`; when present the message is sent as `multipart/alternative` (the plain-text `body` as the fallback part). The MIME-cleanliness harness asserts the HTML part is free of the AppleScript blockquote artifacts too.
### Changed
- **`send-email` auto-prefers SMTP when configured.** With no explicit `transport`, the tool now uses the clean SMTP path automatically whenever `APPLE_MAIL_MCP_SMTP_HOST` + `APPLE_MAIL_MCP_SMTP_USER` are set, instead of always defaulting to AppleScript. Pass `transport: "applescript"` to force the Mail.app path, or `transport: "smtp"` to require SMTP (a configuration error is surfaced rather than silently falling back). The `doctor` SMTP check reflects the new behavior. Resolves the long-standing footgun where clean sending required remembering the per-call flag.
  - **Migration notes:** (1) SMTP submission does not write to Mail.app's Sent mailbox — pass `transport: "applescript"` if you rely on the local Sent copy. (2) A call that passes a non-email `account` *label* (a Mail.app account name, e.g. `"Work"`) is left on the AppleScript path automatically, so existing account-selection calls keep working unchanged; an `account` that is an email address is treated as the SMTP From override.

## [2.3.0] - 2026-06-23
### Added
- **All tools now declare an MCP `outputSchema`.** Every tool migrated from `server.tool(...)` to `server.registerTool(...)` so its structured-output shape is advertised in the tool metadata and validated by the SDK. Schemas are intentionally permissive (all fields optional, no `.strict()`, loose element types for arrays) so they describe the output contract without ever rejecting a valid result. No tool names, inputs, descriptions, or handler behavior changed.

## [2.2.0] - 2026-06-23
### Added
- **Full `structuredContent` coverage across all tools.** Every tool now returns a machine-readable `structuredContent` payload alongside the unchanged human text. Data tools emit their data — `list-rules` (`{ rules:[{name,enabled}], count }`), `search-contacts` (`{ contacts:[{name,emails}], count }`), `list-templates` (`{ templates:[{id,name,subject}], count }`), and `get-template` (`{ id,name,subject,to,cc,body }`). Mutations return a small ack — single-message ops (`mark-as-read`/`mark-as-unread`/`flag-message`/`unflag-message`/`delete-message`/`move-message`) return `{ ok, id, … }`; the six batch ops return `{ ok, success, failed, … }`; `send-email`/`send-serial-email`/`create-draft`/`reply-to-message`/`forward-message`, the mailbox ops (`create`/`delete`/`rename`), the rule toggles (`enable`/`disable`), and the template ops (`save`/`delete`/`use`) each return their relevant `{ ok, … }` fields. `health-check` now returns `{ healthy, checks[] }`. The IMAP backend was made consistent with the AppleScript path: `imapSearchMessages`/`imapListMessages` now return the same structured shape (`{ messages[], count, partial }`) instead of text-only, so `search-messages`, `list-messages`, `get-thread`, and `get-message` populate `structuredContent` regardless of backend. No tool names, input schemas, or human-readable text changed.

### Changed
- **Rewrote the Hermes Agent packaging to match NousResearch's real spec.** `.hermes-plugin/` previously shipped Claude-format JSON (`plugin.json` / `marketplace.json` / `mcp.json`) that Hermes never reads; it now provides a `config.yaml` (a `~/.hermes/config.yaml` `mcp_servers:` snippet) plus a README with the `hermes mcp add` command. The README "Other Hosts" section is corrected to match (Hermes has no plugin/marketplace drop-in; Antigravity uses its native `mcp_config.json`). Claude Code, Codex, and Antigravity packaging are unchanged.

## [2.1.5] - 2026-06-23
### Fixed
- **Codex packaging: launch the published npm package, not a `github:` ref.** `codex/.mcp.json` now runs `npx -y apple-mail-mcp` (was `npx -y github:sweetrb/apple-mail-mcp`), matching the other Apple MCP servers — Codex installs the prebuilt published package instead of cloning + building the repo on every launch.
- **Codex skill is now discoverable.** Added the required YAML frontmatter (`name` / `description`) to `skills/apple-mail/SKILL.md` (and the Codex copy), which was missing it — Codex can now register the bundled skill's name and description.

### Changed
- `npm audit fix` cleared the remaining transitive advisories — `npm audit --omit=dev` is now clean.
- `publish.yml`'s `npm install -g npm@latest` step now retries, so a transient registry `ECONNRESET` no longer aborts a release.

## [2.1.4] - 2026-06-23
### Fixed
- **Codex marketplace shipped the Apple Notes icon for Apple Mail (#56).** Replaced `codex/assets/icon.png` (and added an `icon.svg` source) with a Mail-specific icon — a blue card with an envelope glyph, part of a consistent Apple MCP icon family. Thanks @oliverames for the hash-level diagnosis.

### Documentation
- README: added npm-downloads, supported-Node, platform-macOS, and MCP badges next to the existing version/CI/License badges.

## [2.1.3] - 2026-06-22
### Added
- **Hermes and Antigravity plugin packaging.** Adds `.hermes-plugin/` and `.antigravity-plugin/` marketplace and plugin manifests plus the Apple Mail skill, so the server installs as a plugin on the Hermes and Antigravity hosts alongside the existing Claude Code and Codex packaging; each registers the same `apple-mail` MCP server (launched via `npx -y github:sweetrb/apple-mail-mcp`). Wired into `scripts/sync-plugin-version.mjs` so their versions track `package.json`, and documented in the README. Brings multi-host packaging parity with the other Apple MCP servers.
- **Codex plugin marketplace packaging** ([#54](https://github.com/sweetrb/apple-mail-mcp/pull/54)). Adds a `codex/` plugin package and `.agents/plugins/marketplace.json` so the server installs from Codex's marketplace alongside the Claude Code plugin (launched via `npx -y github:sweetrb/apple-mail-mcp`), plus the Apple Mail skill. Introduces `scripts/sync-plugin-version.mjs` to keep every plugin/marketplace manifest version in lockstep with `package.json`, and normalizes the Claude marketplace manifest to the current version. Thanks @oliverames.
- **MCP-visible tool descriptions on all 45 tools** ([#51](https://github.com/sweetrb/apple-mail-mcp/pull/51)). Every tool now registers a structured description exposed via `tools/list`, in a consistent **Use when: / Returns: / Do not use when:** shape (single↔batch and read↔send variants cross-reference each other, and read/list tools are named as the way to obtain message ids). Write/destructive/external-effect tools additionally carry an explicit **Safety:** line requiring user confirmation: `send-email`, `send-serial-email`, `reply-to-message`, `forward-message` (send real mail immediately, cannot be unsent — confirm recipients/subject/body); `delete-message`, `batch-delete-messages` (confirm and list/search first); `move-message`, `batch-move-messages` (confirm destination and ids); `create-mailbox`, `rename-mailbox`, `delete-mailbox`, `create-rule`, `delete-rule` (external effect on the account); `save-attachment` (writes a file to disk); `save-template`, `delete-template` (mutate the on-disk template store). Metadata only — no handler logic, schemas, or behavior changed.

### Documentation
- Standardized the `package.json` `description` and GitHub one-liner to the shared house style ("… via Claude and other AI assistants") for consistency across the Apple MCP servers.
- Added `docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md`: why macOS re-prompts for Full Disk Access / Automation when the server runs under an ad-hoc-signed (e.g. Homebrew) Node, and the fix — run it under the official Developer-ID-signed Node so the grant survives Node updates. README and CLAUDE.md now point at it.

## [2.1.2] - 2026-06-20

### Fixed

- **`prepare` now builds the server on install.** The `prepare` script was `husky` only, so a fresh `git`/clone or Claude Code marketplace install ran the git hooks but never compiled `build/` — leaving the server unbuilt. It is now `husky; npm run build` (the `;` ensures the build runs even if husky can't initialize, e.g. in a non-git context), matching the other Apple MCP servers. Registry installs were unaffected (the published tarball already ships `build/`).

## [2.1.1] - 2026-06-19

### Added

- **File-based configuration** — the server now reads `APPLE_MAIL_MCP_*` settings from a JSON file (`APPLE_MAIL_MCP_CONFIG_FILE`, default `~/Library/Application Support/apple-mail-mcp/config.json`) at startup, merging them into the environment **without overriding** anything already set. This is for host apps (e.g. Claude Desktop) that spawn the server with a scrubbed environment and ignore the `env` block in their MCP config, leaving no other way to pass configuration. The file holds only non-secret config (account/host/Keychain-service names, flags); **passwords stay in the macOS Keychain**. Verified: with the env scrubbed, the server self-configures from the file and all accounts authenticate.

## [2.1.0] - 2026-06-19

IMAP acceleration release. Six more tools now use IMAP when the account is
IMAP-configured and fall back to AppleScript otherwise — faster and more reliable
on large mailboxes, with no behavior change for non-IMAP accounts.

### Changed

- **Attachments via IMAP `BODYSTRUCTURE` (I1)** — `list-attachments`, `save-attachment`, and `fetch-attachment` route to IMAP for `imap:` ids: parts are enumerated from `BODYSTRUCTURE` (without downloading the message) and a single part is pulled with `FETCH BODY[part]`. This also surfaces **MIME-embedded attachments that AppleScript's `mail attachments` can't see** (previously only found via a slow full-source scan). `fetch-attachment` now accepts `imap:` ids.
- **Batch ops via IMAP `UID STORE`/`UID MOVE` (I2)** — `batch-mark-as-read`/`unread`, `batch-flag`/`unflag`-messages, `batch-move-messages`, and `batch-delete-messages` accept `imap:` ids, group them by mailbox, and apply the whole UID set in one command instead of per-message. Numeric ids still run via AppleScript; mixed batches are split and merged.
- **`get-mail-stats` via IMAP `STATUS` + `SEARCH` (I3)** — a new optional `account` argument; when it names an IMAP account, totals come from `STATUS` and recent activity from `SEARCH SINCE` (authoritative and fast on huge mailboxes).
- **`get-unread-count` via IMAP `STATUS (UNSEEN)` (I4)** — authoritative server count for IMAP accounts; no more enumerating messages.
- **`get-thread` true threading via References/Message-ID (I5)** — for an `imap:` seed, the conversation is assembled from RFC 5322 `References`/`In-Reply-To` via IMAP `HEADER SEARCH` (more accurate than subject grouping); falls back to subject grouping when the server lacks `HEADER` search or nothing References-linked is found.
- **`list-mailboxes` via IMAP `LIST` + `STATUS` (I6)** — the true server folder hierarchy with per-mailbox counts for IMAP accounts.

### Added

- `status()` and `download()` on the IMAP client; 4 new GreenMail integration cases covering the IMAP counts, attachments, batch, and threading paths. (45 tools unchanged; +18 unit tests, 225 total.)

## [2.0.0] - 2026-06-19

Major feature release. Thirteen enhancements landed on a single `v2` branch, each
tested and validated before merge. Fully backward compatible — every new
capability is additive or opt-in — but the major bump reflects the breadth of new
surface (5 new tools, MCP resources & prompts, multi-account IMAP, IDLE push).

### Added

- **`get-thread` tool (B1)** — group a conversation by normalized subject. Resolves the seed message's subject (numeric or `imap:` id), strips reply/forward prefixes (stacked, numbered, and localized — `Re:`, `Fwd:`, `RE[2]:`, `AW:`, `WG:`, …) and gathers the conversation across the AppleScript or IMAP backend, oldest-first.
- **`create-rule` / `delete-rule` tools (B2)** — create Mail rules with conditions (from/to/cc/subject/content × contains/equals/begins/ends) and actions (mark read, mark flagged, delete, move to mailbox), and delete rules by name. Built on Mail.app's AppleScript rule model.
- **Persistent email templates (B3)** — templates now survive server restarts, stored as JSON at `APPLE_MAIL_MCP_TEMPLATES_FILE` (default `~/Library/Application Support/apple-mail-mcp/templates.json`). Previously in-memory only, and template ids reset/collided on restart.
- **Attachment byte parity (B4)** — `send-email` and `create-draft` now accept inline `{filename, contentBase64}` attachments in addition to absolute file paths (over both SMTP and AppleScript). New **`fetch-attachment`** tool returns an attachment's bytes as base64 — the read counterpart to inline send.
- **IMAP IDLE push notifications (B5, opt-in)** — set `APPLE_MAIL_MCP_IMAP_IDLE=1` to watch every configured IMAP account's INBOX and receive an MCP logging message + resource-updated notification on new mail. Real-time via IDLE where the server pushes it, with a polling fallback for servers that don't; reconnect-with-backoff and clean shutdown on SIGINT/SIGTERM.
- **Structured tool output (A1)** — read/list/get tools now return `structuredContent` (typed JSON) alongside the human-readable text, so agents can consume results without parsing prose.
- **Multi-account IMAP (C2)** — configure additional IMAP accounts via the `APPLE_MAIL_MCP_IMAP_ACCOUNTS` JSON array (alongside the legacy single-account env). Account is routed through search/list, folder ops, and message ops; the connection pool keeps one connection per account.
- **`doctor` tool (C3)** — one diagnostic that checks Mail.app automation permission, account state (flagging disabled accounts), and each configured IMAP/SMTP backend, with actionable messages.
- **MCP resources & prompts (D2)** — resources `mail://accounts`, `mail://templates`, and a `mail://mailboxes/{account}` template; prompts `triage-inbox`, `compose-reply`, `weekly-summary`.
- **IMAP integration tests in CI (A2)** — the IMAP backend is now exercised end-to-end against a real IMAP server (GreenMail) in a Linux CI job (`imap-integration`), with a local `npm run test:imap`.

### Changed

- **IMAP connection pooling (A3, #50)** — instead of connecting and logging out on every IMAP call, one connection is kept alive per account and reused (NOOP liveness check, idle timeout via `APPLE_MAIL_MCP_IMAP_IDLE_MS` default 60s, reconnect-once for idempotent reads). Cut the IMAP integration suite from ~6.2s to ~2.3s.
- **Bulk AppleScript property reads (C1, #11)** — `search-messages`/`list-messages` read message properties for the whole matched set in a few Apple Events instead of ~6 per message, with an automatic per-message fallback that preserves malformed-message isolation (#13).
- **Internal: `index.ts` split + central message router (D1)** — shared response helpers extracted to `src/tools/respond.ts`; backend routing (AppleScript vs IMAP) centralized in `src/services/messageRouter.ts`.

## [1.9.0] - 2026-06-18

### Added
- **IMAP backend Phase 3: message-level operations** — `get-message`, `mark-as-read`/`unread`, `flag-message`/`unflag-message`, `move-message`, and `delete-message` now route to IMAP when given an IMAP message id, completing the IMAP backend. The IMAP read path (`search-messages`/`list-messages`) now emits **self-describing `imap:<token>` ids** that encode the account, mailbox path, and UID; passing such an id to `get-message` or any message mutation routes it to IMAP automatically, while bare numeric ids continue to use AppleScript — so callers never need to know which backend a message came from. `MESSAGE_ID_SCHEMA` accepts the `imap:` form (base64url, injection-safe, never passed to AppleScript); batch operations stay AppleScript/numeric-only. Verified live against iCloud end-to-end (create mailbox → append → get-message → mark/flag → move → delete → cleanup). Only optional IMAP connection pooling remains open on #43. ([#43](https://github.com/sweetrb/apple-mail-mcp/issues/43))

## [1.8.1] - 2026-06-18

### Fixed
- **Default-account resolution could fall back to a *disabled* account** — when a tool call omitted `account`, `resolveAccount()` fell back to `accounts[0]` (and a hardcoded `return "iCloud"`) without checking whether that account is enabled. On a setup where the first-listed account is a disabled, unused iCloud account, operations could silently target it (this is how the `_amcp_rename_test_*` orphans landed in an invisible account). Resolution now goes through a pure, tested `chooseDefaultAccount()` helper: explicit `APPLE_MAIL_MCP_DEFAULT_ACCOUNT` override (by name or email) → Mail's default-send account *if enabled* → first **enabled** account. A disabled account is never chosen implicitly. ([#47](https://github.com/sweetrb/apple-mail-mcp/issues/47))

### Added
- **`APPLE_MAIL_MCP_DEFAULT_ACCOUNT` env** to pin the default account (matched by account name or email) regardless of Mail's compose setting. ([#47](https://github.com/sweetrb/apple-mail-mcp/issues/47))

## [1.8.0] - 2026-06-18

### Added
- **IMAP backend Phase 2: folder operations** — when an account is IMAP-configured, `create-mailbox`, `rename-mailbox`, and `delete-mailbox` now run via IMAP (`imapflow` `mailboxCreate`/`mailboxRename`/`mailboxDelete`) instead of AppleScript. IMAP's `CREATE`/`RENAME`/`DELETE` operate on the real server folder hierarchy, so they succeed on exactly the iCloud/Gmail/Workspace/Exchange mailboxes where Mail.app's AppleScript bridge throws `AppleEvent handler failed` — closing the IMAP slice of #42. Delete/rename resolve the target by listing mailboxes and matching on full path then leaf name, and fail clearly ("not found") without acting if the mailbox is absent. Still opt-in/additive: accounts without IMAP configured use AppleScript (and get the #42 actionable error). Message-level mutations (mark/flag/move/delete-message) remain on AppleScript pending a UID-aware design (the IMAP read path reports per-mailbox UIDs, a different namespace from Mail ids). ([#43](https://github.com/sweetrb/apple-mail-mcp/issues/43))

## [1.7.0] - 2026-06-18

### Added
- **Opt-in IMAP backend for `search-messages` / `list-messages` (Phase 1)** — when an account is configured for IMAP, these two read paths run a **server-side IMAP search** (via `imapflow`) instead of AppleScript's client-side `whose` enumeration. On large Gmail/IMAP mailboxes where AppleScript times out with a false-empty (#24), IMAP returns correct results in well under a second. Strictly additive and opt-in (mirrors the `transport:"smtp"` pattern from #12): any account *without* IMAP configured behaves exactly as before, and routing only sends a call to IMAP when its explicit `account` matches the configured one. Read-only for now — `get-message` and all mutations stay on AppleScript (IMAP rows report message UIDs, noted in the output). Config via `APPLE_MAIL_MCP_IMAP_*` env with the password read from the macOS Keychain (same pattern as SMTP); Gmail label names map to their `[Gmail]/…` paths automatically. New runtime dependency `imapflow`. See the README "IMAP backend" section. Phase 2 (IMAP-backed mutations + folder ops, addressing the IMAP slice of #42) is future work. ([#43](https://github.com/sweetrb/apple-mail-mcp/issues/43))

## [1.6.10] - 2026-06-18

### Changed
- **Clear, non-retryable errors for operations Mail.app can't script** — `delete-mailbox`, `rename-mailbox`, `delete-message`, and `move-message` returned a generic `Failed to …` when the target was a server-side mailbox (IMAP / Gmail / Workspace / iCloud / Exchange) or a draft, where Mail.app's AppleScript bridge throws `AppleEvent handler failed` even though the GUI can do it. They now return an actionable message naming the limitation and the workaround — e.g. *"Mail.app cannot delete server-side … mailboxes via AppleScript — only local 'On My Mac' mailboxes support this. Delete it in Mail.app directly."*, and for drafts *"Mail.app cannot delete drafts via AppleScript; delete it in Mail.app directly."* Local "On My Mac" mailboxes are unaffected; genuine errors (not found, ambiguous destination) pass through unchanged. The four methods now return `{ success, error }` instead of a bare boolean. ([#42](https://github.com/sweetrb/apple-mail-mcp/issues/42))

## [1.6.9] - 2026-06-17

### Fixed
- **Hardening: assorted low-severity stability fixes from the 2026-06-17 audit.**
  - `escapeForAppleScript` now strips ASCII control characters in addition to escaping `\` and `"`. A value containing a raw newline could otherwise terminate the AppleScript string literal early and inject a statement (audit #10).
  - `save-attachment`'s allowed-directory check now uses a path-segment boundary test instead of a bare `startsWith`, so a sibling directory that merely shares the prefix (`/Volumes-evil` vs `/Volumes`, `/Users/robother` vs `/Users/rob`) is no longer accepted (audit #12).
  - `search-contacts` wraps each contact read in its own `try`, so one malformed contact (e.g. no email) no longer aborts the whole search and returns an empty list (audit #13).
  - `use-template` honors an intentional empty-string subject/body override (`??` instead of `||`) instead of falling back to the template value (audit #14).
  - `list-mailboxes`, `get-unread-count`, and `get-sync-status` — which scan/count across every mailbox/account — now use a 60s timeout instead of the 30s default, so a slow account is less likely to silently degrade to an empty list / `0` unread / "not syncing" (audit #8).

## [1.6.8] - 2026-06-17

### Fixed
- **`rename-mailbox` could lose messages on a partial move** — rename is emulated as create-new + move-all + delete-old. The old code iterated `messages of srcMailbox` *while moving* (mutating the collection it was iterating, which can skip messages) and then deleted the source unconditionally, so a move that errored or timed out part-way deleted the source along with its un-moved remainder. It now snapshots the message references up front, moves each in its own `try`, and deletes the source **only after verifying it is empty** (every message moved); on a partial move both mailboxes are left intact and the tool reports how many messages still remain in the source so the rename can be retried. The move timeout was also raised (60s → 120s) for large mailboxes, and because deletion is now gated on a verified-empty source, even a SIGKILLed move is recoverable rather than lossy. ([#33](https://github.com/sweetrb/apple-mail-mcp/issues/33))

## [1.6.7] - 2026-06-17

### Fixed
- **`get-message preferHtml` returned the raw MIME source, not the HTML body; and `get-message` always fetched that source even for plain-text reads** — `getMessageContent` unconditionally read `source of msg` and returned the entire raw MIME (headers + base64 attachments) as `htmlContent`, so `preferHtml:true` dumped a (potentially multi-MB) blob into the response instead of the HTML body, and every plain-text read paid the cost of fetching the source too. Now `get-message` fetches the source only when `preferHtml` is set, and extracts the actual `text/html` part from it via a new `extractHtmlBody()` MIME parser (decoding base64 / quoted-printable, descending into nested multipart containers); plain-text-only messages return no HTML rather than a mislabeled blob. Separately, `getMessageById`'s full-source scan for MIME-embedded attachments — the slowest part of that path — is now opt-in via a `deepAttachmentCheck` parameter (default off) instead of running on every attachmentless message. ([#32](https://github.com/sweetrb/apple-mail-mcp/issues/32))

## [1.6.6] - 2026-06-17

### Changed
- **Batch operations now run in a single AppleScript pass instead of N process spawns** — `batch-delete`, `batch-move`, `batch-mark-as-read`/`unread`, and `batch-flag`/`unflag` previously looped and invoked the per-message method once per ID, so a 100-ID batch spawned 100 osascript processes, each re-resolving accounts and walking the entire account→mailbox tree, all serialized through the gate (minutes of pure overhead at scale). They now walk the mailbox tree exactly once, probing the still-pending IDs in each mailbox with the indexed `whose id is` (effectively free) and stopping early once every ID is accounted for. Per-ID results are unchanged (`{ id, success, error }`, in input order); `batch-move` still resolves the destination once and refuses an ambiguous destination rather than guessing. ([#31](https://github.com/sweetrb/apple-mail-mcp/issues/31))

## [1.6.5] - 2026-06-17

### Fixed
- **Result parsing corrupted when a field value contained the `|||` delimiter** — AppleScript emitted structured results as `|||`-delimited (records `|||ITEM|||`) strings that TS split back apart, but field values were never sanitized first. Any subject, sender, attachment filename, or mailbox name that itself contained `|||` shifted every subsequent field and silently produced wrong structured output (e.g. an attachment named `report|||v2.pdf` parsed `v2.pdf` as the MIME type). All serialization separators are now ASCII control characters — Unit Separator (`\x1f`) for fields, Record Separator (`\x1e`) for records, Group Separator (`\x1d`) for the diagnostics/content markers — which cannot occur in mail field values, so the collision is structurally impossible. The same constants drive both the AppleScript emitter and the TS parser, so they can't drift. Verified across every parser (search, list, get-message, get-message-content, list-mailboxes, list-accounts, get-sync-status, get-mail-stats) on live Mail plus the full 44-test integration suite. ([#30](https://github.com/sweetrb/apple-mail-mcp/issues/30))

## [1.6.4] - 2026-06-17

### Fixed
- **`list-messages` returned a false empty on large multi-account setups (the #24 pathology, untreated)** — the unscoped (all-mailboxes) `listMessages` path iterated `messages of mb` over every mailbox with a swallowing per-mailbox `try`, so a large IMAP/Gmail mailbox timed out and the tool returned a clean — but wrong — "No messages found." `listMessages` now gets the same treatment as `searchMessages`: a cheap count-guard that skips mailboxes above `APPLE_MAIL_MAX_SEARCH_MAILBOX` (default 5000), a per-account wall-clock budget, per-mailbox timeout capture, and a partial-result warning naming the skipped/timed-out scopes instead of a silent empty. New `listMessagesWithDiagnostics()` returns `{ messages, diagnostics }`; `listMessages()` is unchanged for back-compat. The coverage-warning rendering is now shared between `search-messages` and `list-messages`. By-id lookups (`get-message`) were left unchanged: profiling shows `whose id is` is indexed and returns instantly even on a 44k-message mailbox, so they don't suffer the timeout/false-empty problem. ([#29](https://github.com/sweetrb/apple-mail-mcp/issues/29))

## [1.6.3] - 2026-06-17

### Fixed
- **`get-mail-stats` / recently-received counts were silently `0/0/0` on non-English system locales** — `getRecentlyReceivedStats` built its 24h/7d/30d thresholds as `date "January 5, 2026"` English-month literals. On a non-English locale Mail.app's `date "…"` coercion throws *"Invalid date and time (-30720)"*; the throw was swallowed by the per-inbox `try`, so the method returned `{last24h:0, last7d:0, last30d:0}` as a clean success and fed those zeros into `get-mail-stats`. This is the same locale regression fixed for `search-messages` in #15. The thresholds are now built from numeric components via the locale-independent `buildAppleScriptDate` helper. ([#28](https://github.com/sweetrb/apple-mail-mcp/issues/28))

## [1.6.2] - 2026-06-17

### Fixed
- **`osascript` output was capped at Node's 1 MB default `maxBuffer`, silently failing large messages** — `executeAppleScript` ran `execSync` without a `maxBuffer`, so any operation whose output exceeded 1 MB threw `ENOBUFS`, which surfaced as a failure and callers turned into `null`. This broke exactly the large / attachment-bearing operations where it mattered: `getRawSource` (which explicitly anticipates 20 MB raw sources for attachment extraction), `getMessageContent` (returns the full `source of msg`), and large `search-messages`/`list-messages` result sets — all appearing as "message not found" / "attachment not found" / missing body. The buffer is now 64 MB by default and overridable via the `APPLE_MAIL_MCP_MAX_BUFFER` environment variable (bytes). ([#27](https://github.com/sweetrb/apple-mail-mcp/issues/27))

## [1.6.1] - 2026-06-17

### Fixed
- **`search-messages` was pathologically slow and returned a false empty result on large multi-account setups** — an unscoped (all-accounts) search ran an unbounded `messages of mb whose <predicate>` over *every* mailbox in *every* account. On large IMAP/Gmail mailboxes (tens of thousands of messages) that single Apple Event blew past the timeout; the error was swallowed by the per-mailbox `try`, and the tool returned a clean — but wrong — `No messages found matching criteria`. Callers/agents then confidently concluded "no such mail." Measured on a 4-account setup: a single all-accounts search for a common word took minutes per account and returned empty even though matches existed. Profiling against a real 44k-message Gmail mailbox showed it isn't just `whose` — even reading the newest 20 messages by index took ~47s, so a "bounded newest-N scan" can't rescue these mailboxes. The fix is a cheap count-guard (skip mailboxes whose cached message count exceeds a threshold — `count of messages` is effectively free), a per-account wall-clock budget enforced inside the AppleScript, and per-mailbox error capture; all skipped/timed-out scopes are now surfaced as a **partial-result warning** (`⚠️ Partial results — this is NOT a confirmed "no such mail"`) naming the affected accounts/mailboxes, instead of a silent empty. The same query now returns in ~8s with real matches and an explicit note that the two giant Gmail mailboxes (`Important`, `All Mail`) were skipped. The scan threshold is tunable via `APPLE_MAIL_MAX_SEARCH_MAILBOX` (default 5000; set to 0 to disable the guard). Internals: new `searchMessagesWithDiagnostics()` returns `{ messages, diagnostics }`; `searchMessages()` is unchanged for back-compat. ([#24](https://github.com/sweetrb/apple-mail-mcp/issues/24))

## [1.6.0] - 2026-06-17

### Added
- **`send-email` SMTP transport — bypasses the macOS 15+ `<blockquote>` wrapping** — outgoing messages built through Mail.app's AppleScript path get wrapped in `<blockquote type="cite">` (Apple-Mail-URLShareWrapperClass) on macOS 15+, mangling their formatting ([#12](https://github.com/sweetrb/apple-mail-mcp/issues/12)). `send-email` now accepts `transport: "smtp"`, which submits clean MIME directly via SMTP (using `nodemailer`, a new runtime dependency), skipping Mail.app entirely. Connection settings come from `APPLE_MAIL_MCP_SMTP_*` environment variables and the password is read from the macOS Keychain via the `security` CLI (`find-internet-password`, then `find-generic-password`), so no secret is placed in config; `secure=true` uses implicit TLS (port 465), otherwise STARTTLS (port 587). The default transport remains `applescript` for back-compat — SMTP is strictly opt-in per call. Verified end-to-end with a real authenticated send through `smtp.gmail.com` whose delivered copy is clean `text/plain`. See the README "SMTP transport" section. ([#12](https://github.com/sweetrb/apple-mail-mcp/issues/12))

## [1.5.7] - 2026-06-17

### Fixed
- **Concurrent tool calls cascaded into 30s timeouts and left Mail.app wedged** — parallel `tell application "Mail"` dispatches pile up inside Mail.app's single-threaded AppleScript handler; once enough stack up the later calls blow past their timeouts while earlier ones are still draining, so the client sees a cascade of "Request timed out" (`-32001`) errors and Mail.app is left half-recovered for the next batch. Mail-touching tool calls now run through a serial execution gate (`src/utils/serialize.ts`) that chains every task through a single promise with a 50ms settle delay, so only one AppleScript runs at a time and Mail.app's dispatch queue never piles up; awaiting the gate yields the event loop between calls, so the server stays responsive (a health-check issued mid-batch still returns). Each script is additionally wrapped in `with timeout of N seconds` (a few seconds below the osascript process timeout) so a stuck operation aborts cleanly from *inside* Mail.app's own dispatch before the process is killed, and osascript is reaped with `SIGKILL` so a wedged process can't leak and worsen the contention. ([#11](https://github.com/sweetrb/apple-mail-mcp/issues/11))

## [1.5.6] - 2026-06-16

### Security
- **`@modelcontextprotocol/sdk` was pinned to the vulnerable `1.4.1`** — that exact pin falls in the `<=1.25.1` range flagged by two high-severity advisories ([GHSA-8r9q-7v3j-jr4g](https://github.com/advisories/GHSA-8r9q-7v3j-jr4g) ReDoS, [GHSA-w48q-cv73-mx4w](https://github.com/advisories/GHSA-w48q-cv73-mx4w) DNS-rebinding protection off by default), and because the pin was exact, `npm audit` reported "No fix available" for anyone installing `apple-mail-mcp`. Bumped to `^1.29.0`, out of the vulnerable range. No source changes were needed — the `McpServer` / `StdioServerTransport` APIs in use are unchanged across the bump, and the server still registers all 40 tools over stdio. ([#19](https://github.com/sweetrb/apple-mail-mcp/issues/19) / [#20](https://github.com/sweetrb/apple-mail-mcp/pull/20) by @chrischall)
- **Dev/test toolchain audit advisories cleared** — `npm audit` flagged 8 vulnerabilities (2 critical, 2 high, 4 moderate) in the test/lint toolchain only (no runtime impact for consumers): `esbuild <=0.28.0` (via `vite` → `vitest@2`), `postcss <8.5.10` (via `vite`), and `js-yaml <=4.1.1` (via `eslint` → `@eslint/eslintrc`). Bumped `vitest` + `@vitest/coverage-v8` `^2` → `^4.1.9` (pulls safe `vite` 8 / `esbuild` 0.28.1) and added `overrides` for `js-yaml ^4.2.0` and `postcss ^8.5.15`. All 93 unit tests pass on vitest 4; combined `npm audit` is clean (0 vulnerabilities). ([#21](https://github.com/sweetrb/apple-mail-mcp/issues/21) / [#22](https://github.com/sweetrb/apple-mail-mcp/pull/22) by @chrischall)

## [1.5.5] - 2026-06-01

### Fixed
- **`.mcp.json` parsed but never *connected* as a project-scope config (incomplete 1.5.4 fix)** — 1.5.4 switched the entrypoint to `${CLAUDE_PLUGIN_ROOT:-.}/build/index.js`, which fixed the *parse* error but not the actual failure: in a project-scope clone `CLAUDE_PLUGIN_ROOT` is unset, so the path fell back to `.`, which Claude Code resolves against the launching process's working directory — **not** the repo root — so the server still failed to connect. A single entrypoint string cannot serve both contexts: plugin installs require `${CLAUDE_PLUGIN_ROOT}` (in a plugin, `CLAUDE_PROJECT_DIR` points at the *user's* project, not the plugin dir), clones require `${CLAUDE_PROJECT_DIR:-.}`, and Claude Code does not support nested defaults (`${CLAUDE_PLUGIN_ROOT:-${CLAUDE_PROJECT_DIR:-.}}` does not expand). The two distribution paths are now **decoupled**: the root `.mcp.json` uses `${CLAUDE_PROJECT_DIR:-.}/build/index.js` for the clone/contributor workflow, and the plugin carries its own MCP config in `.claude-plugin/plugin.json` using `${CLAUDE_PLUGIN_ROOT}/build/index.js`. Because `plugin.json` now declares `mcpServers`, the plugin no longer auto-loads the root `.mcp.json`, so there is no double-registration. See the README's [Running from a clone](README.md#running-from-a-clone-in-claude-code-project-scope-mcpjson) section. ([#15](https://github.com/sweetrb/apple-mail-mcp/issues/15))

## [1.5.4] - 2026-06-01

### Fixed
- **`.mcp.json` failed to load as a project-scope config** — the entrypoint was `${CLAUDE_PLUGIN_ROOT}/build/index.js`, but `CLAUDE_PLUGIN_ROOT` is only set when the server is launched from a marketplace **plugin** install. Loaded as a project-scope `.mcp.json` (Claude Code run from inside a clone — the local-dev and contributor workflow), the variable is unset and, with no default, Claude Code fails to parse the config and the server never loads. Now uses the documented dual-context form `${CLAUDE_PLUGIN_ROOT:-.}/build/index.js`: plugin installs still resolve against the plugin root, while project-scope use falls back to `./build/index.js` relative to the repo. ([#15](https://github.com/sweetrb/apple-mail-mcp/issues/15))
- **`search-messages` returned zero results whenever `dateFrom`/`dateTo` was set on non-English system locales** — the date bounds were compiled into AppleScript as `date "May 30, 2026"` string coercion, which Mail.app parses using the system locale. On a non-English locale (e.g. pt_PT) the English month name throws `Invalid date and time (-30720)`; because the comparison runs inside the per-message `try` block, the error was silently swallowed and every message was skipped, so date-filtered searches returned nothing even when matching messages existed. The comparison date is now built from numeric components (`set year/month/day/…`) in a new locale-independent `buildAppleScriptDate()` helper, so date filters work regardless of system locale. A date-only `dateTo` is now treated as end-of-day so the upper bound includes messages received later that same day. ([#15](https://github.com/sweetrb/apple-mail-mcp/issues/15))

## [1.5.3] - 2026-05-27

### Fixed
- **`move-message` / `batch-move-messages` failed for nested destinations** — moving to a nested mailbox (e.g. an Exchange `Moore` subfolder) was silently failing because the destination was resolved via `mailbox "X" of account "Y"`, which only finds certain top-level mailboxes. Destination resolution now walks the flat `mailboxes of account` list (which already enumerates nested mailboxes by path, e.g. `Processed/Vendors`) and matches by exact name, using the matched reference directly. Source-message lookup also benefits — it now reaches messages in nested mailboxes. `batch-move-messages` now propagates distinct per-message errors (`not found` vs `ambiguous` vs `message not found`) instead of a generic "Failed to move message." Move timeout bumped 60s → 90s. ([#14](https://github.com/sweetrb/apple-mail-mcp/pull/14) by @kevinmay-scoutsolutions)

### Changed
- **`move-message` refuses to guess when the destination name is ambiguous within an account** — if the destination name matches more than one mailbox (e.g. two `Drafts` mailboxes in the same Gmail account), the move now fails with a clear `ambiguous (N matches)` error instead of silently moving the message into an arbitrary match. This is a behavior change: previously some such moves succeeded, but you couldn't tell *which* mailbox received the message. Pass a full path (e.g. `Parent/Drafts`) to disambiguate.

## [1.5.2] - 2026-05-27

### Fixed
- **`search-messages` silently ignored `from`, `subject`, `isRead`, `isFlagged` filters** — these four parameters were declared in the tool's input schema but the handler never forwarded them to `searchMessages()`, so callers (and LLM agents) reasonably assumed they worked while results came back unfiltered. The handler now passes all four through, and `searchMessages()` builds them into the AppleScript `whose` clause as AND filters. The existing `query` (subject-OR-sender) is parenthesized so precedence holds when combined. Clause-building logic is extracted to a pure `buildSearchCondition()` with 9 unit tests covering the `isRead:false` / `isFlagged:false` not-dropped regression, OR-grouping, and quote/backslash escaping. ([#13](https://github.com/sweetrb/apple-mail-mcp/pull/13) by @kevinmay-scoutsolutions)

### Changed
- **`search-messages` schema descriptions for `from` and `subject` clarify substring-match semantics** — `from` is a substring match against the full `Display Name <addr>` string (not an exact-address match), and `subject` is a substring match.

## [1.5.1] - 2026-04-28

### Fixed
- **Plugin install: `build/` not produced on marketplace install** — Claude Code installs path-source plugins by `git clone` only; it does not run `npm install`, so the `prepare` hook never fired and the cached plugin directory was missing `build/index.js`. The MCP server failed to start until the user manually ran `npm run build` inside the cached plugin dir. Build artifacts in `build/` are now committed to the repository so they are present immediately after marketplace clone. A pre-commit hook keeps `build/` in sync with `src/`, and CI fails if the committed `build/` is stale. ([#10](https://github.com/sweetrb/apple-mail-mcp/pull/10))
- **`.mcp.json` plugin entrypoint resolved against user cwd** — `args` referenced `build/index.js` as a relative path, so the MCP server only started when Claude Code was launched from inside a clone of this repo. Now uses `${CLAUDE_PLUGIN_ROOT}/build/index.js` so the path resolves against the plugin's install location. ([#10](https://github.com/sweetrb/apple-mail-mcp/pull/10) by @natekettles)

### Changed
- **`prepare` script no longer rebuilds.** It now runs `husky` only. Build artifacts are committed and kept current by the pre-commit hook; rebuilding on every `npm install` was producing churn in `git status` for daily development.

## [1.5.0] - 2026-04-20

### Fixed
- **Attachments invisible to AppleScript** — `list-attachments` and `save-attachment` returned empty across all account types (iCloud, Google, Exchange) when attachments were embedded as MIME parts in the message source (a known limitation of Mail.app's AppleScript bridge). Both tools now use a two-attempt pattern: AppleScript first, then fall back to parsing the raw MIME source of the message. Path-traversal protection is preserved on the fallback save path. ([#8](https://github.com/sweetrb/apple-mail-mcp/pull/8) by @kevinmay-scoutsolutions)
- **`hasAttachments` accuracy** — `get-message` now detects MIME-embedded attachments via raw source scan when AppleScript reports zero. `list-messages` uses the fast AppleScript count path only (may false-negative on MIME-embedded; use `get-message` or `list-attachments` for authoritative info).

### Added
- **Nested multipart support in MIME parser** — attachments nested inside `multipart/alternative` (text+html) or `multipart/related` (inline images) containers are now discovered by recursive descent.
- **Non-base64 transfer encoding decoding** — MIME fallback now supports `quoted-printable` and `7bit`/`8bit`/`binary` attachments in addition to base64.
- **New module `src/utils/mimeParse.ts`** — standalone MIME parser (zero dependencies) with 18 unit tests covering single/multi attachments, nested multipart, inline dispositions, and all supported transfer encodings.

## [1.4.0] - 2026-04-03

### Fixed
- **reply-to-message empty body from background processes** — Replies (and forwards) sent via the MCP server had empty body text because `reply msg with opening window` creates a GUI compose window that doesn't fully initialize from non-interactive processes. Switched to `without opening window`, which makes `set content` work immediately and reliably. `In-Reply-To` and `References` headers are still set correctly by Mail.app. ([#7](https://github.com/sweetrb/apple-mail-mcp/issues/7))
- **forward-message empty body from background processes** — Same root cause and fix as reply-to-message. `forward msg with opening window` → `without opening window`.
- **Removed no-op quoted content concatenation** — The old `& content of theReply` / `& content of theForward` appended to the body was always empty (the quoted content lives in Mail.app's HTML layer, not the plaintext `content` property). Removed the dead concatenation.

## [1.3.0] - 2026-04-01

### Changed
- **Search all mailboxes by default** - `search-messages` and `list-messages` now search across all mailboxes in an account when no mailbox is specified, instead of defaulting to INBOX. This dramatically improves results for Gmail accounts where messages live in labels rather than INBOX. Deduplication ensures each message appears only once.
- **Multi-account listing** - `list-messages` now iterates all accounts when no account is specified, matching the existing behavior of `search-messages`.

### Fixed
- **Date filter validation** - `dateFrom` and `dateTo` now reject non-parseable date strings (e.g., "31", "abc") with a clear error message instead of crashing AppleScript. The existing regex security filter is preserved; a semantic `.refine()` check is added on top.

## [1.2.1] - 2026-03-27

### Security
- **Message ID validation** - Message IDs are now validated as numeric-only (`/^\d+$/`) to prevent injection attacks
- **Batch size cap** - Batch operations are limited to a maximum of 100 messages per request
- **Date filter validation** - Date filters are validated to allow only alphanumeric characters and safe punctuation; an additional belt-and-suspenders `escapeForAppleScript()` call is applied before interpolation
- **Attachment save path traversal prevention** - `save-attachment` uses `path.resolve` and restricts save paths to the user's home directory, `/tmp`, `/private/tmp`, and `/Volumes`; attachment names containing `/`, `\`, null bytes, or `..` are rejected
- **Defense-in-depth ID coercion** - All AppleScript message ID interpolations now use `Number(id)` as an extra safeguard
- **Attachment count limit** - `send-email` and `create-draft` enforce a maximum of 20 file attachments

### Added
- **Security test suite** - `src/security.test.ts` with unit tests for all input validation schemas and path traversal prevention
- **Integration test suite** - `test/integration.test.ts` for live Mail.app testing
- **New npm scripts** - `test:integration` and `test:all` for running integration and combined test suites

## [1.2.0] - 2026-03-14

### Added
- **send-serial-email** - Mail merge tool: send personalized emails to multiple recipients with `{{placeholder}}` token support (max 100 recipients per batch) (PR #3 by @michaelhenze)
- **File attachments** - `send-email` and `create-draft` now accept an optional `attachments` parameter (array of absolute file paths) (PR #2 by @michaelhenze)

### Fixed
- **Locale-independent date parsing** - Dates now display correctly on non-English macOS systems (e.g., German). Previously, locale-dependent date strings could cause all emails to show the current date instead of actual received date (PR #4 by @michaelhenze)
- **Send/draft timeout resilience** - Increased timeout from 30s to 60s and enabled automatic retry with exponential backoff for `send-email` and `create-draft`, preventing failures when Mail.app is slow to establish SMTP connections

### Improved
- Attachment paths are validated (must be absolute, must exist) before sending — provides clear error messages instead of cryptic AppleScript failures
- `send-serial-email` uses `spawnSync("sleep")` instead of CPU-burning busy-wait between sends
- `send-serial-email` enforces safety limits: max 100 recipients, max 10s delay between sends

## [1.1.1] - 2026-03-10

### Fixed
- TTL cache for account and mailbox name resolution to reduce redundant AppleScript calls

## [1.1.0] - 2026-03-09

### Added
- **Batch operations** - `batch-mark-as-unread`, `batch-flag-messages`, `batch-unflag-messages`
- **Mailbox management** - `create-mailbox`, `delete-mailbox`, `rename-mailbox`
- **Mail rules** - `list-rules`, `enable-rule`, `disable-rule`
- **Contacts** - `search-contacts` (Contacts.app integration)
- **Email templates** - `save-template`, `list-template`, `get-template`, `delete-template`, `use-template`
- **save-attachment** - Download attachments to disk
- **HTML content** - `preferHtml` option in `get-message`
- Date received in search/list output
- Sender filter and pagination (`from`, `offset`) for `list-messages`
- Date range filtering (`dateFrom`, `dateTo`) for `search-messages`
- Cross-account search when no account specified
- Exposed `unflag-message` tool (was implemented but not wired up)

### Fixed
- Use Mail.app's configured default send account instead of hardcoded fallback (PR #1 by @Leewonchan14)
- Add message ID to search and list results (PR #1 by @Leewonchan14)

## [1.0.0] - 2026-01-06

First stable release with full Apple Mail integration.

### Features

#### Message Operations
- **search-messages** - Search messages by query, sender, subject with filtering options
- **list-messages** - List messages in any mailbox with pagination
- **get-message** - Retrieve full message content (subject, body, metadata)
- **send-email** - Send emails with To, CC, BCC recipients from any account
- **create-draft** - Save emails to Drafts folder without sending
- **reply-to-message** - Reply to messages with reply-all support, send or save as draft
- **forward-message** - Forward messages to new recipients with optional body
- **mark-as-read** / **mark-as-unread** - Toggle message read status
- **flag-message** / **unflag-message** - Toggle message flagged status
- **delete-message** - Move messages to Trash
- **move-message** - Organize messages into mailboxes

#### Mailbox Operations
- **list-mailboxes** - List all mailboxes/folders with unread counts
- **get-unread-count** - Get unread count for specific mailbox or all accounts

#### Account Operations
- **list-accounts** - List all configured Mail accounts

#### Diagnostics
- **health-check** - Verify Mail.app connectivity and permissions
- **get-mail-stats** - Get message and unread counts per account

### Technical
- Full AppleScript integration with proper escaping and error handling
- Retry logic with exponential backoff for transient failures
- User-friendly error messages with actionable suggestions
- Debug logging support (set DEBUG=1 or VERBOSE=1)
- 60-second timeout for message search operations
- Message ID lookup across all mailboxes for reliable operations

## [0.1.0] - 2026-01-06

Initial release - project skeleton.

### Added
- Initial project structure forked from apple-notes-mcp
- MCP server skeleton with tool definitions
- TypeScript types for Mail data models
- AppleScript utilities with error handling
