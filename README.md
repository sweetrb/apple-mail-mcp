# Apple Mail MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that enables AI assistants like Claude to read, send, search, and manage emails in Apple Mail on macOS.

[![npm version](https://img.shields.io/npm/v/apple-mail-mcp)](https://www.npmjs.com/package/apple-mail-mcp)
[![npm downloads](https://img.shields.io/npm/dm/apple-mail-mcp)](https://www.npmjs.com/package/apple-mail-mcp)
[![node](https://img.shields.io/node/v/apple-mail-mcp)](https://www.npmjs.com/package/apple-mail-mcp)
[![CI](https://github.com/sweetrb/apple-mail-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sweetrb/apple-mail-mcp/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/sweetrb/apple-mail-mcp/badge)](https://scorecard.dev/viewer/?uri=github.com/sweetrb/apple-mail-mcp)
[![platform: macOS](https://img.shields.io/badge/platform-macOS-111?logo=apple&logoColor=white)](https://www.apple.com/macos/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP](https://img.shields.io/badge/MCP-server-blue)](https://modelcontextprotocol.io)

<p align="center">
  <img src="https://raw.githubusercontent.com/sweetrb/apple-mail-mcp/main/codex/assets/screenshot.png" alt="Apple Mail MCP — read, search, send, and organize Apple Mail from Codex, Claude, and other AI assistants" width="680">
</p>

> **Note:** This is the **npm/Node.js** package — install with `npx` or `npm`. There is an unrelated Python project of the same name on PyPI ([`imdinu/apple-mail-mcp`](https://github.com/imdinu/apple-mail-mcp)) installed via `pipx`/`uvx`. If you're using `uvx` and seeing a `cyclopts` dependency error, you're looking for that project, not this one.

## What is This?

This server acts as a bridge between AI assistants and Apple Mail. Once configured, you can ask Claude (or any MCP-compatible AI) to:

- "Check my inbox for unread messages"
- "Find emails from john@example.com"
- "Send an email to the team about the meeting"
- "Create a draft email for me to review"
- "Reply to that message"
- "Forward this to my colleague"
- "Move old newsletters to the Archive folder"

The AI assistant communicates with this server, which then uses AppleScript to interact with the Mail app on your Mac. All data stays local on your machine.

## Quick Start

### Using Claude Code (Easiest)

If you're using [Claude Code](https://claude.com/product/claude-code) (in Terminal or VS Code), just ask Claude to install it:

```
Install the sweetrb/apple-mail-mcp MCP server so you can help me manage my Apple Mail
```

Claude will handle the installation and configuration automatically.

Or register it deterministically in one command:

```bash
claude mcp add apple-mail -s user -- npx -y apple-mail-mcp
```

### Using the Plugin Marketplace

Install as a Claude Code plugin for automatic configuration and enhanced AI behavior:

```bash
/plugin marketplace add sweetrb/apple-mail-mcp
/plugin install apple-mail
```

This method also installs a **skill** that teaches Claude when and how to use Apple Mail effectively.

> **Configuring IMAP/SMTP for a plugin install:** a plugin install has no editable `env` block,
> so supply settings via the config file at `~/Library/Application Support/apple-mail-mcp/config.json`
> — Method B in the [IMAP / SMTP Setup Guide](https://github.com/sweetrb/apple-mail-mcp/blob/main/docs/IMAP-SETUP.md).
> Passwords stay in the macOS Keychain; run the `doctor` tool to verify.

### Using the Codex Marketplace

Install the same public marketplace in Codex:

```bash
codex plugin marketplace add sweetrb/apple-mail-mcp
codex plugin add apple-mail@apple-mail-mcp
```

The Codex package registers the same `apple-mail` MCP server through `npx -y apple-mail-mcp` and includes the Apple Mail skill guidance.

### Other Hosts (Hermes, Antigravity)

Two more hosts can run the same `apple-mail` MCP server (`npx -y apple-mail-mcp`):

- **[Hermes Agent](https://hermes-agent.nousresearch.com/)** (NousResearch) — Hermes has no plugin/marketplace drop-in, so there is nothing in this repo to install from. Register the server with the CLI:

  ```bash
  hermes mcp add apple-mail --command npx --args -y apple-mail-mcp
  ```

  Or add it to `~/.hermes/config.yaml` by hand:

  ```yaml
  mcp_servers:
    apple-mail:
      command: npx
      args: ["-y", "apple-mail-mcp"]
  ```

  Restart your Hermes session afterward so the tools load.
- **[Antigravity](https://antigravity.google/)** (Google) — add the server entry from [`.antigravity-plugin/mcp_config.json`](https://github.com/sweetrb/apple-mail-mcp/blob/main/.antigravity-plugin/mcp_config.json) to `~/.gemini/config/mcp_config.json` (or via Antigravity's MCP settings).

### Manual Installation

**1. Install the server:**
```bash
npm install -g apple-mail-mcp
```

**2. Add to Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "apple-mail": {
      "command": "npx",
      "args": ["apple-mail-mcp"]
    }
  }
}
```

**3. Restart Claude Desktop** and start using natural language:
```
"Show me my unread emails"
```

On first use, macOS will ask for permission to automate Mail.app. Click "OK" to allow.

## Configuring email (IMAP & SMTP)

The server works out of the box over AppleScript with **no configuration**. Two
**opt-in** power features take a one-time setup:

- **Fast IMAP reads** — server-side search, counts, and large-mailbox handling
  that AppleScript is too slow for (it times out on big Gmail mailboxes).
- **Clean SMTP sending** — `send-email` submits clean MIME directly, avoiding the
  macOS 15+ Mail.app `<blockquote>` wrapping that otherwise makes sent mail look
  quoted/indented like a reply.

Both are driven by non-secret `APPLE_MAIL_MCP_*` settings — supplied via an `env`
block **or** a `config.json` file (for hosts like Claude Desktop that strip `env`)
— with passwords kept in the macOS **Keychain**, never in config.

👉 **[IMAP / SMTP Setup Guide](https://github.com/sweetrb/apple-mail-mcp/blob/main/docs/IMAP-SETUP.md)** — step-by-step: app passwords,
Keychain, both config methods, multi-account, SMTP, verification with the `doctor`
tool, and troubleshooting. Verify any time by running the **`doctor`** tool.

## Requirements

- **macOS** - Apple Mail and AppleScript are macOS-only
- **Node.js 20+** - Required for the MCP server
- **Node.js 22.5+ and Full Disk Access** - Required by `search-contacts` only. It reads the Contacts database directly through Node's built-in `node:sqlite`, which does not exist before 22.5. On an older runtime, or without Full Disk Access for the Node binary, it logs one line to stderr and returns **an empty list rather than an error** — so "no contacts found" can mean "cannot read Contacts". Every other tool works on Node 20+. See [Node runtime & TCC permissions](https://github.com/sweetrb/apple-mail-mcp/blob/main/docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md).
- **Apple Mail** - Must have at least one account configured (iCloud, Gmail, Exchange, etc.)

## Features

### Messages

| Feature | Description |
|---------|-------------|
| **List Messages** | List messages with pagination, sender filter, date display |
| **Search Messages** | Search by sender, subject, content, date range, read/flagged status — across all accounts |
| **Read Messages** | Get full email content (plain text or HTML) |
| **Send Email** | Compose and send new emails (attach by file path or inline base64 content) |
| **Send Serial Email** | Mail merge — send personalized emails to a list of recipients with {{placeholder}} support |
| **Create Draft** | Save emails to Drafts folder (attach by file path or inline base64 content) |
| **Reply** | Reply to messages (with reply-all support) |
| **Forward** | Forward messages to new recipients |
| **Get Thread** | Group a conversation by normalized subject (across AppleScript or IMAP) |
| **Mark Read/Unread** | Change read status (single or batch) |
| **Flag/Unflag** | Flag or unflag messages (single or batch) |
| **Delete Messages** | Move messages to trash (single or batch) |
| **Move Messages** | Organize into mailboxes (single or batch) |
| **List Attachments** | View attachment metadata (name, type, size) |
| **Save Attachment** | Save attachments to disk |
| **Fetch Attachment** | Get an attachment's bytes as base64 (no disk write) |

Read/list/get tools also return **structured JSON** (`structuredContent`) alongside the text, so agents can consume results without parsing prose.

### Mailbox & Account Management

| Feature | Description |
|---------|-------------|
| **List Mailboxes** | Show all folders with message/unread counts |
| **Create/Delete/Rename Mailbox** | Full mailbox lifecycle management |
| **List Accounts** | Show configured accounts |
| **Unread Count** | Get unread counts per mailbox |

### Rules, Contacts & Templates

| Feature | Description |
|---------|-------------|
| **List Rules** | View all mail rules and their enabled status |
| **Enable/Disable Rules** | Toggle mail rules on or off |
| **Create/Delete Rules** | Create rules with conditions + actions, or delete by name |
| **Search Contacts** | Look up contacts from Contacts.app by name |
| **Email Templates** | Save, list, use, and delete reusable email templates (persisted to disk across restarts) |

### Diagnostics

| Feature | Description |
|---------|-------------|
| **Health Check** | Verify Mail.app connectivity |
| **Doctor** | Diagnose Mail permission, account state, and each IMAP/SMTP backend with actionable messages |
| **Statistics** | Message and unread counts per account, recently received stats |
| **Sync Status** | Check if Mail.app is actively syncing |
| **Effect reconciliation** | Every delete/move reports what it actually did to the mailbox (`countDelta`), and warns when more messages left than were operated on — see [Auditing destructive operations](#auditing-destructive-operations) |

### MCP resources & prompts

Resources expose read-only context the client can attach without a tool call:
`mail://accounts`, `mail://templates`, and `mail://mailboxes/{account}`. Prompts
package common workflows: `triage-inbox`, `compose-reply`, `weekly-summary`.

---

## Tool Reference

This section documents all available tools. AI agents should use these tool names and parameters exactly as specified.

### Message Operations

#### `search-messages`

Search for messages matching criteria. Searches all accounts by default.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | No | Text to search in subject/sender |
| `from` | string | No | Filter by sender email address |
| `subject` | string | No | Filter by subject line |
| `mailbox` | string | No | Mailbox to search in (omit to search all mailboxes) |
| `account` | string | No | Account to search in (omit to search all accounts) |
| `isRead` | boolean | No | Filter by read status |
| `isFlagged` | boolean | No | Filter by flagged status |
| `dateFrom` | string | No | Start date filter (e.g., "January 1, 2026") |
| `dateTo` | string | No | End date filter (e.g., "March 1, 2026") |
| `limit` | number | No | Max results, 1–500 (default: 50) |

**Large mailboxes & partial results.** Apple Mail's AppleScript bridge cannot
search very large IMAP/Gmail mailboxes (tens of thousands of messages) before
the Apple Event times out — empirically even reading the newest 20 messages of
a 44k-message mailbox takes ~45s. To avoid burning minutes only to return a
misleading empty result, an unscoped (all-mailboxes) search **skips** mailboxes
whose message count exceeds a threshold (default **5000**), enforces a
per-account time budget, and **reports** anything it skipped or that timed out
rather than silently returning nothing. When coverage is incomplete the result
includes an explicit warning, e.g.:

```
⚠️  Partial results — this is NOT a confirmed "no such mail":
  - skipped mailbox(es) too large to search via AppleScript: Gmail / All Mail (44287) — scope the search with `mailbox` + a `dateFrom`/`dateTo` window to target them
```

To search inside a large mailbox, scope the call with `mailbox` (and ideally a
`dateFrom`/`dateTo` window). Tune or disable the skip threshold with the
`APPLE_MAIL_MAX_SEARCH_MAILBOX` environment variable (default `5000`; set to `0`
to disable the guard and attempt every mailbox regardless of size).
([#24](https://github.com/sweetrb/apple-mail-mcp/issues/24))

---

#### `get-message`

Get the full content of a message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID |
| `preferHtml` | boolean | No | Return HTML source instead of plain text |
| `mailbox` | string | No | Mailbox holding the message (e.g. `"Sent Items"`). With `account`, opens that mailbox directly instead of scanning every mailbox — this is the fix for timeouts on large folders |
| `account` | string | No | Account holding the message. Pair with `mailbox` to skip the cross-mailbox scan |

**Returns:** Subject line and message body (plain text by default, HTML if `preferHtml` is true and HTML content is available).

> **Large messages / attachments:** reading a full message routes through
> `osascript`, whose captured output buffer defaults to **64 MB**. Override it
> with the `APPLE_MAIL_MCP_MAX_BUFFER` environment variable (in **bytes**) if you
> work with messages whose raw MIME (e.g. a large embedded attachment) exceeds
> that — a value below the message size makes the read fail with a buffer-overflow
> error rather than truncating ([#27](https://github.com/sweetrb/apple-mail-mcp/issues/27)).

---

#### `list-messages`

List messages in a mailbox.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mailbox` | string | No | Mailbox name (omit to list from all mailboxes) |
| `account` | string | No | Account name |
| `limit` | number | No | Max messages, 1–500 (default: 50) |
| `offset` | number | No | Number of messages to skip, ≥ 0 (for pagination) |
| `from` | string | No | Filter by sender email address or name |
| `unreadOnly` | boolean | No | Only show unread messages |

**Returns:** List of messages with ID, date, subject, and sender.

---

#### `send-email`

Send a new email immediately.

**⚠️ Safety:** Sends real mail immediately and cannot be unsent. Confirm the recipients, subject, and body with the user before calling.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string[] | Yes | Recipient addresses |
| `subject` | string | Yes | Email subject |
| `body` | string | Yes | Email body (plain text) |
| `cc` | string[] | No | CC recipients |
| `bcc` | string[] | No | BCC recipients |
| `account` | string | No | Mail.app account label, or an email-form SMTP From override. An SMTP override must match `APPLE_MAIL_MCP_SMTP_USER`, `APPLE_MAIL_MCP_SMTP_FROM`, or an address in `APPLE_MAIL_MCP_SMTP_ALLOWED_FROM` |
| `attachments` | (string \| {filename, contentBase64})[] | No | Up to 20 attachments: absolute file paths (e.g., `"/Users/me/report.pdf"`) and/or inline `{filename, contentBase64}` objects up to 25 MiB decoded each |
| `transport` | `"applescript"` \| `"smtp"` | No | Send transport. If omitted, **SMTP is used automatically when configured** (otherwise AppleScript). Pass `"smtp"` to require clean MIME, or `"applescript"` to force the Mail.app path — see [SMTP transport](#smtp-transport) |

**Example:**
```json
{
  "to": ["colleague@company.com"],
  "subject": "Meeting Tomorrow",
  "body": "Hi, just confirming our meeting at 2pm tomorrow.",
  "account": "Work",
  "attachments": ["/Users/me/Documents/agenda.pdf"]
}
```

##### SMTP transport

On macOS 15+ (Sequoia/Tahoe), Mail.app wraps any AppleScript-injected body in
`<blockquote type="cite">` under the `Apple-Mail-URLShareWrapperClass` template,
so emails sent through the default `applescript` transport render to recipients
as if they were quoted/forwarded (Apple radar **FB11734014**, open since
Ventura). The SMTP transport bypasses Mail.app entirely and submits clean MIME
directly. **Once SMTP is configured, `send-email` uses it automatically** (no
need to pass `transport` per call); pass `transport: "applescript"` to force the
Mail.app path.

Two differences to know when SMTP is auto-preferred:

- **No Sent-folder copy.** SMTP submission does not file the message in Mail.app's
  Sent mailbox (the server's own "save to Sent" may, depending on provider). Use
  `transport: "applescript"` if you need the local Sent copy.
- **`account` is a From override, not account selection.** Over SMTP, `account`
  is used as the From address only when it is an email address; a Mail.app
  account *label* (e.g. `"Work"`) can't select an account over SMTP, so a call
  that passes one is left on the AppleScript path automatically. To force
  account selection, pass `transport: "applescript"` explicitly. For sender
  safety, an email-form override must match the SMTP login user, the configured
  `APPLE_MAIL_MCP_SMTP_FROM`, or an address listed in the comma-separated
  `APPLE_MAIL_MCP_SMTP_ALLOWED_FROM`; any other From address is rejected before
  connecting.

Both plain-text and HTML bodies are supported — over SMTP an HTML body (CLI
`--html-body-file`) is sent as `multipart/alternative` with the plain-text
fallback.

Configure SMTP via environment variables on the MCP server. The password is
read from the macOS **Keychain** by default, so no secret goes in config:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `APPLE_MAIL_MCP_SMTP_HOST` | Yes | — | SMTP server hostname (e.g. `smtp.fastmail.com`) |
| `APPLE_MAIL_MCP_SMTP_USER` | Yes | — | SMTP username |
| `APPLE_MAIL_MCP_SMTP_PORT` | No | `465` if secure, else `587` | SMTP port |
| `APPLE_MAIL_MCP_SMTP_SECURE` | No | `false` | `true` for implicit TLS (port 465); otherwise STARTTLS |
| `APPLE_MAIL_MCP_SMTP_FROM` | No | = user | From address |
| `APPLE_MAIL_MCP_SMTP_ALLOWED_FROM` | No | — | Comma-separated sender aliases permitted as per-message From overrides |
| `APPLE_MAIL_MCP_SMTP_PASSWORD` | No | — | Password (if set, used instead of the Keychain) |
| `APPLE_MAIL_MCP_SMTP_KEYCHAIN_SERVICE` | No | = host | Keychain item service/server name |
| `APPLE_MAIL_MCP_SMTP_KEYCHAIN_ACCOUNT` | No | = user | Keychain item account |

Store the password in the Keychain once (an app-specific password for Gmail/
iCloud). A generic-password item with an explicit service name keeps it from
colliding with the system mail account password, and matches
`APPLE_MAIL_MCP_SMTP_KEYCHAIN_SERVICE`:

```bash
# Fastmail (Keychain service defaults to the host)
security add-internet-password -s smtp.fastmail.com -a you@example.com -w

# Gmail / Google Workspace, using a dedicated Keychain service name:
#   APPLE_MAIL_MCP_SMTP_HOST=smtp.gmail.com
#   APPLE_MAIL_MCP_SMTP_USER=you@gmail.com
#   APPLE_MAIL_MCP_SMTP_KEYCHAIN_SERVICE=apple-mail-mcp-smtp
security add-generic-password -s apple-mail-mcp-smtp -a you@gmail.com -w
```

Once the env vars are set, a plain `send-email` (no `transport`) already goes
out clean:
```json
{
  "to": ["colleague@company.com"],
  "subject": "Standings",
  "body": "Plain body — no blockquote wrapping."
}
```

###### `apple-mail-send` CLI (no MCP server required)

The package also installs an `apple-mail-send` binary — a standalone CLI over the
same SMTP path, for cron jobs, scheduled tasks, and scripts that can't run an MCP
session. It reads the identical `APPLE_MAIL_MCP_SMTP_*` env + Keychain config:

```bash
apple-mail-send \
  --from you@example.com --to colleague@company.com \
  --subject "Standings" --body-file /tmp/body.txt \
  [--html-body-file /tmp/body.html] [--attach /tmp/report.pdf]
```

Repeatable `--to`/`--cc`/`--bcc`/`--attach`; an `--html-body-file` is sent as a
`multipart/alternative` alongside the plain `--body-file`. Exit codes follow
`sysexits.h`: `0` success, `64` usage error, `66` unreadable body file, `78`
SMTP not configured.

##### IMAP backend — opt-in

> 📘 **For step-by-step setup (app passwords, Keychain, config methods, multi-account, upgrading, troubleshooting), see the [IMAP / SMTP Setup Guide](https://github.com/sweetrb/apple-mail-mcp/blob/main/docs/IMAP-SETUP.md).** The summary below is the reference; the guide is the walkthrough.

AppleScript runs `search`/`list` predicates client-side over the Apple Event
bridge, which is slow and can time out (false-empty) on large Gmail/IMAP
mailboxes (see [#24](https://github.com/sweetrb/apple-mail-mcp/issues/24)), and
its `delete`/`rename mailbox` and draft handlers don't work on server-side
accounts at all (#42). When an account is configured for IMAP, the MCP routes to
a server-side IMAP backend ([#43](https://github.com/sweetrb/apple-mail-mcp/issues/43))
that is fast and correct on exactly those mailboxes. This is **opt-in and
additive**: any account without IMAP configured behaves exactly as before
(AppleScript).

What routes to IMAP when an account is IMAP-configured:

- **Read:** `search-messages`, `list-messages` (server-side `SEARCH`, typically sub-second), and `get-message`.
- **Folder ops:** `create-mailbox`, `rename-mailbox`, `delete-mailbox` — IMAP's `CREATE`/`RENAME`/`DELETE` succeed on the iCloud/Gmail/Workspace/Exchange mailboxes Mail.app's AppleScript bridge can't touch (#42).
- **Message mutations:** `mark-as-read`/`unread`, `flag-message`/`unflag-message`, `move-message`, `delete-message`.
- **Batch mutations (2.1):** `batch-mark-as-read`/`unread`, `batch-flag`/`unflag-messages`, `batch-move-messages`, `batch-delete-messages` — `imap:` ids are grouped by mailbox and applied as a single `UID STORE`/`UID MOVE`; numeric ids in the same batch still use AppleScript.
- **Counts & stats (2.1):** `get-unread-count` and `list-mailboxes` use `STATUS`; `get-mail-stats` uses `STATUS` + `SEARCH SINCE` — authoritative and fast even on huge mailboxes. As of v2.6.0 these prefer IMAP whenever it's configured (see *Read routing* below), merging across accounts when no `account` is given.
- **Attachments (2.1):** `list-attachments`, `save-attachment`, `fetch-attachment` use `BODYSTRUCTURE` + `FETCH BODY[part]` for `imap:` ids — faster and able to see MIME-embedded attachments AppleScript misses.
- **Threading (2.1):** `get-thread` links a conversation via `References`/`Message-ID` (`HEADER SEARCH`) for an `imap:` seed, falling back to subject grouping otherwise.

**Message ids are backend-tagged.** The IMAP read path emits self-describing ids
of the form `imap:<token>` (the token encodes the account, mailbox path, and
UID). Pass that id back to `get-message`, a message mutation, a batch op, or the
attachment/thread tools and it routes to IMAP automatically; bare numeric ids
continue to use AppleScript. So an agent never has to know which backend a
message came from — the id carries it.

**Read routing (v2.6.0): reads PREFER direct IMAP whenever IMAP is configured.**
The read tools — `search-messages`, `get-thread`, `list-messages`,
`list-mailboxes`, `get-unread-count`, `get-mail-stats` — now go to IMAP whenever
any `APPLE_MAIL_MCP_IMAP_*` account is configured, not just when an explicit
matching `account` is passed. There are three cases:

- **Explicit IMAP account** — single-account IMAP (fast server-side path).
- **Explicit non-IMAP account** — AppleScript (that account isn't on IMAP).
- **No `account` given** — **merge across all accounts**: the query fans out over
  *every* configured IMAP account, **and** AppleScript runs **only for the
  accounts no IMAP config covers** (the account list is partitioned — accounts
  already served by IMAP are *not* re-scanned via AppleScript). If every Mail
  account is IMAP-configured, AppleScript is skipped entirely. The results are
  merged so no account is dropped. Message lists still de-duplicate as a safety
  net (preferring the IMAP copy, which carries the round-trippable `imap:` id) and
  sort newest-first; count tools (`get-unread-count`, `get-mail-stats`) count each
  account via exactly one backend so a coverage mismatch can never double- (or
  under-) count.
  - **Default mailbox is resolved per account.** When you don't pin a `mailbox`, a
    fan-out search scopes each account to its own default — Gmail/Workspace to
    `[Gmail]/All Mail`, every other IMAP host (iCloud, etc.) to `INBOX` (since
    `[Gmail]/All Mail` is Gmail-only and selecting it elsewhere would silently drop
    that account). Pin a `mailbox` to search a wider scope on non-Gmail accounts.

If IMAP is **not** configured at all, every read behaves exactly as before
(pure AppleScript). The three mailbox-**write** ops (`create-mailbox`,
`delete-mailbox`, `rename-mailbox`) remain conservative — they route to IMAP only
for an explicitly-named IMAP account, never on an omitted account.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `APPLE_MAIL_MCP_IMAP_USER` | Yes | — | Login address; setting it enables IMAP |
| `APPLE_MAIL_MCP_IMAP_ACCOUNT` | No | = user | Mail account name to match for routing |
| `APPLE_MAIL_MCP_IMAP_HOST` | No | `imap.gmail.com` | IMAP server hostname |
| `APPLE_MAIL_MCP_IMAP_PORT` | No | `993` | IMAP port (993 = implicit TLS) |
| `APPLE_MAIL_MCP_IMAP_PASSWORD` | No | — | Password (if set, used instead of the Keychain) |
| `APPLE_MAIL_MCP_IMAP_KEYCHAIN_SERVICE` | No | — | Keychain item service/server name |
| `APPLE_MAIL_MCP_IMAP_KEYCHAIN_ACCOUNT` | No | = user | Keychain item account |
| `APPLE_MAIL_MCP_IMAP_ACCOUNTS` | No | — | JSON array of **additional** IMAP accounts for multi-account setups (see below) |
| `APPLE_MAIL_MCP_IMAP_IDLE` | No | `0` | Set `1` to enable IMAP IDLE push notifications (new-mail alerts) for every configured account |
| `APPLE_MAIL_MCP_IMAP_IDLE_MS` | No | `30000` | Idle timeout (ms) before a pooled IMAP connection is closed (`0` = never close) |
| `APPLE_MAIL_MCP_STATS_BUDGET_MS` | No | `25000` | Per-account wall-clock budget for `get-mail-stats` (minimum `1000`). Raise it for very large accounts |
| `APPLE_MAIL_MCP_STATS_DEADLINE_MS` | No | `50000` | Overall wall-clock deadline for one `get-mail-stats` call (minimum `2000`), measured from when the request arrived and covering time queued behind other tool calls, account enumeration **and** every per-account read. Keep it below your client's request timeout |

**Multiple IMAP accounts (C2):** set `APPLE_MAIL_MCP_IMAP_ACCOUNTS` to a JSON array, e.g.
`[{"account":"Work","user":"me@co.com","host":"imap.co.com","keychainService":"imap.co.com"}]`.
Each entry accepts `account`, `user`, `host`, `port`, `password`, `keychainService`,
`keychainAccount`. Calls route to the account matching their `account` argument (or the
decoded `imap:` id), and each account keeps its own pooled connection.

As with SMTP, the password is read from the macOS **Keychain** by default (use
an app-specific password for Gmail/Workspace/iCloud), so no secret goes in
config. Gmail label semantics: common names (`All Mail`, `Sent`, `Trash`,
`Spam`, `Important`, …) map to their `[Gmail]/…` IMAP paths automatically.

> Note: IMAP connections are pooled — one kept-alive connection per account is
> reused across calls (verified with a NOOP, closed after `APPLE_MAIL_MCP_IMAP_IDLE_MS`
> of inactivity), so there's no per-call connection overhead ([#50](https://github.com/sweetrb/apple-mail-mcp/issues/50)).
>
> **iCloud:** set `APPLE_MAIL_MCP_IMAP_HOST=imap.mail.me.com`, `APPLE_MAIL_MCP_IMAP_USER`
> to your iCloud address, `APPLE_MAIL_MCP_IMAP_ACCOUNT` to the Mail account name
> (e.g. `iCloud`), and use an **app-specific password** (from appleid.apple.com)
> stored in the Keychain.

##### Connection footprint (playing nice with Gmail)

IMAP connections are a shared, capped resource: **Gmail allows at most 15
simultaneous IMAP connections per account**, and Apple Mail itself needs some of
those slots. This server keeps its footprint small:

- **One pooled connection per account**, reused across calls and **closed after
  ~30s idle** (tune with `APPLE_MAIL_MCP_IMAP_IDLE_MS`; `0` = never close). So a
  server that isn't actively serving IMAP calls holds **zero** connections.
- **IMAP IDLE is opt-in** (`APPLE_MAIL_MCP_IMAP_IDLE=1`). When on, it adds **one
  persistent connection per account** (a long-lived watcher), on top of the
  pooled request connection — leave it off if you don't need push notifications.
- **Connections are dropped on shutdown** — SIGINT/SIGTERM and stdin-EOF (the
  MCP client/parent going away). As of **v2.6.1** the server also **self-exits if
  it becomes orphaned** (parent force-quit/crashed → reparented to launchd),
  polling every 30s, so it can't linger holding sockets after its session is gone.

The catch is **multiple concurrent instances**. A host like the Claude desktop
app spawns a *separate* set of MCP servers per open conversation (and respawns
them after a crash), so the footprint is **per instance × accounts**. With IDLE
off, an idle instance trends to 0 connections; with many *active* conversations
or IDLE on, the per-account total climbs toward Gmail's 15-connection cap and can
starve Apple Mail of slots (→ intermittent "cannot connect"). If you hit that,
close idle Claude conversations, keep `APPLE_MAIL_MCP_IMAP_IDLE` off unless you
need push, and/or lower `APPLE_MAIL_MCP_IMAP_IDLE_MS`.

##### Configuration file (when the host strips `env`)

Some host apps (e.g. Claude Desktop) launch the MCP server with a scrubbed
environment and ignore the `env` block in their server config, so there's no way
to pass `APPLE_MAIL_MCP_*` settings through it. In that case, put them in a JSON
file the host doesn't manage — `APPLE_MAIL_MCP_CONFIG_FILE`, or by default
`~/Library/Application Support/apple-mail-mcp/config.json`:

```json
{
  "APPLE_MAIL_MCP_IMAP_USER": "you@gmail.com",
  "APPLE_MAIL_MCP_IMAP_HOST": "imap.gmail.com",
  "APPLE_MAIL_MCP_IMAP_KEYCHAIN_SERVICE": "imap.gmail.com",
  "APPLE_MAIL_MCP_IMAP_KEYCHAIN_ACCOUNT": "you@gmail.com",
  "APPLE_MAIL_MCP_IMAP_IDLE": "1"
}
```

The server reads it at startup and merges values into the environment **without
overriding** anything already set there (so an explicit `env` still wins). Store
only non-secret config here — **passwords belong in the Keychain**, never in this
file.

##### Push notifications (IMAP IDLE) — opt-in

When `APPLE_MAIL_MCP_IMAP_IDLE=1`, the server opens a dedicated, long-lived
connection to **each configured IMAP account** and watches its INBOX for new
mail. On arrival it pushes two MCP notifications to the client (no polling by the
client required):

1. **`notifications/message`** (logging) — a human-readable line, e.g.
   `New mail in "Work": 2 new message(s) (INBOX now 1843).`
2. **`notifications/resources/updated`** — for the affected account's resource
   `mail://mailboxes/{account}`, so a client subscribed to that resource knows to
   re-read it.

This requires an IMAP account to be configured (single-account env or
`APPLE_MAIL_MCP_IMAP_ACCOUNTS`); accounts that only use AppleScript aren't
watched. Detection is **real-time** via the IMAP IDLE `EXISTS` event where the
server pushes it, with an automatic **polling fallback** for servers that don't.
Dropped connections reconnect with backoff, and the watchers shut down cleanly on
`SIGINT`/`SIGTERM`.

Enable it in your MCP client config alongside the IMAP settings:

```json
{
  "mcpServers": {
    "apple-mail": {
      "command": "node",
      "args": ["/path/to/apple-mail-mcp/build/index.js"],
      "env": {
        "APPLE_MAIL_MCP_IMAP_USER": "you@gmail.com",
        "APPLE_MAIL_MCP_IMAP_KEYCHAIN_SERVICE": "imap.gmail.com",
        "APPLE_MAIL_MCP_IMAP_IDLE": "1"
      }
    }
  }
}
```

> Note: this is most useful with clients that surface MCP logging messages or
> subscribe to resource-update notifications. Clients that ignore notifications
> are unaffected — the feature is opt-in and adds no behavior unless enabled.

---

#### `send-serial-email`

Send individual personalized emails to a list of recipients (mail merge). Each recipient receives their own email — recipients don't see each other. Supports `{{placeholder}}` tokens in both subject and body.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `recipients` | object[] | Yes | List of recipients, max 100 (see below) |
| `subject` | string | Yes | Email subject — use `{{Key}}` for placeholders |
| `body` | string | Yes | Email body — use `{{Key}}` for placeholders |
| `account` | string | No | Send from specific account |
| `delayMs` | number | No | Delay between sends in ms (default: 500, max 10000) |

Each recipient object:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | Yes | Recipient email address |
| `variables` | object | Yes | Key-value pairs for placeholder replacement |

**Example:**
```json
{
  "recipients": [
    { "email": "alice@example.com", "variables": { "Name": "Alice", "Company": "Acme" } },
    { "email": "bob@example.com", "variables": { "Name": "Bob", "Company": "Globex" } }
  ],
  "subject": "Hello {{Name}}!",
  "body": "Dear {{Name}},\n\nGreat to connect about {{Company}}.\n\nBest regards"
}
```

**Returns:** Per-recipient success/failure results with a summary count.

**⚠️ Safety:** Sends real mail immediately to every recipient and cannot be unsent. Confirm the recipient list, subject, and body with the user before calling.

---

#### `create-draft`

Save an email to Drafts without sending.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string[] | Yes | Recipient addresses |
| `subject` | string | Yes | Email subject |
| `body` | string | Yes | Email body (plain text) |
| `cc` | string[] | No | CC recipients |
| `bcc` | string[] | No | BCC recipients |
| `account` | string | No | Account for draft |
| `attachments` | (string \| {filename, contentBase64})[] | No | Up to 20 attachments: absolute file paths and/or inline `{filename, contentBase64}` objects up to 25 MiB decoded each |

**Returns:** Confirmation that draft was created.

#### `get-thread`

Group a conversation by normalized subject (across the AppleScript or IMAP backend).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | A message ID in the conversation (numeric or `imap:…`) |
| `account` | string | No | Account to search (omit to search all) |
| `mailbox` | string | No | Mailbox to search (omit to search all) |
| `limit` | number | No | Max messages in the thread (default 50) |

**Returns:** The conversation's messages, oldest-first.

#### `fetch-attachment`

Return an attachment's bytes as base64 (the read counterpart to inline-base64 send).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID (numeric or `imap:…`) |
| `attachmentName` | string | Yes | Attachment filename (from `list-attachments`) |

**Returns:** The attachment bytes, base64-encoded (also in `structuredContent.contentBase64`).

---

#### `resolve-message-id`

Map `imap:` message IDs to their numeric Mail.app IDs, via each message's RFC 5322 `Message-ID` (the join key both backends share). Needed only for the two tools that are numeric-ID-only — `reply-to-message` and `forward-message`. Numeric IDs pass through unchanged.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string[] | Yes | 1–100 message IDs, each numeric or `imap:…` |

**Returns:** For each input ID, its `numericId` (or `null` when it can't be resolved) and the `messageId` used, plus `count` and `resolvedCount`. The lookup scopes to the message's account and checks its INBOX first, to avoid scanning a large All Mail/Archive mailbox.

> **You do not need this for flag colors (v2.10.0+).** Colors used to require the numeric-ID path, and older docs and tool descriptions said so. `flag-message` and `batch-flag-messages` now write the color over IMAP directly, as Mail.app's `$MailFlagBit0/1/2` keywords, so a smart mailbox keyed on flag color matches an IMAP-flagged message. Resolving IDs just to apply a color reintroduces the AppleScript/TCC dependency 2.10.0 removed. Flag, move, mark, and delete all accept `imap:` IDs as-is.

---

#### `reply-to-message`

Reply to an existing message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID to reply to |
| `body` | string | Yes | Reply body |
| `replyAll` | boolean | No | Reply to all recipients (default: false) |
| `send` | boolean | No | Send immediately (default: true, false = save as draft) |

**Example - Reply to sender only:**
```json
{
  "id": "12345",
  "body": "Thanks for the update!"
}
```

**Example - Reply all, save as draft:**
```json
{
  "id": "12345",
  "body": "I'll review this and get back to everyone.",
  "replyAll": true,
  "send": false
}
```

> **Transport (v2.5.0):** when SMTP is configured, `reply-to-message` sends via **clean SMTP**, threading the reply with proper RFC 5322 `In-Reply-To`/`References` headers (built from the original message) so it lands in the same conversation. When SMTP is not configured (or the original lacks the headers needed to thread), it falls back to Mail.app's AppleScript `reply … without opening window` — same reliable-from-background-process path as before. See [SMTP transport](#smtp-transport).

**⚠️ Safety:** With the default `send: true`, sends real mail immediately and cannot be unsent. Confirm the recipients, subject, and body with the user before calling (or pass `send: false` to save a draft for review).

---

#### `forward-message`

Forward a message to new recipients.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID to forward |
| `to` | string[] | Yes | Recipients to forward to |
| `body` | string | No | Message to prepend |
| `send` | boolean | No | Send immediately (default: true, false = save as draft) |

> **Transport (v2.5.0):** when SMTP is configured, `forward-message` sends via **clean SMTP** (a fresh message with the original quoted, no threading headers — a forward starts a new conversation). When SMTP is not configured it falls back to Mail.app's AppleScript `forward … without opening window`. See [SMTP transport](#smtp-transport).

**⚠️ Safety:** With the default `send: true`, sends real mail immediately and cannot be unsent. Confirm the recipients, subject, and body with the user before calling (or pass `send: false` to save a draft for review).

---

#### `mark-as-read` / `mark-as-unread`

Change read status of a message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID |

---

#### `flag-message` / `unflag-message`

Flag or unflag a message. `flag-message` optionally takes a flag **color**; `unflag-message` removes the flag entirely (which also clears any color).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID |
| `color` | string | No | (`flag-message` only) Flag color: `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `gray` (`grey` accepted). Omit for Mail's default flag. |

**Flag colors** are an Apple Mail feature — the message's `flag index` (0 red, 1 orange, 2 yellow, 3 green, 4 blue, 5 purple, 6 gray), which is the property a Mail smart mailbox can match on. **The color is applied on both routes** (since 2.10.0): AppleScript sets the flag index directly, and for an **IMAP-routed** id (`imap:…`) the color is written as Mail.app's `$MailFlagBit0/1/2` keywords — a 3-bit field holding the same palette index. `\Flagged` on its own really is colorless, but those keywords ride alongside it in an ordinary `UID STORE`, so a smart mailbox keyed on flag color matches an IMAP-flagged message too. You do **not** need to resolve to a numeric id just to color a flag.

To **read** a color, the IMAP read path returns `flagColorIndex` in `structuredContent` — the same 0-6 palette index, omitted when the message carries no color bits. The AppleScript read path does not populate it.

---

#### `delete-message`

Delete a message (move to trash).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID |

`structuredContent` carries `countDelta` — what the delete actually did to the
source mailbox. See [Auditing destructive operations](#auditing-destructive-operations).

**⚠️ Safety:** Destructive. Requires explicit user confirmation; search/list first to confirm the message id.

---

#### `move-message`

Move a message to a different mailbox.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID |
| `mailbox` | string | Yes | Destination mailbox — full path (`Work/Archive`) or a leaf name that is unique on the account |
| `account` | string | No | Account containing mailbox |

A destination is matched first as a full path, then as a leaf name. If a leaf
name matches **more than one** mailbox (e.g. `Archive` under both `Work` and
`Thornlands`), the move is refused with an error naming every candidate — pass
the full path. The same applies to `batch-move-messages`, `delete-mailbox` and
`rename-mailbox`.

`structuredContent` carries `countDelta` — what the move actually did to the
**source** mailbox. See [Auditing destructive operations](#auditing-destructive-operations).

---

#### `list-attachments`

List attachments on a message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID |

**Returns:** List of attachments with name, MIME type, and size.

---

#### `save-attachment`

Save a message attachment to disk.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID |
| `attachmentName` | string | Yes | Filename of the attachment |
| `savePath` | string | Yes | Directory to save to |

---

### Batch Operations

All batch operations accept an array of message IDs (max 100 per batch) and return per-item success/failure results.

**Numeric IDs are scoped to the mailbox you listed them from.** Mail.app numbers messages per
mailbox, so on a label store (Gmail, iCloud) one message answers to the same id in `INBOX`,
`Important` and `All Mail` at once — and deleting the `All Mail` copy is not the same operation as
deleting the `INBOX` copy. Each id is therefore bound to the mailbox it was listed/searched from and
the operation is applied only there, so **list or search the mailbox immediately before acting on
it**. An id the server hasn't seen listed is accepted only when exactly one mailbox holds it;
if several do, that id fails with the candidate mailboxes named instead of being applied to an
arbitrary copy. `imap:…` ids carry their own account + mailbox + UID and are never ambiguous.

**Say which mailbox with `sourceMailbox` / `sourceAccount`.** The binding above is remembered
per running server, so a client that reconnects, restarts, or replays a saved list of ids has
nothing recorded and every id takes the slower whole-tree path — where, on a label store, it is
likely to be refused as ambiguous. Passing the source mailbox explicitly is the reliable way to
stay scoped, and it overrides the remembered location. These parameters name where the ids **came
from**; for `batch-move-messages` that is distinct from `mailbox`, the destination.

`sourceMailbox` is the one that scopes, and it works on its own: omitting `sourceAccount` means
that mailbox **in the default account**, exactly as an omitted `account` does elsewhere. If the
default account cannot be determined, the ids fail with an error asking for an explicit
`sourceAccount` — a scope the server can't honor is never quietly downgraded to the guess-the-copy
walk. `sourceAccount` by itself pins nothing, since the mailbox is what an id is scoped to.

**A repeated id is one message.** `ids` is treated as a set: a duplicate names the same message,
so it is operated on once, and the batch returns **one result per distinct id**. `success` is
therefore a count of messages, not of list positions.

#### `batch-delete-messages`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string[] | Yes | Message IDs to delete (max 100) |
| `sourceMailbox` | string | No | Mailbox the **numeric** ids were listed from — pins them to it. Ignored for `imap:` ids. |
| `sourceAccount` | string | No | Account the numeric ids were listed from. Defaults to the default account; on its own it pins nothing — pair it with `sourceMailbox`. |

`structuredContent` carries `countDelta` — what the batch actually did to each
source mailbox. See [Auditing destructive operations](#auditing-destructive-operations).

**⚠️ Safety:** Destructive. Requires explicit user confirmation; search/list first to confirm the message ids.

#### `batch-move-messages`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string[] | Yes | Message IDs to move (max 100) |
| `mailbox` | string | Yes | Destination mailbox |
| `account` | string | No | Account containing mailbox |
| `sourceMailbox` | string | No | Mailbox the **numeric** ids were listed from — pins them to it. Ignored for `imap:` ids. |
| `sourceAccount` | string | No | Account the numeric ids were listed from. Defaults to the default account; on its own it pins nothing — pair it with `sourceMailbox`. |

`structuredContent` carries `countDelta` — what the batch actually did to each
**source** mailbox. See [Auditing destructive operations](#auditing-destructive-operations).

#### `batch-mark-as-read` / `batch-mark-as-unread`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string[] | Yes | Message IDs (max 100) |
| `sourceMailbox` | string | No | Mailbox the **numeric** ids were listed from — pins them to it. Ignored for `imap:` ids. |
| `sourceAccount` | string | No | Account the numeric ids were listed from. Defaults to the default account; on its own it pins nothing — pair it with `sourceMailbox`. |

#### `batch-flag-messages` / `batch-unflag-messages`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string[] | Yes | Message IDs (max 100) |
| `color` | string | No | (`batch-flag-messages` only) Flag color — see [`flag-message`](#flag-message--unflag-message). Applied on both routes, so a mixed batch of numeric and `imap:` ids all end up colored. |
| `sourceMailbox` | string | No | Mailbox the **numeric** ids were listed from — pins them to it. Ignored for `imap:` ids. |
| `sourceAccount` | string | No | Account the numeric ids were listed from. Defaults to the default account; on its own it pins nothing — pair it with `sourceMailbox`. |

---

### Mailbox Operations

#### `list-mailboxes`

List all mailboxes for an account.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account` | string | No | Account to list from |

**Returns:** List of mailbox names with message and unread counts.

---

#### `get-unread-count`

Get unread message count.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mailbox` | string | No | Mailbox to check (omit for **INBOX**) |
| `account` | string | No | Account to check (omit to sum each account's INBOX) |

**Returns:** The unread count for the requested scope.

> Omitting `mailbox` counts **INBOX**, not a cross-mailbox total. This changed in 2.8.15: summing every mailbox was slow and wrong on Gmail, where one message appears in INBOX, All Mail and every label it carries. For account-wide totals use [`get-mail-stats`](#get-mail-stats).

---

#### `create-mailbox`

Create a new mailbox.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Mailbox name |
| `account` | string | No | Account to create in |

---

#### `delete-mailbox`

Delete a mailbox.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Mailbox name |
| `account` | string | No | Account containing mailbox |

**⚠️ Safety:** Destructive — deletes the mailbox and its contents. Requires explicit user confirmation; list mailboxes first to confirm the name.

---

#### `rename-mailbox`

Rename a mailbox (creates new, moves messages, deletes old).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `oldName` | string | Yes | Current mailbox name |
| `newName` | string | Yes | New mailbox name |
| `account` | string | No | Account containing mailbox |

---

### Smart Mailbox Operations (intelligente Postfächer)

> **Requires Full Disk Access.** These tools read and write `~/Library/Mail/V*/MailData/SyncedSmartMailboxes.plist`, which is TCC-protected. Without Full Disk Access for the server's Node runtime the read simply finds nothing, and the tools report "no smart mailboxes" or "launch Mail at least once" rather than a permission error — see [Node runtime & TCC permissions](https://github.com/sweetrb/apple-mail-mcp/blob/main/docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md).

Smart mailboxes are Apple Mail's **criteria-based virtual views** — not real folders, so no messages are moved. AppleScript's `smart mailbox` / `intelligentes Postfach` terms don't compile reliably on localized (e.g. German) macOS, so these tools read and edit `~/Library/Mail/V*/MailData/SyncedSmartMailboxes.plist` directly.

**How writes stay safe:** creating or deleting a smart mailbox first backs the plist up to `SyncedSmartMailboxes.plist.bak`, edits a temp copy with `plutil`/`PlistBuddy`, validates it with `plutil -lint`, and only then atomically renames it into place. Your **existing** smart mailboxes — including any with date/data criteria — are never rewritten, only the single target entry is added or removed. These tools do **not** quit or restart Mail: **quit Mail first** for reliable results, since a running Mail may not show a new smart mailbox until it's relaunched and can overwrite plist edits it didn't make.

#### `list-smart-mailboxes`

List existing smart mailboxes.

**Parameters:** None

**Returns:** List of smart mailbox names + criteria summary.

---

#### `create-smart-mailbox`

Create a smart mailbox with a simple contains rule.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Name for the smart mailbox |
| `fromContains` | string | No | Match if From contains this |
| `subjectContains` | string | No | Match if Subject contains this |
| `bodyContains` | string | No | Match if Body contains this |

Provide at least one of the three `*Contains` fields.

**⚠️ Safety:** edits `SyncedSmartMailboxes.plist` (backed up + atomic, existing smart mailboxes preserved). Quit Mail first for reliable results; the new smart mailbox appears the next time Mail launches.

---

#### `delete-smart-mailbox`

Delete a smart mailbox by name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Smart mailbox name |

**⚠️ Safety:** destructive — removes the smart mailbox from `SyncedSmartMailboxes.plist` (backed up + atomic; every other smart mailbox is preserved). Not undoable in-app. Confirm the exact name with `list-smart-mailboxes` first, and quit Mail first for reliable results.

---

#### `create-newsletter-smart-mailboxes`

High-level tool: scan recent messages in your INBOXes, detect likely newsletters (volume + signals like List-Unsubscribe, noreply, repetitive subjects), and create smart mailboxes for them (names prefixed "NL: ...").

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dryRun` | boolean | No | Default true — only propose, do not create |
| `minCount` | number | No | Min messages from a sender (default 3) |
| `days` | number | No | Lookback window in days (default 90) |

Defaults to a **safe dry run** that only proposes. Pass `dryRun: false` to actually create the smart mailboxes for newsletters cluttering your Inbox.

**⚠️ Safety:** with `dryRun: false` this edits `SyncedSmartMailboxes.plist` (backed up + atomic, existing entries preserved) and can create many smart mailboxes at once — review a dry run first. Scans up to ~400 recent messages per inbox via AppleScript, which can be slow on large mailboxes.

---

### Account Operations

#### `list-accounts`

List all configured Mail accounts.

**Parameters:** None

**Returns:** List of account names and email addresses.

---

### Rules

#### `list-rules`

List all mail rules.

**Parameters:** None

**Returns:** List of rule names and enabled status.

---

#### `enable-rule` / `disable-rule`

Enable or disable a mail rule.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Rule name |

---

#### `create-rule`

Create a Mail rule with one or more conditions and actions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Rule name (must be unique) |
| `conditions` | object[] | Yes | One or more `{field, operator, value}` (see below) |
| `actions` | object | Yes | At least one of `markRead`, `markFlagged`, `delete`, `moveTo` |
| `matchAll` | boolean | No | `true` (default) = all conditions must match; `false` = any |
| `enabled` | boolean | No | Whether the rule is enabled on creation (default `true`) |

Each condition is `{ field, operator, value }` where `field` is one of `from`, `to`, `cc`, `subject`, `content` and `operator` is one of `contains`, `notContains`, `equals`, `beginsWith`, `endsWith`. Actions: `markRead` / `markFlagged` / `delete` (booleans), `moveTo` (mailbox name) with optional `moveToAccount`.

**Example:**
```json
{
  "name": "Newsletters",
  "conditions": [{ "field": "from", "operator": "contains", "value": "newsletter" }],
  "actions": { "markRead": true, "moveTo": "Reading" }
}
```

---

#### `delete-rule`

Delete a mail rule by name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Rule name |

**⚠️ Safety:** Destructive. Requires explicit user confirmation; list rules first to confirm the name.

---

### Contacts

#### `search-contacts`

Search the macOS Contacts database by name, organization, nickname, or email substring.

Since 2.8.7 this reads the AddressBook SQLite files directly rather than driving Contacts.app over AppleScript, so **Contacts.app need not be running and no Automation grant is involved** — but the Node runtime does need **Full Disk Access**, and **Node 22.5+** (see [Requirements](#requirements)). Without either, the tool returns an empty list rather than an error.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Substring matched against full name, organization, nickname, or any email address |

**Returns:** List of contacts with name, email addresses, and phone numbers. Results are **not** truncated — a broad query returns every match.

---

### Templates

Email templates are **persisted to disk** so they survive server restarts, stored as JSON at `APPLE_MAIL_MCP_TEMPLATES_FILE` (default `~/Library/Application Support/apple-mail-mcp/templates.json`).

#### `save-template`

Save or update an email template.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Template name |
| `subject` | string | Yes | Default subject line |
| `body` | string | Yes | Template body |
| `to` | string[] | No | Default recipients |
| `cc` | string[] | No | Default CC recipients |
| `id` | string | No | Template ID (for updating) |

---

#### `list-templates`

List all saved templates.

**Parameters:** None

---

#### `get-template`

Get a template by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Template ID |

---

#### `delete-template`

Delete a template.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Template ID |

**⚠️ Safety:** Destructive — removes the template from the on-disk store. Requires explicit user confirmation; list templates first to confirm the id.

---

#### `use-template`

Create a draft from a template, with optional overrides.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Template ID |
| `to` | string[] | No | Override recipients |
| `cc` | string[] | No | Override CC |
| `subject` | string | No | Override subject |
| `body` | string | No | Override body |

---

### Diagnostics

#### `health-check`

Verify Mail.app connectivity and permissions.

**Parameters:** None

**Returns:** Status of all health checks (app running, permissions, account access).

---

#### `doctor`

Run a full setup diagnostic: Mail.app automation permission, account state (flagging disabled accounts), and each configured IMAP/SMTP backend — each reported as ok / warn / fail with an actionable message.

**Parameters:** None

**Returns:** A per-check report (`structuredContent` carries the raw `{healthy, checks[]}`).

---

#### `get-mail-stats`

Get mail statistics.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account` | string | No | Limit to one account (uses fast IMAP `STATUS` when that account is IMAP-configured). Omit to merge across all accounts. |

**Returns:** Total and per-account message/unread counts, plus recently received stats (24h, 7d, 30d). The scoped IMAP path also returns a `perMailbox` breakdown.

Gathering stats costs one IMAP `STATUS` per mailbox, and Gmail lists every label
as a mailbox, so a large account is not instant. Accounts are counted
**concurrently**, and each is bounded by `APPLE_MAIL_MCP_STATS_BUDGET_MS`
(default `25000`). In the merged all-accounts path an account that fails or
overruns is reported via `partial: true` + `failedAccounts` rather than being
folded in as a silent zero; a scoped call to a single account returns an error
naming the budget instead. Raise the budget if you have a very large account.

The whole call is additionally bounded by one wall-clock deadline,
`APPLE_MAIL_MCP_STATS_DEADLINE_MS` (default `50000`), which covers the Mail.app
account enumeration as well as every per-account read. Per-step budgets alone
were not enough: their worst cases **add up**, and the sum could exceed a
client's request timeout, so the call died with nothing returned instead of
degrading. Keep the deadline below your MCP client's request timeout — whatever
cannot be read inside it is named in `failedAccounts`, so you always get a
partial answer rather than a dead call.

**Concurrent `get-mail-stats` calls do not run concurrently.** Tool calls are
serialized so they cannot race into Mail.app's single-threaded AppleScript
dispatch, so each call waits for the ones ahead of it and per-call latency grows
with queue depth — N concurrent calls take about N × the single-call cost. Since
this is the most expensive read tool, that is very visible here: measured on 3
IMAP accounts, three concurrent calls returned at 5.5s / 10.3s / 15.6s against a
~5.2s solo cost. The deadline is measured from when the request **arrived**, so
that wait is spent from the same budget as the work: a call that waited ≥1s
reports `queueWaitMs`, and one that arrives with its deadline already spent
returns straight away naming the queue rather than starting work whose answer
would land after your client has given up. Issue these calls one at a time, and
prefer `get-unread-count` when a single number will do.

---

#### `get-sync-status`

Check Mail.app sync activity.

**Parameters:** None

**Returns:** Whether sync is detected, pending uploads, recent activity, and seconds since last change.

---

## Auditing destructive operations

`delete-message`, `move-message`, `batch-delete-messages` and
`batch-move-messages` report what they actually did, not merely that Mail.app did
not raise an error. This exists because of
[#155](https://github.com/sweetrb/apple-mail-mcp/issues/155): a batch delete was
reported to have removed two messages whose ids were never passed, and nothing in
the server recorded enough to explain it.

### `countDelta` — always on, no configuration

Every one of those four tools counts the affected **source** mailbox immediately
before and immediately after the mutation, **inside the same AppleScript it was
already running** (no extra `osascript` invocations, no measurable cost), and
returns the comparison in `structuredContent`:

```json
{
  "ok": true,
  "success": 2,
  "failed": 0,
  "countDelta": [
    {
      "account": "you@gmail.com",
      "mailbox": "INBOX",
      "before": 412,
      "after": 408,
      "expected": 2,
      "observed": 4,
      "status": "over"
    }
  ]
}
```

`status` is deliberately four-valued rather than a pass/fail flag:

| `status` | Meaning | Warns? |
|----------|---------|--------|
| `match` | Exactly as many messages left the mailbox as the operation acted on. | No |
| `over` | **More** left than were operated on. Messages are unaccounted for. | **Yes** |
| `under` | **Fewer** left than expected. | No |
| `unknown` | No comparison was possible: either Mail would not report a count (`before`/`after` null) or there is no predictable expectation (`expected` null — see the self-move rule below). | No |

#### What an `over` warning does and does not tell you

Only `over` produces a warning in the tool's text response. Be precise about what
that warning proves, because a warning is useful only for as long as it is
trusted:

- **It establishes** that more messages left the source mailbox across the window
  of the operation than the operation accounted for. That is the data-loss
  direction, and it is the #155 signature.
- **It does not establish that this server removed them.** The reading is a
  before/after pair around a window, so anything else that removes mail from that
  mailbox inside the window reads identically: a Mail.app rule firing mid-batch,
  a server-side filter, another client (phone, webmail, a second Mail.app)
  deleting or moving, or an IMAP expunge landing between the two counts.

**Concurrent departure is the benign cause to rule out first**, and the warning
text says so. What the asymmetry argument actually buys is the other half:
concurrent *arrivals* cannot produce `over`, because a message arriving
mid-operation *raises* the after-count and biases the reading toward `under`.
That is why `over` is the interesting direction — a strong signal, not a proof.

Setting `APPLE_MAIL_MCP_AUDIT_LOG` is what settles which one you have: the
collateral diff below **names** the messages that disappeared, and "the
newsletter my rule files every morning" is a very different report from a message
nothing should have touched.

`under`, by contrast, is routine: an account that flags deletions rather than
removing them leaves the message in place and the count does not move, and a
Gmail label mailbox can behave the same way while the delete genuinely succeeded.
A warning that fires on every ordinary Gmail delete would be ignored exactly when
it matters, so `under` is **reported** in `countDelta` (with a `note` explaining
it) and never warned about.

Three more honesty rules:

- The **expectation is per source mailbox**. On a Gmail label store, deleting the
  `INBOX` copy drops the `\Inbox` label and deleting the `[Gmail]/All Mail` copy
  trashes the message — different operations, but either way the mailbox the ids
  came from loses exactly one entry per id. That is what is compared. A move's
  **destination** count is not checked.
- A move whose destination **is** the source mailbox is **not compared at all**.
  No message should leave, but what Mail does to the count when a message is
  re-filed into the mailbox it already occupies is unspecified — so `expected` is
  `null`, `status` is `unknown`, `note` says why, and no warning is raised. A
  warning computed against a guessed expectation would fire on an operation that
  did exactly what it was asked to, which is the one thing this instrumentation
  must never do.

  **This makes a self-move a blind spot for the always-on layer**, and the cost is
  worth stating plainly: if messages genuinely do disappear during a self-move,
  nothing warns you, because there was no expectation to compare against. `status`
  is `unknown` rather than `match`, so the result does not claim the operation was
  clean — but it does not flag it either. The collateral diff still names anything
  that vanished, so **enable `APPLE_MAIL_MCP_AUDIT_LOG` if you need coverage for
  same-mailbox moves.**
- A **repeated id is one message**. The batch tools operate on each distinct id
  once and return one result per distinct id, so `success` counts messages rather
  than list positions — and `expected` stays comparable with the mailbox instead
  of double-counting a duplicate into a false `over`.

`imap:` ids are not reconciled. An IMAP UID names exactly one message in exactly
one mailbox, so the mis-targeting class this exists for cannot occur there; a
batch of only `imap:` ids returns no `countDelta` rather than a fabricated one.

### `APPLE_MAIL_MCP_AUDIT_LOG` — opt-in forensic log

| Variable | Default | Description |
|----------|---------|-------------|
| `APPLE_MAIL_MCP_AUDIT_LOG` | *(off)* | Absolute path to an NDJSON file. Setting it enables the audit log **and** the collateral diff below |
| `APPLE_MAIL_MCP_AUDIT_SUBJECTS` | `0` | Set `1` to also record message **subjects**. Separate, deliberate second opt-in — see Privacy |
| `APPLE_MAIL_MCP_AUDIT_SNAPSHOT_MAX` | `2000` | Skip the collateral snapshot for mailboxes larger than this many messages. `0` disables the snapshot entirely |

When set, each destructive operation appends **one JSON object per line**
containing: timestamp, tool name, server version, the arguments it was called
with, the **pre-image** of every message it resolved (account, mailbox, numeric
id, RFC Message-ID, `date received`), the per-id outcome (`ok` / `notfound` /
`error` + reason), the `countDelta` above, and the collateral diff.

The pre-image is the part that matters after the fact: a Mail.app numeric id is
unique only within a mailbox and is reused, so on its own it proves nothing about
which message was acted on. The RFC Message-ID does.

**The record is framed against its own contents.** The Message-ID and (when
enabled) the subject are written by whoever sent the mail, so the control
characters this server frames records with are stripped out of every such value
before it is written — a Message-ID crafted to close a record and open a forged
one cannot invent evidence in the log it is being recorded in. The same stripping
is applied to every other value read out of Mail at runtime (`date received`,
mailbox and account names, the text of an error Mail raised, the candidate list
behind an "ambiguous id" refusal), so no emitter is an exception. A value that
arrives with those characters in it (which a well-formed Message-ID never does)
is logged with each of them replaced by `U+FFFD`, so the record shows that the
value was altered rather than quietly shortening it.

### Collateral identification — which messages actually disappeared

Also gated on `APPLE_MAIL_MCP_AUDIT_LOG`. The mailbox's `(numeric id, Message-ID)`
pairs are captured before and after the mutation and diffed, so the log names
every message that left — **including ones the caller never listed**:

```json
{
  "account": "you@gmail.com",
  "mailbox": "INBOX",
  "snapshot": "ok",
  "disappeared": [
    { "id": "75811", "messageId": "a@example.com" },
    { "id": "75814", "messageId": "d@example.com" }
  ],
  "unrequested": [{ "id": "75814", "messageId": "d@example.com" }],
  "appeared": []
}
```

A non-empty `unrequested` **is** the #155 symptom, with names attached. Please
attach that line to the issue if you ever see one.

`id` is always the plain decimal id you passed, even on a mailbox whose ids
exceed AppleScript's 2^29 integer range (where Mail hands them back as
`9.99999999E+8`). That normalisation is also what keeps `unrequested` truthful:
compared in the raw form, a message you explicitly asked to delete would be
reported here as collateral.

This costs one bulk property read per snapshot and is O(mailbox size), so it is
bounded by `APPLE_MAIL_MCP_AUDIT_SNAPSHOT_MAX`. When the bound bites, the record
says so explicitly (`"snapshot": "skipped"` with a reason) rather than omitting
the field — a silently skipped snapshot would read as "nothing collateral
happened", which is worse than no snapshot at all. `countDelta` is unaffected by
the skip and still reconciles the counts.

### Privacy, and what the file costs you

- **Default:** identifying metadata only — Message-ID, date, mailbox, account,
  numeric id. Enough to say *which* message, nothing about what it says.
- **Subjects are behind their own opt-in** (`APPLE_MAIL_MCP_AUDIT_SUBJECTS=1`)
  because a subject line is frequently the entire sensitive payload, and it is
  not needed to diagnose #155.
- **Message bodies are never logged, under any setting.**
- The file **grows without bound** and is never rotated or truncated by this
  server. Point it somewhere you control, and delete it when you are done. It is
  written with your user's permissions, wherever you point it; there is no
  default location precisely so that turning it on is a deliberate act.
- Writes go to that file and nowhere else. Diagnostics go to **stderr**; nothing
  is ever written to stdout, which is the JSON-RPC transport.

---

## Usage Patterns

### Basic Workflow

```
User: "Check my inbox for new emails"
AI: [calls list-messages]
    "You have 12 messages. Here are the most recent..."

User: "Show me emails from Sarah"
AI: [calls search-messages with query="Sarah"]
    "Found 3 emails from Sarah across all mailboxes..."

User: "Read the first one"
AI: [calls get-message with id="..."]
    "Subject: Project Update..."
```

### Working with Accounts

By default, operations use Mail.app's configured default send account. Search operations check all accounts when no account is specified. To work with specific accounts:

```
User: "What email accounts do I have?"
AI: [calls list-accounts]
    "You have 3 accounts: iCloud, Gmail, Work Exchange"

User: "Show unread emails in my Work account"
AI: [calls list-messages with account="Work Exchange", mailbox="INBOX"]
    "Your Work account has 5 unread messages..."
```

To pin which account is used when a tool call omits `account`, set the
`APPLE_MAIL_MCP_DEFAULT_ACCOUNT` environment variable to an account **name or
email**. When unset (the default), the server falls back to Mail.app's
default-send account if it is enabled, otherwise the first enabled account. A
**disabled** account is never selected implicitly — this env var (an explicit,
deliberate pin) is one of the few ways to target one ([#47](https://github.com/sweetrb/apple-mail-mcp/issues/47)).

### Sending Emails Safely

```
User: "Draft an email to the team about the deadline"
AI: [calls create-draft with to=["team@..."], subject="...", body="..."]
    "I've created a draft. Please review it in Mail.app before sending."

User: "Send it"
AI: [User opens Mail.app and sends manually, or AI calls send-email]
```

### Sending Personalized Emails (Mail Merge)

```
User: "Send a personalized email to Alice (alice@acme.com), Bob (bob@globex.com),
       and Carol (carol@initech.com). Subject: 'Project Update for {{Company}}',
       Body: 'Hi {{Name}}, here is the latest update for {{Company}}.'"
AI: [calls send-serial-email with recipients, subject template, and body template]
    "Successfully sent 3 email(s):
      - alice@acme.com: sent
      - bob@globex.com: sent
      - carol@initech.com: sent"
```

### Organizing Messages

```
User: "Move all newsletters to Archive"
AI: [calls search-messages to find newsletters]
AI: [calls move-message for each, with mailbox="Archive"]
    "Moved 8 newsletters to Archive"
```

---

## Installation Options

### npm (Recommended)

```bash
npm install -g apple-mail-mcp
```

### From Source

```bash
git clone https://github.com/sweetrb/apple-mail-mcp.git
cd apple-mail-mcp
```

The repo ships prebuilt, dependency-free `build/index.js` and `build/cli.js` bundles, so a bare clone runs with nothing but Node installed. `npm install` and `npm run build` are only needed when you change the source.

> You can also install straight from GitHub with `npm install -g github:sweetrb/apple-mail-mcp`, but that builds from source (requires pnpm) — prefer the registry package above.

If installed from source, use this configuration:
```json
{
  "mcpServers": {
    "apple-mail": {
      "command": "node",
      "args": ["/path/to/apple-mail-mcp/build/index.js"]
    }
  }
}
```

#### Running from a clone in Claude Code (project-scope `.mcp.json`)

This repo ships a `.mcp.json` at its root so that, when you run `claude` from inside a clone, the server is registered automatically as a **project-scope** server — no manual config needed. Just launch Claude Code from the repo directory and approve the server when prompted (the bundled `build/index.js` is committed, so no build step is required).

The entrypoint is written as:

```text
"args": ["${CLAUDE_PROJECT_DIR:-.}/build/index.js"]
```

`CLAUDE_PROJECT_DIR` is the variable Claude Code injects into a project/user-scoped server's environment, and it resolves to the repo root. **You must launch `claude` from inside the repo** for this to work — the bare `.` fallback is only a last resort and is *not* reliable, because it resolves against the launching process's working directory, not the repo.

> **Why not `${CLAUDE_PLUGIN_ROOT}`?** `CLAUDE_PLUGIN_ROOT` is set **only** for marketplace plugin installs, never for a project-scope clone, so it can't drive the clone workflow. Conversely, a plugin install can't use `CLAUDE_PROJECT_DIR` (in a plugin, that points at the *user's* project, not the plugin's own directory). Claude Code does **not** support nested defaults like `${CLAUDE_PLUGIN_ROOT:-${CLAUDE_PROJECT_DIR:-.}}`, so a single entrypoint string cannot serve both contexts. The two distribution paths are therefore decoupled: the **plugin** carries its own MCP config in `.claude-plugin/plugin.json` (using `${CLAUDE_PLUGIN_ROOT}`), while the root `.mcp.json` is dedicated to the **clone** workflow (using `${CLAUDE_PROJECT_DIR:-.}`). Because `plugin.json` declares its own `mcpServers`, the plugin does not also auto-load the root `.mcp.json`, so there is no double-registration.

> **Heads-up on scope precedence:** project-scope (`.mcp.json`) outranks user-scope. If you *also* have an `apple-mail` entry registered at user scope (e.g. an absolute path in `~/.claude.json`), the project-scope entry wins and the user-scope one is ignored entirely. Pick one — for local development on this repo, the project-scope `.mcp.json` is the intended source. To pin a specific local build instead, register it at **local** scope (`claude mcp add apple-mail -s local -- node /abs/path/build/index.js`), which outranks project scope.

---

## Security and Privacy

- **No third parties** - The server talks only to Mail.app on this Mac (AppleScript) and, when you configure them, directly to **your own** mail provider over TLS (IMAP/SMTP). Nothing is sent to this project or any other service. With the default AppleScript backend everything stays on-device; the opt-in IMAP/SMTP backends necessarily reach your provider, which is what they are for.
- **Permission required** - macOS will prompt for automation permission on first use.
- **No credential storage** - The server doesn't store any passwords or authentication tokens.
- **Email safety** - Use `create-draft` to review emails before sending.

---

## Known Limitations

| Limitation | Reason |
|------------|--------|
| macOS only | Apple Mail and AppleScript are macOS-specific |
| MCP `send-email` is plain-text | The `send-email` tool sends plain text (reading HTML content is supported). To send HTML, use the bundled `apple-mail-send` CLI with `--html-body-file` (sends `multipart/alternative` via SMTP) |
| Attachments require absolute paths | File attachments must use full absolute paths (e.g., `/Users/me/file.pdf`) |
| Smart mailboxes need Mail quit | Smart mailboxes are supported (see [Smart Mailbox Operations](#smart-mailbox-operations-intelligente-postfächer)), but `create-`/`delete-smart-mailbox` edit `SyncedSmartMailboxes.plist` directly — a running Mail may not show a new one until relaunched, and can overwrite plist edits it didn't make. Quit Mail first. Reading them needs Full Disk Access for the Node runtime |
| Very large mailboxes not searchable *via AppleScript* | Apple Mail's AppleScript bridge times out on mailboxes with tens of thousands of messages, so unscoped `search-messages` skips mailboxes above `APPLE_MAIL_MAX_SEARCH_MAILBOX` (default 5000) and reports them as a partial result. Scope with `mailbox` + a date window — or configure the [IMAP backend](#imap-backend--opt-in), which searches these server-side in well under a second. ([#24](https://github.com/sweetrb/apple-mail-mcp/issues/24)) |
| Can't delete/rename server-side mailboxes or mutate drafts *via AppleScript* | Mail.app's AppleScript bridge can only `delete`/`rename` **local "On My Mac"** mailboxes and cannot delete/move drafts — it throws `AppleEvent handler failed` for IMAP/Gmail/Workspace/iCloud/Exchange mailboxes (the GUI can do it). Without IMAP configured, `delete-mailbox`/`rename-mailbox`/`delete-message`/`move-message` return a clear "do it in Mail.app directly" error instead of a generic failure. With the [IMAP backend](#imap-backend--opt-in) configured for the account, these operations run via IMAP and succeed. ([#42](https://github.com/sweetrb/apple-mail-mcp/issues/42)) |
| Message ID format | Message IDs must be numeric (AppleScript ids) or `imap:…` tokens from the IMAP read path (validated by schema) |
| Batch size cap | Batch operations are limited to 100 messages per request |
| Date filter format | Date filters must be valid parseable dates (e.g., "January 1, 2026" or "2026-03-15"); bare numbers or non-date strings are rejected |
| Attachment save path restrictions | `save-attachment` only allows saving to home directory, `/tmp`, `/private/tmp`, and `/Volumes`; path traversal is blocked |
| Attachment count limit | `send-email` and `create-draft` accept a maximum of 20 file attachments |

### Mail.app `<blockquote>` wrapping on macOS 15+ (workaround in v1.6.0)

On macOS 15+ Mail.app wraps AppleScript-injected message bodies in
`<blockquote type="cite">` under the `Apple-Mail-URLShareWrapperClass` template,
so mail sent via the default `applescript` transport renders to recipients as
quoted/forwarded content (Apple radar **FB11734014**, open since Ventura, no
fix). Since v1.6.0, `send-email` accepts `transport: "smtp"` to bypass Mail.app
and send clean MIME directly — see [SMTP transport](#smtp-transport). The
AppleScript path is still the default and still exhibits Apple's wrapping.
([#12](https://github.com/sweetrb/apple-mail-mcp/issues/12))

### Reply / Forward from Background Processes (Fixed in v1.4.0)

Prior to v1.4.0, `reply-to-message` and `forward-message` would send messages with **empty body text** when the MCP server ran as a background process (e.g., spawned via `execSync` from Node.js, which is how Claude Code invokes it).

**Root cause:** The AppleScript `reply msg with opening window` command creates a GUI compose window asynchronously. When `set content` runs immediately after, the window may not be ready, and the content assignment is silently ignored. Delays (`delay 1`, `delay 2`) were unreliable — the compose window's readiness depends on system load, Mail.app state, and whether the process has GUI access.

**Fix:** Replaced `with opening window` with `without opening window` for both `reply` and `forward` commands. With this approach, `set content` works immediately and reliably from background processes. `In-Reply-To` and `References` headers are still set correctly by Mail.app, and no GUI compose window is opened.

**Update (v2.5.0):** when SMTP is configured, `reply-to-message` and `forward-message` now prefer **clean direct SMTP** instead of AppleScript — the same prefer-direct model as `send-email`. Replies are threaded with RFC 5322 `In-Reply-To`/`References` headers built from the original message; forwards start a new conversation. The AppleScript `without opening window` path above remains the fallback when SMTP is not configured (or, for replies, when the original message lacks the headers needed to thread).

See [#7](https://github.com/sweetrb/apple-mail-mcp/issues/7) for full details and the list of approaches that were tested.

### Backslash Escaping (Important for AI Agents)

When sending content containing backslashes (`\`) to this MCP server, **you must escape them as `\\`** in the JSON parameters.

**Why:** The MCP protocol uses JSON for parameter passing. In JSON, a single backslash is an escape character. To include a literal backslash in content, it must be escaped as `\\`.

**Correct — email containing a shell path with an escaped space:**

```json
{
  "to": ["colleague@company.com"],
  "subject": "File Location",
  "body": "Run: cp ~/Library/Mobile\\ Documents/report.pdf ~/Desktop/"
}
```

→ arrives as: `Run: cp ~/Library/Mobile\ Documents/report.pdf ~/Desktop/`

In a JSON string literal, `\\` — two characters — denotes **one** literal backslash. Four backslashes (`\\\\`) denote **two** literal backslashes, so send those only when the text genuinely contains `\\`.

**Incorrect — the unescaped backslash makes this invalid JSON:**

```text
"body": "Run: cp ~/Library/Mobile\ Documents/report.pdf ~/Desktop/"
```

`\ ` (backslash-space) is not a valid JSON escape sequence, so the call is rejected — or, with a laxer parser, the backslash is silently dropped.

**Common patterns requiring escaping:**

- Shell escaped spaces: `Mobile\ Documents` → `Mobile\\ Documents` in JSON
- Regex patterns: `\d+` → `\\d+` in JSON
- A literal double backslash: `\\` → `\\\\` in JSON

**If you see errors** when sending emails with backslashes, double-check that backslashes are properly escaped in the JSON payload.

---

## Troubleshooting

### "Mail.app not responding"
- Ensure Mail.app is not frozen
- Try opening Mail.app manually
- Restart the MCP server

### "Permission denied"
- macOS needs automation permission
- Go to System Settings > Privacy & Security > Automation
- Ensure your terminal/Claude has permission to control Mail

### "Message not found"
- Message may have been deleted or moved
- Message IDs change if the message is moved between mailboxes
- Use `search-messages` to find the current message ID

### "... is present in more than one mailbox"
- A bare numeric ID identifies a message only *within a mailbox*, and a label store (Gmail, iCloud)
  reports the same message under the same ID in `INBOX`, `Important` and `All Mail` at once. The
  server refuses rather than guessing which copy you meant.
- Fix it by running `list-messages`/`search-messages` on the mailbox you actually want to act on,
  then using the IDs from that result — the operation is then scoped to that mailbox.
- It only affects IDs the server hasn't seen listed (carried over from an earlier session, or typed
  by hand). `imap:…` IDs encode their own mailbox and never hit this.

### `search-messages` says "Partial results" or skips a mailbox
- This is expected for very large IMAP/Gmail mailboxes (e.g. Gmail's `All Mail`, `Important`): Apple Mail can't scan them via AppleScript before timing out, so they're skipped and named in the result rather than silently returning empty.
- To search inside one, scope the call with `mailbox` **and** a `dateFrom`/`dateTo` window.
- Raise or disable the threshold with `APPLE_MAIL_MAX_SEARCH_MAILBOX` (default `5000`; `0` disables the guard) — note that disabling it can make a single search take minutes.
- A `Partial results` warning means coverage was incomplete; it is **not** a confirmed "no such mail."

### "Account not found"
- Account names must match exactly (case-sensitive)
- Use `list-accounts` to see exact account names

### "Failed to send email"
- Check your network connection
- Verify Mail.app can send emails manually
- Check if the account is configured correctly in Mail.app

### "invalid outputSchema … unsupported dialect" — every tool is refused
- Full text: `Tool '<name>' has an invalid outputSchema: JSON Schema declares an unsupported dialect ("$schema": "http://json-schema.org/draft-07/schema#"). The default validator supports JSON Schema 2020-12 only.` The server connects, but **no tool is usable**.
- **Upgrade to 2.10.12 or later.** Earlier versions advertised their tool schemas in JSON Schema **draft-07** (the MCP SDK's converter default); MCP has since standardized on **2020-12** and clients reject anything else. 2.10.12 normalizes every advertised `inputSchema`/`outputSchema` to 2020-12 on the way out. See [issue #147](https://github.com/sweetrb/apple-mail-mcp/issues/147).
- Nothing to configure — restart your host app after upgrading so it re-reads the tool list.

### `apple-mail` server fails to connect when run from a clone
- The root `.mcp.json` resolves its entrypoint via `${CLAUDE_PROJECT_DIR:-.}/build/index.js`. **Launch `claude` from inside the repo directory** — `CLAUDE_PROJECT_DIR` only resolves to the repo root in that case; the bare `.` fallback uses the launching shell's working directory and will point at the wrong place otherwise.
- If you've been editing the source, rerun `npm run build` — the server is `build/index.js`, and the committed bundle only reflects your changes after a rebuild.
- Run `claude mcp list` to check status. If you see a *conflicting scopes* warning for `apple-mail`, you have it registered at more than one scope; project-scope wins. See [Running from a clone](#running-from-a-clone-in-claude-code-project-scope-mcpjson) for how scope precedence resolves.
- If `claude mcp get apple-mail` shows **⏸ Pending approval**, approve the project-scope server (Claude Code prompts on startup, or run it again after approving).

---

## Development

This repo is **pnpm-only** — `package.json`'s `preinstall` guard hard-fails an `npm install`, because npm resolves off-lockfile and the committed bundle would then mismatch CI.

```bash
corepack enable && pnpm install --frozen-lockfile   # Install dependencies
pnpm run build             # Typecheck, then bundle src/index.ts + src/cli.ts into build/ (esbuild)
pnpm test                  # Run unit tests
pnpm run test:integration  # Run integration tests (requires Mail.app)
pnpm run test:all          # Run all tests (unit + integration)
pnpm run lint              # Check code style
pnpm run format            # Format code
```

---

## Author

**Rob Sweet** - President, [Superior Technologies Research](https://www.superiortech.io)

A software consulting, contracting, and development company.

- Email: rob@superiortech.io
- GitHub: [@sweetrb](https://github.com/sweetrb)

## License

MIT License - see [LICENSE](https://github.com/sweetrb/apple-mail-mcp/blob/main/LICENSE) for details.

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](https://github.com/sweetrb/apple-mail-mcp/blob/main/CONTRIBUTING.md) for guidelines.

## Related Projects

Part of a family of macOS MCP servers:

- [apple-notes-mcp](https://github.com/sweetrb/apple-notes-mcp) — MCP server for Apple Notes (create, search, update, and export notes)
- [apple-numbers-mcp](https://github.com/sweetrb/apple-numbers-mcp) — MCP server for Apple Numbers (read and write .numbers spreadsheets)
- [apple-photos-mcp](https://github.com/sweetrb/apple-photos-mcp) — MCP server for Apple Photos (query metadata and export originals)

## Recurring macOS permission prompts

If macOS keeps re-prompting for Full Disk Access or Automation for `node` (often after a `brew upgrade`), see [docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md](https://github.com/sweetrb/apple-mail-mcp/blob/main/docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md) — the fix is to run this server under the official, Developer-ID-signed Node so the grant survives Node updates.
