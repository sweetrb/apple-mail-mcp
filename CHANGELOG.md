## [Unreleased]

## [2.10.15] - 2026-08-13

### Fixed

- **Every by-id message mutation could land on a different message than the one you named, and report success for it** (#152). A Mail.app numeric message id is unique only *within a mailbox*, and a label store (Gmail, iCloud) exposes one message in several mailboxes under the **same** id — verified on a real account, id `75815` is reported simultaneously by `All Mail`, `Sent Mail` and `INBOX`. `move-message`, `delete-message`, `batch-move-messages`, `batch-delete-messages` and the batch read/flag ops all walked every account's every mailbox and applied the operation to the **first** match. `mailboxes of account` yields `INBOX` late, so an id listed from INBOX was reliably operated on in `All Mail`/`Important` instead: the call reported success, the INBOX message stayed where it was, and a different copy was moved or deleted. The reported `success` count was the number of ids passed, not the number of messages actually affected, so it could not be used to verify the outcome either.
- **Mutations are now scoped to the mailbox the id was listed from.** The fix reuses `idLocationIndex` — the id→(account, mailbox) map that every `list-messages`/`search-messages` already populates, and that the read paths already consult for exactly this reason — so the normal list-then-mutate flow now opens the one right mailbox instead of guessing. This also removes the full account→mailbox tree walk from the batch path, so batches touch far fewer mailboxes than before.
- **An id with no recorded source mailbox is refused when it is ambiguous, rather than resolved to an arbitrary copy.** Ids supplied out-of-band (or evicted from the index) are looked up across all mailboxes; if exactly one holds the id the operation proceeds as before, and if several do the call fails naming the candidate mailboxes and asking you to list or search that mailbox first. Silently mutating whichever copy sorted first is what made the original bug invisible.
- Note for callers that already use `imap:` ids: those were never affected. They encode account + mailbox path + UID, so they were always unambiguous — this bug was specific to the bare-numeric AppleScript ids returned when no IMAP account is configured.

## [2.10.14] - 2026-08-13

### Documentation

- **`resolve-message-id` has been advertised since 2.8.0 and was never in the README's Tool Reference** — 50 tools on the wire, 49 documented. Nothing surfaced it: the tool works, `tools/list` returns it, and every check in this repo compared the README only to itself. It now has a full entry (parameters, return shape, the account/INBOX-first scoping), including the point 2.10.1 corrected everywhere else: it is **not** needed to apply a flag color any more. An agent that believes otherwise resolves `imap:` ids purely to color a flag and reintroduces the AppleScript/TCC dependency 2.10.0 removed — the dependency that previously killed four consecutive scheduled jobs.
- **New guard: `src/docsTruth.test.ts`, which checks the docs against the CODE rather than against themselves.** `readmeEscaping.test.ts` and `claudeMdEscaping.test.ts` prove one section of one doc is internally consistent; they cannot see a doc that is coherent and wrong. This one asserts three things across `README.md`, `CLAUDE.md` and `docs/*.md`: every ` ```json ` fence parses as JSON (a malformed example in setup docs breaks whoever copies it); every `APPLE_*` environment variable the docs name exists somewhere under `src/`, with tests excluded, so a renamed or deleted knob cannot keep being advertised; and the README's `## Tool Reference` documents **exactly** the tool surface the built server advertises over stdio — both directions, so a tool shipped without docs and a renamed tool whose docs stayed behind each fail, with the offending names printed. The tool list is read off the wire, not regexed out of `src/index.ts`, because the wire is the contract users see. Every assertion also fails when it finds nothing to check, so deleting the inputs cannot make the suite pass on an empty set.
- **Two fence retags, both honest rather than allowlisted.** The `"args": ["${CLAUDE_PROJECT_DIR:-.}/build/index.js"]` example is a one-line fragment, not a JSON document, so it is now ` ```text ` — the tag the escaping section already uses for the identically shaped `"body": "…"` fragment. The IMAP `env` blocks in `README.md` and `docs/IMAP-SETUP.md` were tagged ` ```jsonc ` while containing no comment: plain valid JSON, where the tag bought nothing but exemption from the parse check. They are now ` ```json ` and are checked, and a companion assertion makes that permanent — a ` ```jsonc ` block with no comment in it fails, so the tag cannot become a way to opt out.

No runtime code changed; the committed `build/` bundle is byte-identical.

## [2.10.13] - 2026-08-13

### Documentation

- **The README's backslash-escaping instruction was wrong, and the README is the copy that ships.** It told agents to send four backslashes to produce one literal backslash — `Windows paths: C:\Users\ → C:\\\\Users\\\\ in JSON`, and the same four-backslash form in the worked `send-email` example and in the shell-path and regex bullets. A JSON string literal containing four backslashes decodes to **two** literal backslashes, so an agent that followed the instruction sent `C:\\Users\\` and the recipient got a doubled backslash in every path, regex, and escaped space in the message body. The correct form is two backslashes per literal backslash, which is what this repo's `CLAUDE.md` already said — so one repo carried two contradictory instructions, and the wrong one was the published one (`README.md` is in `package.json` `files[]`; `CLAUDE.md` is not). Every four-backslash instruction is now the two-backslash form.
- **The sentence explaining the rule was self-contradictory and is rewritten.** It read "The `\\\\` in JSON becomes `\\` in the actual string, which represents a single `\`" — but `\\` in the resulting string is two characters, not one. It now states the rule plainly: in a JSON string literal, `\\` (two characters) denotes one literal backslash, and four denote two.
- **Dropped the Windows examples from `README.md` and `CLAUDE.md`.** This package is `os: ["darwin"]` and drives Mail.app through AppleScript; a `C:\Users\` example is generic MCP boilerplate that was never localized to these servers — and it is precisely where the four-backslash error lived. Replaced with macOS-native examples of equal teaching value: a shell path with an escaped space (`~/Library/Mobile\ Documents/…`, whose unescaped form is not even valid JSON, so the failure mode is real rather than cosmetic) and a regex (`\d+`). Nothing is lost for Windows users: the table's generic rows (`\` → `\\`, `\\` → `\\\\`) are platform-neutral and still cover drive paths.
- **`README.md` is now covered by an executable doc guard** (`src/readmeEscaping.test.ts`), which is why this bug survived: the guard added a day earlier checked `CLAUDE.md` only — the file that does **not** ship — while the file that does ship went unchecked. It now asserts that every "common patterns" bullet is self-consistent (JSON-decoding the "send this" side yields the "you want" side — the exact assertion that would have caught this), that each worked example decodes to its `→ arrives as:` annotation (parsing the fenced JSON block as JSON and reading its `body` field, rather than eyeballing backslash counts), that every "Incorrect" example genuinely fails to parse, and that neither doc reintroduces a Windows drive path. Each assertion also fails when it finds nothing to check, so a doc rewrite cannot make the suite pass vacuously.

No runtime code changed; the committed `build/` bundle is byte-identical.

## [2.10.12] - 2026-08-12

### Fixed

- **Every tool was refused by JSON Schema 2020-12 clients, because the advertised schemas declared the draft-07 dialect** (#147). The symptom is total: the server connects, then each tool is rejected with `Tool '<name>' has an invalid outputSchema: JSON Schema declares an unsupported dialect ("$schema": "http://json-schema.org/draft-07/schema#"). The default validator supports JSON Schema 2020-12 only.` The MCP SDK's `server/mcp.js` calls its zod→JSON Schema converter with **no target**, so `mapMiniTarget(undefined)` resolves to `draft-7` and every emitted `inputSchema` **and** `outputSchema` gets stamped with the draft-07 `$schema`. MCP has since standardized on 2020-12, so a conforming client discards the whole tool list. Outgoing `tools/list` payloads are now normalized to 2020-12 at the transport boundary — the only public seam that does not reach into SDK internals.
- **Upgrading zod does not fix this**, so don't try it: verified empirically against SDK 1.30.0 + zod 4.4.3, whose v4 (`zod/v4-mini` `toJSONSchema`) branch still emits draft-07 because the SDK never passes a target. The normalizer is version-independent and keeps working if the SDK's default ever changes.
- The rewrite is a true dialect conversion, not a string swap on `$schema`: `definitions` → `$defs` (with `#/definitions/X` refs repointed at `#/$defs/X`), tuple-form `items` → `prefixItems` (with a sibling `additionalItems` → `items`), `dependencies` → `dependentRequired`/`dependentSchemas`, and boolean `exclusiveMinimum`/`exclusiveMaximum` folded into their numeric 2020-12 form. Nested subschemas are stripped of their own `$schema` so only the document root declares a dialect. Today's schemas contain none of those constructs — the conversion is a no-op on them — so the converter exists to keep the emitted schemas honest if a new zod construct introduces one.
- **The conversion is position-aware, so a tool parameter that happens to share a keyword's name is never rewritten.** A `properties` map's keys are caller-chosen parameter names, not schema keywords: without this, a parameter named `definitions` would be renamed to `$defs` on the wire and one named `$schema` would be **silently deleted** — while `required` still named the original, producing a schema no input could satisfy — and parameters named `dependencies` or `additionalItems` would be restructured or dropped. The same distinction applies to `enum`/`const`/`default`/`examples`, which hold instance **data**: recursing into them would rewrite a caller's literal values as if they were schema keywords. Keyword rewrites now apply only at schema positions; `properties`, `patternProperties`, `$defs` and `dependentSchemas` have only their **values** converted. No tool on the current surface hits a corrupting name, so this was latent rather than live — fixed before the release rather than after.
- No tool, parameter, or output shape changed: all 50 tools still advertise the same schema bodies, now under the 2020-12 dialect. `test/output-schema.test.ts` boots the real bundle over stdio and asserts, on the wire, that every advertised schema declares 2020-12, mentions no draft-07, uses no draft-07-only construct, and carries no nested dialect declaration.

## [2.10.11] - 2026-08-12

### Security

- **Bumped `imapflow` 1.6.3 → 1.6.5, which blocks IMAP command injection.** Upstream's 1.6.4 is described as "block IMAP command injection and harden rev2 protocol handling", and 1.6.5 resolves regressions from that hardening and hardens further. `imapflow` is not a development dependency here — it is the IMAP client behind every direct-IMAP path (search, move, archive, counts, the whole non-AppleScript surface) and it is **inlined into the committed `build/index.js`**, so every published artifact before this one carried the unhardened version. Recorded under Security rather than left as the automated "dependency bump" line, because the shipped bytes changed in a way that matters.

### Changed

- Bumped `nodemailer` 9.0.3 → 9.0.4 (also inlined into the bundle; SMTP send path) and the `typescript-eslint` toolchain 8.65.0 → 8.66.0 plus `globals` 17.8.0 → 17.9.0 (development scope only). Committed bundle rebuilt. (#145)

## [2.10.10] - 2026-08-10

### Fixed

- **An account switched OFF in Mail.app is no longer counted as an unreadable one, which could make an unscoped `get-unread-count` / `get-mail-stats` report a spurious `partial`** (#143). `planCountSources` assigned every Mail.app account a source — its matching IMAP config, else AppleScript — without consulting the account's `enabled` flag. A disabled account has no live connection, so an AppleScript count against it can fail server-side (AppleEvent -10000); that failure was folded into `failedAccounts` and the result marked `partial: true`, whose text tells the caller "the real total is higher". For a deliberately-disabled account that is simply untrue — nothing is missing and the total is exact. This is the same condition `guardAccountEnabled` already refuses for mailbox writes; the count planner just never applied it. A disabled account with no IMAP config is now **not a source at all** rather than a failing one.
- The symptom is **intermittent, not constant**: Mail only errors on a disabled account in some states, so the same call can return a clean count on one run and a spurious `partial` on the next. Don't expect it to reproduce on demand.
- Scope is deliberately narrow: a disabled Mail account that **does** have an IMAP config is still counted, over IMAP. IMAP talks to the server directly and does not care about Mail's toggle, and the config is an explicit "read this account" instruction — that is how a mailbox stays readable by this server while staying out of Mail.app's UI. An account whose `enabled` flag is absent is treated as enabled, so backends that don't report it are unaffected.

Found by a scheduled TCC watchdog whose canary read the resulting partial as a possible Apple Events reset. It was not one: a real grant loss fails *every* AppleScript account, not a single named one while the others return counts.

## [2.10.9] - 2026-08-08

### Fixed

- **`get-mail-stats`' overall deadline could not see time the call spent queued, so it still failed to bound the call** (#135, second follow-up). 2.10.8 put every step of the tool under one wall-clock deadline; this puts the *wait to become the running call* under it too. Every tool call is serialized through the AppleScript gate (#11), so concurrent calls run strictly one at a time — but the deadline clock started on the handler's first line, which only runs once the gate releases. A call therefore measured its own execution and none of its wait, while the caller had been waiting since it sent the request. Measured here on 3 IMAP accounts: three concurrent unscoped calls returned at **5.5s / 10.3s / 15.6s** — a 1×/2×/3× staircase of the ~5.2s solo cost — and with `APPLE_MAIL_MCP_STATS_DEADLINE_MS=6000` the third still returned **`partial: false` at 15.9s**, having spent ~10s queued that the 6s deadline never charged for. This is the same shape as the 2.10.8 bug one level up: bounding the handler does not bound the request. The deadline is now anchored at **arrival**, before the gate, so queue wait is spent from the same budget as the work.
- **A queued-out call now fails fast and names the queue, instead of doing work the caller will never see.** Arriving with the deadline already spent used to mean starting a full fan-out anyway — pushing the answer past the client request timeout that was about to fire, and reporting a cause (slow account, tight budget) that was not the real one. It now returns immediately, says how long it waited, and points at the actual remedy: issue the calls one at a time, or prefer `get-unread-count`. Raising `APPLE_MAIL_MCP_STATS_BUDGET_MS` cannot help here, because the remaining deadline caps the per-account budget.
- **Queue wait is now reported rather than invisible.** Both `get-mail-stats` paths add a `queueWaitMs` field (and a line of text) when a call waited ≥1s, and the `PARTIAL` warning attributes the shortfall to the queue when the queue is what consumed the deadline. This is the number that explains a measurement no budget accounts for: @ismyemailaddress reported unscoped calls succeeding in 28–29s against a 25s per-account budget, and batches of 3 and 5 concurrent calls taking ~74s and ~123s — both ≈ N × the single-call cost, which is the serialization staircase, not intermittency.

### Changed

- **`withErrorHandling` stamps each call's arrival time before the serial gate** and exposes it through `currentCallTiming()` (`AsyncLocalStorage`, so it survives awaits inside a handler and cannot leak between concurrent calls). Any tool working to a wall-clock deadline can now anchor it where the client does. No handler signatures changed.
- **New manual harness `test/stats-queue-harness.mjs`** fires N concurrent unscoped calls at a real IMAP setup and reports **per-call** send→response latency, which is what distinguishes server-side serialization from a client that serialized its own dispatch — batch-only timing cannot. It fails if any call outlives the deadline, or if calls clearly queued yet none reported it. Confirmed to be a real guard rather than a tautology: the shipped 2.10.8 bundle fails it (worst call 13.9s against a 6s deadline, all three claiming `partial: false`) and 2.10.9 passes. Unit coverage for the timing seam itself is in `src/tools/respond.timing.test.ts` (arrival stamped before the gate, per-call isolation, survives awaits, no leak after an erroring call).

### Security

- **Floored `js-yaml` to `^4.3.1`, clearing GHSA-5p4m-2wfm-xmqj (high).** Quadratic CPU consumption while resolving `!!omap` keys — a malicious YAML document can be made to burn CPU superlinearly in the number of map entries. The advisory notes the CVE-2026-59870 fix was never backported to the 3.x line, so 4.3.1 is the first complete release. `js-yaml` reaches the tree as `eslint` -> `js-yaml`, which is **development scope**, and it does not appear in the committed `build/index.js` — verified, 0 references — so no published artifact ever carried it and this owes no version bump. The override entry already existed here as `js-yaml: ^4.2.0`, a floor written for an earlier advisory: **an out-of-date floor is not something a caret range protects against**, because a caret only stops the tree moving backwards, never forwards onto a newer fix. The sibling repos carried no `js-yaml` entry at all and were floored for the first time.
- **Raised the `postcss` floor from `^8.5.15` to `^8.5.23`,** the patched release for GHSA-fxqj-rqcc-2cmp (moderate). Same defect as above in a second entry: the floor sat below the fix it was meant to enforce. The tree resolved a safe 8.5.25 anyway, because `vite`'s own range pulls it forward — so nothing was exposed, but the override was not doing the job it documented. Now matches apple-notes-mcp and apple-photos-mcp.

## [2.10.8] - 2026-08-07

### Fixed

- **`get-mail-stats` with no `account` could still die as a bare `-32001` with nothing returned** (#135, follow-up). 2.10.6 made the IMAP fan-out concurrent and gave each account a budget, which fixed the common case — @ismyemailaddress confirmed the scoped path and two of three unscoped calls on the same four-account setup — but one call in three still timed out with no `partial` and no `failedAccounts`, exactly the dead call the fix was meant to remove. The reason is that bounding each step separately does not bound the call: the per-account budget never covered the **Mail.app account enumeration that runs before the fan-out**, and that is its own blocking AppleScript read with a 30s cap. Worst case was therefore their **sum** — 30s enumerating + 25s counting — which is already past a typical 60s client request timeout, so no budget could fire in time. It was intermittent because the enumeration is cached for 60s: a warm cache made it free (the reporter's 28–29s runs, which are the fan-out alone), a cold one paid full price. Every step now draws from **one wall-clock deadline** for the whole call, `APPLE_MAIL_MCP_STATS_DEADLINE_MS` (default 50s, minimum 2s), so the tool is bounded rather than each of its parts, and whatever does not fit is reported instead of killing the call.
- **A failed Mail.app account enumeration no longer takes `get-mail-stats` down with it.** The enumeration now gets a bounded slice of the deadline (30%, capped at 10s) rather than the blanket 30s, and failing it degrades instead of aborting: every IMAP account is knowable from config alone, so the call falls back to counting those and names `Mail.app accounts (AppleScript enumeration)` in `failedAccounts`. Previously a wedged Mail.app produced no answer at all, even for accounts that never needed Mail.app.
- **The AppleScript half of the merged path was unbounded and could silently under-report.** Each non-IMAP account is counted with `listMailboxes`, whose own default timeout is **60s** — one such account could overrun any client request timeout on its own, and on failure it returned an empty list that was summed in as **0**, understating the totals while reading as a real answer (the #130 silent-zero class, still present here). Those reads are now charged against the remaining deadline and go through a new `listMailboxesChecked()`, so a failed or out-of-time account is named in `failedAccounts` rather than contributing a zero. `execSync` blocks the event loop, so these cannot be bounded by a `Promise` race from outside — the caller's remaining time is threaded down to `executeAppleScript`'s own SIGKILL-backed timeout, which is what the new tests assert.
- **`move-message` silently moved mail to the wrong mailbox when a leaf name matched more than one** (#137). Resolution matches a full path first, then falls back to the leaf name — which is what keeps names stored before `list-mailboxes` reported full paths (`Thornlands/Home Reno` rather than `Home Reno`) working. That fallback used `.find()`, so with `Archive` under both `Work` and `Thornlands`, passing `Archive` resolved to whichever the server happened to list first **and reported success**. A silent wrong move is worse than a refusal: the messages are in a plausible-looking wrong folder and nothing surfaces the mistake, so an agent moving a batch has no way to notice. All leaf matches are now collected, and more than one is refused with an error naming every candidate and asking for the full path. Exact-path matches still win outright and a single leaf match still resolves, so only the genuinely ambiguous case changes. Applies to `move-message`, `batch-move-messages`, `delete-mailbox` and `rename-mailbox`, which all shared the one resolver.

### Documentation

- **`APPLE_MAIL_MCP_STATS_DEADLINE_MS` documented** in the README env-var table, `docs/IMAP-SETUP.md`, and the `get-mail-stats` tool reference, including why per-step budgets were not sufficient and the advice to keep the deadline below the client's request timeout.
- **The mailbox-destination rule is now written down** rather than implied: the README's `move-message` entry documents full-path-then-unique-leaf matching and the ambiguity refusal, and `CLAUDE.md` tells agents to retry with the full path from `list-mailboxes` instead of guessing another name. `CLAUDE.md` also explains the `Mail.app accounts (AppleScript enumeration)` entry that can now appear in `failedAccounts`.

## [2.10.7] - 2026-08-06

### Fixed
- **One mailbox declared twice was counted twice by every merge-across-accounts tool.** IMAP accounts were deduplicated on the account **label**, so a config that declares the same mailbox through both the legacy singular keys (`APPLE_MAIL_MCP_IMAP_USER` + `_IMAP_ACCOUNT`) and an `APPLE_MAIL_MCP_IMAP_ACCOUNTS` entry carrying a different nickname produced **two** account specs — a different nickname walks straight past a label comparison. Nothing downstream re-checked, so every caller that fans out over the account list visited that mailbox twice and summed it twice. Measured live on a four-identity config where two identities are one Gmail mailbox: `get-unread-count` reported **23 against a true 15** (the duplicated mailbox's 8 counted twice), and `get-mail-stats` inflated both the message and unread totals the same way. Deduplication now keys on the **resolved `(host, port, user)` triple** — the mailbox's actual wire identity — through a new `imapIdentityKey()` that the connection pool's `poolKey()` also delegates to, so the pool's notion of "the same account" and the enumerator's are the same function and cannot drift apart. Host is folded case-insensitively (DNS is); the user local part is **not** folded, because RFC 5321 leaves it case-sensitive and silently dropping a real account would be worse than the double-count. The label check is kept as a secondary guard so two genuinely distinct mailboxes still cannot share one nickname.
- **Collapsing that duplicate does not break the nickname it collapsed.** The dropped entry's label is retained as an alias of the surviving account, so a caller already passing `account: "<nickname>"` keeps resolving to the same mailbox — it is simply no longer a second account. The three places that matched a selector against an account (the read-routing gate, the config resolver, and the composite-id ownership check) now share one `specMatchesSelector()` predicate instead of three copies of the same expression.
- **`doctor` reported `connection failed: undefined` for every account on an `APPLE_MAIL_MCP_IMAP_ACCOUNTS`-only setup** (#138). `imapHealthCheck`'s "is IMAP configured?" gate tested only the **legacy** `APPLE_MAIL_MCP_IMAP_USER`, so a config that declares its accounts solely through the documented multi-account JSON array — with no legacy singular keys at all — short-circuited to `{configured: false, ok: false}` carrying **no error field**, for every account, without ever attempting a connection. `doctor` interpolated that absent field straight into its message, producing the literal word `undefined` where the diagnosis should be. The gate now asks the same enumerator every other caller asks, so an ACCOUNTS-only config is correctly seen as configured and each account gets a real connection attempt and a real error. Setups that also set the legacy keys were unaffected, which is why this survived so long. Reported by **@jarrah31**.
- **`doctor` can no longer render the string `undefined` at all.** The failure branch interpolated an optional field bare; it now falls back to words, so any future health-check failure that carries no message still reads as a diagnosis rather than as a bug. Covered by a test that asserts the rendered report never contains `undefined`.
- **The "IMAP not configured" error now names `APPLE_MAIL_MCP_IMAP_ACCOUNTS` as well**, instead of pointing only at the legacy singular variable — the same asymmetry that produced #138, in user-facing text.

### Docs
- **`docs/IMAP-SETUP.md` now states that `APPLE_MAIL_MCP_IMAP_ACCOUNTS` is sufficient on its own** — the "Multiple accounts" section described the legacy vars as defining the first/default account and the array as adding "the rest", which reads as though an array-only config is unsupported. It is supported, it is what @jarrah31 was running in #138, and the first array entry becomes the default. The env-var reference no longer says only `APPLE_MAIL_MCP_IMAP_USER` enables IMAP. Also documents the rule the dedupe fix enforces: don't declare one mailbox twice, because an account's identity is its resolved `(host, port, user)`, not its label.

### Changed
- **`version-guard` now treats CHANGELOG release headings as append-only.** The existing rule proved only that the *new* version has a heading, which a PR can satisfy by **renaming an existing one** — retitling `## [1.1.12]` to `## [1.1.13]` leaves 1.1.13 documented and erases 1.1.12. apple-numbers-mcp #54 did exactly that, and because nothing downstream reads CHANGELOG.md it stayed invisible until an audit found the missing heading. Every `## [X.Y.Z]` heading present at the base must now still be present; adding is free, renaming or deleting one fails with an error naming the lost version. Verified by replaying #54's real base and post-merge files (fails, naming 1.1.12) and against all four repos' current CHANGELOGs (74/63/21/24 headings, all pass). The check runs outside the bump branch, because a rename can land in a PR that bumps or one that does not, and compares against the **checked-out tree** — the merge result under `pull_request` — so a branch left open across a release is never blamed for headings it has not merged yet. Deleting CHANGELOG.md outright is an explicit hard failure. Accepted trade-off: deliberately archiving old entries out of the file now fails too, since the guard cannot distinguish that from the rename that erased 1.1.12.
- **`version-guard` now requires `## [Unreleased]` to be empty on a bump.** The heading rule proves the new version is documented *somewhere*; it says nothing about notes still parked under `## [Unreleased]`, which the release drains — everything on main ships in the next publish, so prose left under that marker describes released behaviour while claiming to be unreleased, and nothing renames the section later. Nothing guarded this before. The guard also asserts the marker still exists, since `dependabot-rebuild.yml` hard-exits without it. Bot PRs are unaffected: that workflow inserts its `## [X.Y.Z]` heading directly below the marker and leaves it empty — verified by running its exact auto-bump snippet against all four repos' real CHANGELOGs. The guard lives in `.github/`, which does not ship, so those two rules owe no version bump of their own. `version-guard.yml` is in `conformance-check.sh`'s byte-identical set, and apple-notes/numbers/photos already carry this change on `main`: the file here is now **byte-identical** to theirs, and the change is a pure insertion (70 lines added, 0 removed).

## [2.10.6] - 2026-08-06

### Fixed
- **`get-mail-stats` failed on every path; the schema half of it silently affected all 50 tools** (#135). Scoped to an account, the call died client-side with `-32602 … data must NOT have additional properties`, discarding a result the handler had computed correctly. The cause is that the **client** validates `structuredContent` against the JSON Schema the server *advertised*, and a bare zod raw shape renders as `additionalProperties: false` — so any field the schema does not enumerate is fatal. `get-mail-stats`'s IMAP branch spreads an `ImapStats`, which carries `perMailbox`; that key was never declared. The server never noticed, because zod's own parse *strips* unknown keys instead of failing, which is exactly why the v2.3.0 migration's "all fields optional, no `.strict()`" was believed to be permissive: it covered optionality, not undeclared keys. Every tool is now registered through a wrapper that wraps its shape in `.passthrough()`, advertising `additionalProperties: true`. Measured against the shipped 2.10.5 bundle, **all 50 tools** advertised `additionalProperties: false`; `get-mail-stats` was simply the one whose payload tripped it. `perMailbox`, `partial` and `failedAccounts` are now declared as well, so the shape is documented rather than merely tolerated. Reported by **@ismyemailaddress**, whose diagnosis named the mechanism exactly, down to why the existing CI contract check could not catch it.
- **`get-mail-stats` with no `account` no longer times out on a multi-account IMAP setup** (#135). The all-accounts path counted each account **sequentially**, so wall clock was the *sum* over every account, and each account is one IMAP `STATUS` per mailbox — on Gmail, every label. Four accounts overran the client's request timeout and the whole call died as `-32001` with nothing returned. The pool is per-account, so accounts do not contend: they are now counted **concurrently**, making wall clock the slowest account rather than the sum (measured on three real accounts: 16.9s → 9.3s). Each account is additionally bounded by `APPLE_MAIL_MCP_STATS_BUDGET_MS` (default 25s, minimum 1s), so one wedged account degrades to a partial result instead of taking the other three down with it.
- **A failed account no longer vanishes from `get-mail-stats` as a silent zero.** The IMAP fan-out's `catch` logged to stderr and continued, so an unreadable account contributed 0 to the totals with nothing in the result saying so — the same defect #130 fixed in `get-unread-count`, left behind in this tool. Unreadable accounts now set `partial: true` + `failedAccounts` and are called out in the rendered text. A **scoped** call gets an explicit error instead, since a partial result for the single account you asked about would be no result at all.

### Added
- **The outputSchema contract test now asserts that every tool tolerates undeclared keys.** The existing checks — every tool has an `outputSchema`, none requires a field — could not see this class: they inspect the advertised schema and round-trip only `health-check` and `doctor`, so a tool whose payload carries an undeclared key passes CI and fails in the user's client. The suite now fails any tool advertising `additionalProperties: false`. Verified as a real guard rather than a tautology: it reports 50 offenders against the 2.10.5 bundle and 0 against this one.

## [2.10.5] - 2026-08-05

### Added
- **`version-guard` now requires every version bump to be documented under a real `## [X.Y.Z]` CHANGELOG heading.** The guard already refused a bump to a version that was already on npm, but it never checked that the new version was described anywhere. Notes parked under `## [Unreleased]` are orphaned the moment the release ships: nothing in the release path renames that section — the `version` lifecycle script only syncs the plugin manifests — so the published version goes out undocumented while its release notes sit under a heading still claiming they are unreleased. apple-notes-mcp shipped 2.6.10 and 2.6.11 exactly that way before this check existed. A bump whose version has no matching heading now hard-fails the PR, with an error naming the heading to add. Keep an empty `## [Unreleased]` at the top regardless — `dependabot-rebuild.yml` hard-exits without that marker, and since it already inserts a real heading, bot PRs pass unchanged. The guard file lives in `.github/`, which does not ship, so this owes no version bump. (#124)

### Changed
- **Dependency bumps** (Dependabot): `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0, `imapflow` 1.4.8 → 1.6.3, `globals` 17.7.0 → 17.8.0. `imapflow` is the runtime IMAP client, so this one ships: verified against the GreenMail `imap-integration` suite in CI and, locally, against all four real accounts (`doctor` connects to `imap.gmail.com` ×3 and `imap.mail.me.com`; `list-messages` fetches and parses live INBOX envelopes). Committed bundle rebuilt.

### Removed
- **`.hermes-plugin/` packaging docs** (`README.md`, `config.yaml`). Hermes Agent has no plugin/marketplace drop-in, so a directory of manifest-looking files was easy to misread as an installable package. The setup it documented is not lost — the `hermes mcp add` command, the `~/.hermes/config.yaml` `mcp_servers:` snippet, and the restart note now live inline in the README's "Other Hosts" section, which is where users actually look. Thanks to @maf4711 (#115). No effect on the published package: `.hermes-plugin/` was never in `package.json` `files[]`.

### Fixed
- **`version-guard` no longer demands a version bump for byte-neutral `src/` changes.** The shipped-bytes detector treated every non-test file under `src/` as shipped, but TypeScript there reaches users only after esbuild inlines it into `build/index.js` — so a comment-, formatting- or type-only edit that leaves the committed bundle byte-identical was hard-blocked, leaving only two bad options: publish a release of literally nothing, or do not write the comment. `src/**/*.ts` is now a first-cause detector that implies a bump only when `build/**` changed too. The exemption is sound rather than merely convenient: ci.yml's "Verify committed build/ matches source" step rebuilds and requires `git diff --quiet build/`, and it runs in the `test` job whose `test (22)`/`test (24)` contexts are required by branch protection — so at merge time an unchanged `build/` provably matches `src/`. Everything else under `src/` (the verbatim-shipped `*_reader.py` sidecars), `requirements.txt` and `build/**` stay unconditional detectors, and the rule is written fail-safe: only `.ts` counts as bundle-only, so any new file type under `src/` still requires a bump.
- **Dependabot auto-bump silently stopped staging its own changes.** `dependabot-rebuild.yml`'s bump step writes the patch version, syncs the plugin manifests and prepends a CHANGELOG entry, then staged them with `git add package.json CHANGELOG.md build .claude-plugin .agents codex .hermes-plugin .antigravity-plugin`. Once `.hermes-plugin/` was removed that pathspec matched nothing, and `git add` is all-or-nothing — it exited 128 and staged **none** of the others, with `2>/dev/null || true` hiding the failure. The following step re-adds only `build/`, so a Dependabot PR would have committed a rebuilt bundle with no version bump and no changelog entry, failing `require-version-bump` and blocking the automation that is meant to run without a human. Dropped the stale path, and dropped the error suppression so a future missing path fails loudly instead of silently skipping the bump.
- **`pnpm version` no longer fails after the `.hermes-plugin/` removal.** The `version` lifecycle script still ran `git add … .hermes-plugin …`; `git add` exits 128 on a pathspec that matches nothing, which would have broken the documented release step (`pnpm version <patch|minor|major> --no-git-tag-version`) for every subsequent release. The stale path is dropped from the `git add` list (#115).

### Security
- **Floored `hono` to `^4.12.34`, clearing GHSA-8j4g-w8fx-2239 (moderate) — the last open advisory on this repo.** 2.10.2 deliberately left this one out: the fix release was still inside the 24-hour `minimumReleaseAge` supply-chain soak, missing the cutoff by 41 minutes, and `pnpm install` refused it with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. No `minimumReleaseAgeExclude` carve-out was added then and none was added now — the soak is the point, and `hono` has **0 references in `build/index.js`**, so nothing vulnerable shipped while it waited. It matured at 2026-08-04T02:36:40Z. `pnpm audit` now reports **no known vulnerabilities**. The committed bundle is byte-identical, so no version bump is owed.
- **Moved both dev-only `brace-expansion` paths onto their complete fixes for GHSA-mh99-v99m-4gvg / CVE-2026-14257 (high)** — `1.1.18` on the v1 line and `5.0.9` on the v5 line. The two majors are floored independently because they are not API-compatible: ESLint reaches `brace-expansion` through `minimatch@3.1.5`, which requires the v1 CommonJS API, so forcing the v5 line the advisory names as patched into that path fails with `expand is not a function`; the upstream v1 backport is the only fix that applies without crossing that boundary. `minimatch@10.2.6` reaches the v5 line independently. Both floors are written as two-sided ranges (`>=1.0.0 <1.1.18`, `>=5.0.0 <5.0.9`) — a bare `<5.0.9` also matches `1.1.18` under semver and would drag the CommonJS path onto v5. The advisory's own first-patched versions (`1.1.17` / `5.0.8`) are **not sufficient**: they bound the accumulator in `combine` but never thread `maxLength` into `expandSequence`, leaving the sequence path (`{1..N}`, `{a..z..k}`) capped only by item count, so a padded sequence still materialises ~100,000 intermediate strings before the outer bound truncates (measured 4,606 ms / 176 MB RSS on `1.1.17` vs 9 ms / 61 MB on `1.1.18`, identical final output). `1.1.18` and `5.0.9` add the missing bound. Both were adopted only after clearing this repo's 24-hour `minimumReleaseAge` supply-chain gate, with no `minimumReleaseAgeExclude` carve-out and no audit suppression — `pnpm audit` will keep reporting the advisory until GitHub's metadata (which still lists `5.0.8` as first-patched, and so marks the entire v1 line vulnerable under semver) catches up. Dev toolchain only: `brace-expansion` is not in the shipped bundle, so the published package is unaffected, the committed bundle is byte-identical, and no version bump is owed. Thanks to @jjoanna2-debug (#119, #121, #123).

## [2.10.4] - 2026-08-03

### Fixed
- **A failed AppleScript transport is no longer reported as a legitimate zero or empty answer** (#130). `getUnreadCount` returned `0` and `fetchAccounts` returned `[]` whenever the underlying call failed — timeout, wedged Mail, missing Automation grant — and the error went only to the server's stderr, so the MCP payload was a clean success. An agent or unattended triage run saw `0 unread` / `No Mail accounts found` while Mail actually held thousands of unread messages. `list-messages`/`search-messages` already surfaced `partial` + `timedOutAccounts`; the count and account tools never got the same treatment. `fetchAccounts` now returns `null` on transport failure, which is deliberately distinct from `[]` ("Mail answered, and there are genuinely no accounts"). `list-accounts` returns an **error** naming the cause instead of "No Mail accounts found"; `get-unread-count` returns an **error** instead of `0`, and in the multi-account fan-out marks any unreadable source with `partial: true` + `failedAccounts` rather than folding in a silent zero. Reported by **@jacobjove** with a transport-wedge repro and exact code citations.
- **A failed account fetch is no longer cached.** Not in the original report, and it compounded the bug: `getCachedAccounts` stored the empty list on failure, so one timeout poisoned every subsequent call for the full 60-second TTL and Mail kept looking account-less long after it had recovered. Failures are no longer cached, and the last known-good list is served while the error stays reportable.
- **The IMAP branch of `get-unread-count` no longer silently undercounts.** Its `catch` logged a failed account and continued, so that account contributed 0 to the total with nothing in the result saying so. It now joins `failedAccounts`.

## [2.10.3] - 2026-08-03

### Fixed
- **`search-contacts` now returns the phone numbers it has always claimed to return.** The tool description promised phones twice ("find their email address(es)/phone(s)" and "Returns: … and phone numbers"), as did the README and `CLAUDE.md` — four claims, zero code paths. `contactsDb` was already reading phones in the same query that reads emails, and the handler discarded them one line before serialization, from both the rendered text and `structuredContent`. An agent asked to look up someone's number got a result with no phone and could only conclude the contact had none on file. Phones now appear in both projections; the query is unchanged, so this costs nothing.
- **Two setup-failure errors gained the mandated docs URL + `doctor` pointer** — the IMAP Keychain-password failure and the server-side mailbox refusal both explained the problem without telling the user where to go next.

### Documentation
- **Reconciled 22 verified claims against the live 50-tool surface.** The valuable class is docs the code disproves: the README documented a `search-contacts` `limit` (default 10) that does not exist and never truncated anything, so a complete result set reads as clipped; it said `get-unread-count` with no `mailbox` returns a cross-mailbox total, which 2.8.15 deliberately changed to INBOX-only because summing double-counted on Gmail; it listed `fetch-attachment` as numeric-id only when the schema accepts `imap:` ids; and **Known Limitations still said "No smart mailboxes" while the same README documents the four smart-mailbox tools shipped in 2.9.0**.
- **`skills/apple-mail/SKILL.md` still told agents `resolve-message-id` is "needed for flag colors"** — the eighth surviving copy of the text 2.10.1 corrected everywhere else, and the most consequential one, since an agent planning from the skill's tool table would resolve `imap:` ids purely to color a flag and reintroduce the AppleScript/TCC dependency 2.10.0 removed. The skill also had no smart-mailbox section at all; one was added (noting `create-newsletter-smart-mailboxes` defaults to `dryRun: true`). Edited at the canonical root `skills/` only, then `pnpm run sync:skills`.
- **Documented what was only true in the code:** `get-message`'s `mailbox`/`account` parameters (the documented cure for large-folder timeouts, previously undiscoverable), `get-mail-stats`'s `account` scope, `flagColorIndex` as the way to *read* a flag color, and the fact that `search-contacts` needs **Node 22.5+** (`node:sqlite`) and Full Disk Access — returning an **empty list rather than an error** without them, so "no contacts found" could mean "cannot read Contacts". Smart-mailbox tools likewise need Full Disk Access and reported every read failure as "no smart mailboxes".
- **Removed obsolete guidance:** `docs/IMAP-SETUP.md` still taught the pre-2.6.0 rule that reads require a matching `account` argument to route to IMAP (since 2.6.0 they prefer IMAP automatically and fan out across configured accounts); the Development block told contributors to run `npm install`, which `package.json`'s own `preinstall` guard hard-fails; `SECURITY.md` described a numeric-only message-id regex superseded by `imap:` ids; and the Antigravity marketplace still advertised the removed Hermes packaging.
- **Corrected the privacy claim in `SECURITY.md` and the README.** Both said no data is sent to external servers. That is false once the opt-in IMAP/SMTP backends are configured — they connect to your provider, which is their purpose. Reframed as no **third** parties: nothing goes to this project or anyone else, everything stays on-device with the default AppleScript backend.

## [2.10.2] - 2026-08-03

### Security
- **Floored `fast-uri` to `^3.1.5` and `ip-address` to `^10.3.1`, clearing four advisories in the shipped bundle.** Both packages are inlined into `build/index.js` (18 and 6 references), so these shipped to every install. `fast-uri` is the instructive one: this file already carried `fast-uri: 3.1.4` as a *security floor*, written as an exact pin — and when GHSA-7p8r-x3mc-p8w7 (high) landed with a 3.1.5 fix, that pin became a **ceiling** holding the tree on the vulnerable release, so the advisory could never clear. Security floors are now written as caret ranges, which let patch fixes flow in while staying inside the major the parent's API expects. `ip-address` had a different failure: `express-rate-limit` → `@modelcontextprotocol/sdk` resolved 10.2.0 while `imapflow` → `socks` already resolved a clean 10.3.1, so the tree carried two copies and bundled the vulnerable one — the floor dedupes them and clears GHSA-mwp4-54f8-5fhr (high), GHSA-4xrf-jv44-h6hh and GHSA-22jq-vg5j-6vgg. `pnpm audit` now reports no high or critical advisories.
- **Deferred:** GHSA-8j4g-w8fx-2239 (`hono`, moderate) is not floored yet. `hono@4.12.34` published 2026-08-03T02:36Z and is still inside this repo's 24-hour `minimumReleaseAge` supply-chain gate, so `^4.12.34` fails the install outright with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. No `minimumReleaseAgeExclude` carve-out was added — the gate is the point. `hono` is reached via `@hono/node-server` and does **not** appear in the esbuild bundle (0 references in `build/index.js`), so nothing vulnerable ships in the meantime; the floor goes in once the release matures.

## [2.10.1] - 2026-08-03

### Fixed
- **Corrected the flag-color documentation and response that still said colors don't work over IMAP.** 2.10.0 made `flag-message` and `batch-flag-messages` write the color over IMAP as Mail.app's `$MailFlagBit0/1/2` keywords, but several places kept describing the old behavior, and one of them was not merely stale text: on the IMAP route `flag-message` returned `colorApplied: false` and the message `the "<color>" color was not applied — this is an IMAP-routed message and IMAP flags are colorless`, while in fact applying it. A caller checking `colorApplied` was told the opposite of what happened. Also corrected: the `color` parameter description, the `batch-flag-messages` tool description, the README's "Flag colors" note and its `batch-flag-messages` parameter row, and two source comments implying `resolve-message-id` is still required for color. This matters beyond tidiness — an agent reading those descriptions would resolve `imap:` ids to numeric ones purely to get a color, reintroducing the AppleScript/TCC dependency that 2.10.0 removed and that previously killed four consecutive scheduled jobs.

## [2.10.0] - 2026-08-03

### Added
- **Flag COLORS now work over IMAP — `resolve-message-id` is no longer needed for them.** Apple Mail stores a flag's color as the custom IMAP keywords `$MailFlagBit0/1/2`, a plain 3-bit field holding the 0–6 palette index. It is not carried by `\Flagged` (which really is colorless), but the bits ride alongside it in an ordinary `UID STORE`, so color is fully readable **and writable** over IMAP. `flag-message` and `batch-flag-messages` now apply the requested color on the IMAP route instead of reporting `colorApplied: false`, and reads expose `flagColorIndex`. Encoding verified against live Mail.app state: green (3) = bit0+bit1, blue (4) = bit2, purple (5) = bit0+bit2.

  This removes the last Mail.app dependency from color-keyed workflows. Previously a smart mailbox keyed on flag color could never match an IMAP-flagged message, so applying a color meant resolving to a numeric id and going through AppleScript — which needs Mail.app running, responsive, and holding a TCC Automation grant, and fails as an opaque 10s timeout when it is not.

### Fixed
- **Unflagging over IMAP now clears the color bits too.** Removing only `\Flagged` left `$MailFlagBitN` set, so a message read as unflagged over IMAP while Mail.app kept rendering it color-flagged until it resynced. Re-flagging in a different color also clears the bits it does not want, so the new color replaces the old index rather than OR-ing into a wrong one.

## [2.9.1] - 2026-07-29

### Changed
- **imapflow 1.4.7 → 1.4.8** (runtime dependency — ships inlined in the committed bundle). Upstream fixes a non-secure connection defaulting to POP3 port 110 instead of IMAP 143, and corrects the connection described in the OAUTHBEARER auth payload. Neither path is reachable from this server's configuration (TLS on 993 with password auth), so IMAP behavior is unchanged; verified against live Gmail and iCloud accounts.
- Dev tooling: `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, and `typescript-eslint` 8.64.0 → 8.65.0. Committed bundle rebuilt.

## [2.9.0] - 2026-07-23

### Added
- **Smart mailbox tools** — `list-smart-mailboxes`, `create-smart-mailbox`, `delete-smart-mailbox`, and `create-newsletter-smart-mailboxes`. Smart mailboxes are Apple Mail's criteria-based virtual views; AppleScript's `smart mailbox` / `intelligentes Postfach` terms don't compile reliably on localized (e.g. German) macOS, so these read and edit `~/Library/Mail/V*/MailData/SyncedSmartMailboxes.plist` directly. `create-newsletter-smart-mailboxes` scans recent INBOX mail for likely newsletter senders (volume plus List-Unsubscribe / noreply / repetitive-subject signals) and, with `dryRun: false`, creates one "NL: …" smart view per sender (defaults to a dry run). Thanks to @maf4711 (#105) for the feature and the German-localization diagnosis.
- **Safe, non-destructive plist writes for the smart-mailbox tools.** Each create/delete backs the plist up to `SyncedSmartMailboxes.plist.bak`, mutates a temp copy with a lossless single-entry edit (`plutil -insert -json` to append, `PlistBuddy Delete` to remove), validates it with `plutil -lint`, then atomically renames it into place — so existing smart mailboxes, including any with `<date>`/`<data>` criteria that `plutil -convert json` cannot represent, are preserved byte-for-byte and the live file is only ever replaced by a validated copy. The tools no longer run `killall Mail`; changes appear the next time Mail is launched.

## [2.8.16] - 2026-07-23

### Fixed
- **IMAP connection leak.** The pool released a dropped connection with only a graceful `logout()`, which can't complete once the server (Gmail) has already half-closed the socket — the FD then lingered in `CLOSE_WAIT` and, over hours of idle-timeout/reconnect churn, accumulated against Gmail's ~15-connections-per-account cap (observed ~10 `ESTABLISHED` + 12 `CLOSE_WAIT` to Gmail per long-lived server instance, the real source of the intermittent "cannot connect" cap pressure). `dropPool` and the per-call connect path now force-close the socket via `ImapFlow.close()` after the logout attempt, so the connection is torn down unconditionally even when the graceful path throws.

## [2.8.15] - 2026-07-23

### Fixed
- `get-unread-count` with no `mailbox` now counts **INBOX** instead of summing UNSEEN across every mailbox. The old sweep was both slow — a STATUS per label on a cold IMAP connection, dozens of serial round-trips that could overrun the MCP client's tool-call timeout — and **wrong on Gmail**, where one unread message simultaneously lives in INBOX, `[Gmail]/All Mail`, and each of its labels and so was counted several times over. Both backends are fixed: IMAP (`imapUnreadCount`) and AppleScript (`getUnreadCount`, which also carried the audit-#8 30s-timeout risk). INBOX is the meaningful "unread messages" figure; pass an explicit `mailbox` for any other scope. Per-account totals (no `account` given) are unaffected in shape — each account still contributes exactly once, now via its INBOX.

## [2.8.14] - 2026-07-22

### Security
- Override the MCP SDK's transitive `@hono/node-server` and `fast-uri` dependencies to patched releases (`@hono/node-server` 2.0.10, `fast-uri` 3.1.4), clearing the Hono static-file path-traversal advisory and the two `fast-uri` host-confusion advisories that the SDK's own ranges still resolve to. Fleet-wide companion to sweetrb/apple-notes-mcp#104 (@oliverames).


## [2.8.13] - 2026-07-21
### Changed
- Dependency bump via Dependabot; committed bundle rebuilt. (automated)

## [2.8.12] - 2026-07-20

### Changed

- CI/release hardening: `version-guard` now treats the committed `build/` bundle as shipped bytes (closing the lockfile-only and devDep silent-never-publish vectors) with an npm version-collision check; `publish.yml` gained a daily self-healing watchdog, manual dispatch, exact-version skip, CI-validated-commit checkout, and GitHub-Release self-heal; Dependabot bundle rebuilds now auto-bump a patch version; CI boots the committed bundle standalone on Node 20 every run; the bundle is now built with `--target=node20`, making the `engines.node >= 20` claim enforced at build time.

## [2.8.11] - 2026-07-18

### Fixed

- **`list-messages` now gets the same Gmail virtual-INBOX redirect as `search-messages`.** A Gmail-style account's literal "INBOX" mailbox is an empty shell — real received mail lives under the "All Mail"/"Important" special mailboxes. `search-messages` already redirected an INBOX-scoped call to that receiving set (BUG A1, 2.8.x), but `list-messages`/`listMessagesWithDiagnostics` bound the empty shell directly, so it silently returned a small, shifting subset of the account's real inbox (backed by Mail.app's own internal `id of msg`, which is not a stable identifier and is reassigned when the local envelope cache resyncs). Callers doing `list-messages` then `batch-move-messages`/`batch-flag-messages` on those ids could act on stale/incorrect message references. `list-messages` now scans the same "All Mail"/"Important" receiving set as `search-messages` for an INBOX-scoped call on a Gmail-style account, so the two report consistent results.

## [2.8.10] - 2026-07-18

### Security

- **Attachment reads and saves now enforce filesystem and size boundaries.** Saved attachments are resolved beneath the requested destination directory, reject traversal and existing symlink targets, and route temporary Base64 extraction through a directory rather than a caller-influenced file path. Inline attachments are capped at 25 MiB decoded, partial temporary materialization is cleaned up on failure, and standards-wrapped Base64 is measured without counting decoder-ignored whitespace.
- **SMTP From overrides are restricted to configured sender identities.** `send-email` email-form `account` values and `apple-mail-send --from` must match the SMTP login user, `APPLE_MAIL_MCP_SMTP_FROM`, or an address in `APPLE_MAIL_MCP_SMTP_ALLOWED_FROM`; rejected identities fail before a transport connection is created.

### Fixed

- **IMAP composite ids cannot be silently routed through a different account.** Single-message, thread, and batch operations now reject a genuinely mismatched account selector while treating a configured account label and its login email as equivalent aliases.
- **Message-ID lookup uses the shared AppleScript string escaper.** RFC Message-ID values are escaped consistently before interpolation into Mail.app queries.

## [2.8.9] - 2026-07-18
### Fixed
- **`get-message` now returns the stable RFC Message-ID on the AppleScript path, not just over IMAP.** A prior change surfaced `rfcMessageId` only in the IMAP branch; the Mail.app/AppleScript path still returned `null`, leaving callers with no stable `<…@…>` identifier for dedup/threading. It now reads Mail.app's native `message id` property (normalized, angle brackets stripped) so both backends return the Message-ID. Thanks to @Goaleve1 (#93).
- **`get-message` now resolves messages in large folders like "Sent Items" instead of timing out.** By-id fetches (`getMessageContent`/`getRawSource`) linear-scanned every mailbox of every account (700+ on a real multi-account setup) probing `whose id is N`; a message in a late-iterated folder was never reached before the AppleScript timeout, returning a false "not found." An `id → {account, mailbox}` index (FIFO-capped at 5000; a stale entry simply falls through to the full scan) recorded from every search/list/by-id result — plus optional `mailbox`+`account` hints on the tool — now opens the one right mailbox directly. Thanks to @Goaleve1 (#93).

## [2.8.8] - 2026-07-17
### Fixed
- **Message bodies no longer lose their line breaks on the AppleScript paths.** The audit-finding-#10 hardening (`escapeForAppleScript`) strips **all** ASCII control characters — including `\n` — before interpolating values into AppleScript string literals. Right for single-line fields (a raw newline would terminate the literal and open an injection window), but it also flattened every multi-paragraph body into one wall of text in `create-draft`, the AppleScript `send-email` fallback, `reply-to-message`, `forward-message`, and the serial-email / `use-template` flows that funnel through them. Bodies now go through a new body-only escaper (`escapeForAppleScriptBody`) that escapes backslashes and quotes in the same order, then converts CRLF / CR / LF to the two-character AppleScript escape sequence `\n` (a linefeed to AppleScript 2.0+) and tab to `\t`, then strips any remaining control characters — so no raw control character ever enters the emitted literal (the injection defense is fully preserved) while paragraph breaks survive. Subjects, addresses, account/mailbox names, paths, search queries, and rule expressions stay on the strict single-line escaper; SMTP transports were never affected.

## [2.8.7] - 2026-07-10

### Changed
- **`search-contacts` now reads the macOS Contacts database directly (Full Disk Access) instead of driving Contacts.app over AppleScript.** The old `tell application "Contacts"` path required an **Automation / Apple-Events** TCC grant for `node` → Contacts; on headless/scheduled hosts missing that grant it raised an **unanswerable permission prompt that hung until timeout**. The new reader (`src/utils/contactsDb.ts`) scans the AddressBook SQLite files — the top-level `~/Library/Application Support/AddressBook/AddressBook-v22.abcddb` plus every `Sources/*/AddressBook-v22.abcddb` — read-only via the built-in **`node:sqlite`**, needs only **Full Disk Access** (a stable grant the Node runtime already holds), and **prompts for nothing**. It matches the query as a case-insensitive substring of full name, organization, nickname, or any email address, returns emails and phone numbers, and de-duplicates across sources. Locked/absent source DBs are skipped rather than failing the search. Requires **Node ≥ 22.5** for `node:sqlite`; on older runtimes it logs one line and returns an empty list (it does **not** fall back to AppleScript, which would reintroduce the prompt). The `search-contacts` tool contract (inputs/outputs) is unchanged.

## [2.8.6] - 2026-07-09
End-user docs/discoverability pass: make setup findable for no-clone installs (npm registry, plugin marketplace) and make "not configured" errors actionable.

### Changed
- **"Not configured" errors now end with the absolute setup-guide URL + a `doctor` hint.** `SMTP transport is not configured…` / `No SMTP password found…` (`smtpMailer`), `IMAP not configured…` (`imapClient`), and the `apple-mail-send` CLI's config-failure hint all now point at `https://github.com/sweetrb/apple-mail-mcp/blob/main/docs/IMAP-SETUP.md` and suggest running the **`doctor`** tool, instead of referencing README sections the user may not have on disk. The URL lives in a shared `src/utils/docsUrls.ts` module also used by `doctor`.
- **"System Preferences" → "System Settings > Privacy & Security > Automation"** in permission-denied messages (`applescript.ts`, `appleMailManager.ts` health check) and in the README/SECURITY/skill docs — matching macOS 13+ naming.

### Fixed
- **README install commands now use the npm registry** (`npm install -g apple-mail-mcp`) instead of `github:sweetrb/apple-mail-mcp`; the GitHub form is kept only as a From-Source note (it builds from source and requires pnpm).
- **npm tarball is self-contained for docs:** `docs/` now ships in the package (`files` in `package.json`), and every README cross-file link (setup guide, CONTRIBUTING, LICENSE, plugin configs, TCC notes, header screenshot) is an absolute `github.com`/`raw.githubusercontent.com` URL, so links work from npmjs.com and a tarball install.
- **Stale Known Limitations rows corrected:** templates *are* persisted (`templates.json` via `APPLE_MAIL_MCP_TEMPLATES_FILE` — row removed); message IDs accept `imap:…` tokens as well as numeric ids; HTML sending exists via the `apple-mail-send` CLI `--html-body-file` (the MCP `send-email` tool itself is plain-text).
- **`docs/IMAP-SETUP.md` corrections:** `APPLE_MAIL_MCP_IMAP_IDLE_MS` default is `30000` (not `60000`); `APPLE_MAIL_MCP_IMAP_ACCOUNTS` is a JSON **array of objects passed as a single string value**; env-var reference gained the missing `APPLE_MAIL_MCP_TEMPLATES_FILE`, `APPLE_MAIL_MCP_MAX_BUFFER`, and `APPLE_MAIL_MAX_SEARCH_MAILBOX` rows.

### Added
- **Deterministic Claude Code install one-liner** in Quick Start: `claude mcp add apple-mail -s user -- npx -y apple-mail-mcp`.
- **Plugin-marketplace config note** (README Quick Start + setup guide Step 3): plugin installs have no editable `env` block — configure IMAP/SMTP via `~/Library/Application Support/apple-mail-mcp/config.json` (Method B).

## [2.8.5] - 2026-07-08
### Fixed
- **IMAP delete now actually trashes Gmail mail — it was a silent no-op before.** `delete-message` and `batch-delete-messages` (over IMAP) flagged `\Deleted` + EXPUNGE on the message's own mailbox. On Gmail, expunging from `[Gmail]/All Mail` (where the read path addresses messages) **does not trash the message** — the tool reported success, but the mail stayed put. Delete now **moves the message to the account's Trash** — the server's `\Trash` special-use mailbox when advertised, else a `Trash`/`Deleted Messages`-style folder, else the `[Gmail]/Trash` default — which is both what Gmail treats as "trash" and what these tools' `Returns: … moves it to Trash` contract already promised. Messages already in Trash are expunged (the "empty from Trash" case). Non-Gmail servers that trash via a real Trash folder now behave correctly too, and `delete` is recoverable everywhere instead of being an immediate expunge. **This also fixes the autonomous mail-hygiene flows** (spam sweep / obsolete-prune) that trash Gmail mail through this path.

## [2.8.4] - 2026-07-08
### Changed
- **`doctor` now points a stuck user (or their AI) at the setup guide.** The two "not configured" messages (IMAP and SMTP) previously listed only the `APPLE_MAIL_MCP_*` env vars to set — which doesn't help the most common failure mode: a **Claude Desktop** user whose `env` block is silently stripped, so the env advice does nothing. Both messages now also name the **`config.json`** file method (`~/Library/Application Support/apple-mail-mcp/config.json`) and link the **[IMAP / SMTP Setup Guide](docs/IMAP-SETUP.md)**, so the fix is discoverable from inside the running server — not only from the repo README.

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
