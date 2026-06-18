# Apple Mail MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that enables AI assistants like Claude to read, send, search, and manage emails in Apple Mail on macOS.

[![npm version](https://img.shields.io/npm/v/apple-mail-mcp)](https://www.npmjs.com/package/apple-mail-mcp)
[![CI](https://github.com/sweetrb/apple-mail-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sweetrb/apple-mail-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

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

### Using the Plugin Marketplace

Install as a Claude Code plugin for automatic configuration and enhanced AI behavior:

```bash
/plugin marketplace add sweetrb/apple-mail-mcp
/plugin install apple-mail
```

This method also installs a **skill** that teaches Claude when and how to use Apple Mail effectively.

### Manual Installation

**1. Install the server:**
```bash
npm install -g github:sweetrb/apple-mail-mcp
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

## Requirements

- **macOS** - Apple Mail and AppleScript are macOS-only
- **Node.js 20+** - Required for the MCP server
- **Apple Mail** - Must have at least one account configured (iCloud, Gmail, Exchange, etc.)

## Features

### Messages

| Feature | Description |
|---------|-------------|
| **List Messages** | List messages with pagination, sender filter, date display |
| **Search Messages** | Search by sender, subject, content, date range, read/flagged status — across all accounts |
| **Read Messages** | Get full email content (plain text or HTML) |
| **Send Email** | Compose and send new emails (with optional file attachments) |
| **Send Serial Email** | Mail merge — send personalized emails to a list of recipients with {{placeholder}} support |
| **Create Draft** | Save emails to Drafts folder (with optional file attachments) |
| **Reply** | Reply to messages (with reply-all support) |
| **Forward** | Forward messages to new recipients |
| **Mark Read/Unread** | Change read status (single or batch) |
| **Flag/Unflag** | Flag or unflag messages (single or batch) |
| **Delete Messages** | Move messages to trash (single or batch) |
| **Move Messages** | Organize into mailboxes (single or batch) |
| **List Attachments** | View attachment metadata (name, type, size) |
| **Save Attachment** | Save attachments to disk |

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
| **Search Contacts** | Look up contacts from Contacts.app by name |
| **Email Templates** | Save, list, use, and delete reusable email templates |

### Diagnostics

| Feature | Description |
|---------|-------------|
| **Health Check** | Verify Mail.app connectivity |
| **Statistics** | Message and unread counts per account, recently received stats |
| **Sync Status** | Check if Mail.app is actively syncing |

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
| `limit` | number | No | Max results (default: 50) |

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

**Returns:** Subject line and message body (plain text by default, HTML if `preferHtml` is true and HTML content is available).

---

#### `list-messages`

List messages in a mailbox.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mailbox` | string | No | Mailbox name (omit to list from all mailboxes) |
| `account` | string | No | Account name |
| `limit` | number | No | Max messages (default: 50) |
| `offset` | number | No | Number of messages to skip (for pagination) |
| `from` | string | No | Filter by sender email address or name |
| `unreadOnly` | boolean | No | Only show unread messages |

**Returns:** List of messages with ID, date, subject, and sender.

---

#### `send-email`

Send a new email immediately.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string[] | Yes | Recipient addresses |
| `subject` | string | Yes | Email subject |
| `body` | string | Yes | Email body (plain text) |
| `cc` | string[] | No | CC recipients |
| `bcc` | string[] | No | BCC recipients |
| `account` | string | No | Send from specific account (with `transport: "smtp"`, overrides the From address) |
| `attachments` | string[] | No | Absolute file paths to attach, max 20 files (e.g., `["/Users/me/report.pdf"]`) |
| `transport` | `"applescript"` \| `"smtp"` | No | Send transport (default `"applescript"`). Use `"smtp"` to send clean MIME directly, avoiding the macOS 15+ Mail.app `<blockquote>` wrapping — see [SMTP transport](#smtp-transport) |

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
Ventura). Passing `transport: "smtp"` bypasses Mail.app entirely and submits
clean MIME via SMTP.

Configure SMTP via environment variables on the MCP server. The password is
read from the macOS **Keychain** by default, so no secret goes in config:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `APPLE_MAIL_MCP_SMTP_HOST` | Yes | — | SMTP server hostname (e.g. `smtp.fastmail.com`) |
| `APPLE_MAIL_MCP_SMTP_USER` | Yes | — | SMTP username |
| `APPLE_MAIL_MCP_SMTP_PORT` | No | `465` if secure, else `587` | SMTP port |
| `APPLE_MAIL_MCP_SMTP_SECURE` | No | `false` | `true` for implicit TLS (port 465); otherwise STARTTLS |
| `APPLE_MAIL_MCP_SMTP_FROM` | No | = user | From address |
| `APPLE_MAIL_MCP_SMTP_PASSWORD` | No | — | Password (if set, used instead of the Keychain) |
| `APPLE_MAIL_MCP_SMTP_KEYCHAIN_SERVICE` | No | = host | Keychain item service/server name |
| `APPLE_MAIL_MCP_SMTP_KEYCHAIN_ACCOUNT` | No | = user | Keychain item account |

Store the password in the Keychain once (an app-specific password for Gmail/
iCloud), e.g.:

```bash
security add-internet-password -s smtp.fastmail.com -a you@example.com -w
```

Then send:
```json
{
  "to": ["colleague@company.com"],
  "subject": "Standings",
  "body": "Plain body — no blockquote wrapping.",
  "transport": "smtp"
}
```

The default `applescript` transport is unchanged; SMTP is opt-in per call.

##### IMAP backend (read/search) — opt-in, Phase 1

AppleScript runs `search`/`list` predicates client-side over the Apple Event
bridge, which is slow and can time out (false-empty) on large Gmail/IMAP
mailboxes (see [#24](https://github.com/sweetrb/apple-mail-mcp/issues/24)). When
an account is configured for IMAP, `search-messages` and `list-messages` instead
run a **server-side IMAP search** ([#43](https://github.com/sweetrb/apple-mail-mcp/issues/43)) —
typically sub-second and correct on the same mailbox where AppleScript times out.
This is **opt-in and additive**: any account without IMAP configured behaves
exactly as before (AppleScript). When an account is IMAP-configured,
`search-messages`/`list-messages` (read) and `create-mailbox`/`rename-mailbox`/
`delete-mailbox` (folder ops) route to IMAP. The folder ops are the key win for
server accounts: IMAP's `CREATE`/`RENAME`/`DELETE` succeed on exactly the
iCloud/Gmail/Workspace/Exchange mailboxes where Mail.app's AppleScript bridge
can't (#42). `get-message` and message-level mutations (mark/flag/move/delete-
message) stay on AppleScript for now — they key off a message id, and the IMAP
read rows report **UIDs** (a different, per-mailbox namespace), so routing them
safely needs a UID-aware design (tracked on #43).

Routing is conservative: only a call whose explicit `account` matches the
configured IMAP account goes to IMAP; everything else falls through to
AppleScript.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `APPLE_MAIL_MCP_IMAP_USER` | Yes | — | Login address; setting it enables IMAP |
| `APPLE_MAIL_MCP_IMAP_ACCOUNT` | No | = user | Mail account name to match for routing |
| `APPLE_MAIL_MCP_IMAP_HOST` | No | `imap.gmail.com` | IMAP server hostname |
| `APPLE_MAIL_MCP_IMAP_PORT` | No | `993` | IMAP port (993 = implicit TLS) |
| `APPLE_MAIL_MCP_IMAP_PASSWORD` | No | — | Password (if set, used instead of the Keychain) |
| `APPLE_MAIL_MCP_IMAP_KEYCHAIN_SERVICE` | No | — | Keychain item service/server name |
| `APPLE_MAIL_MCP_IMAP_KEYCHAIN_ACCOUNT` | No | = user | Keychain item account |

As with SMTP, the password is read from the macOS **Keychain** by default (use
an app-specific password for Gmail/Workspace/iCloud), so no secret goes in
config. Gmail label semantics: common names (`All Mail`, `Sent`, `Trash`,
`Spam`, `Important`, …) map to their `[Gmail]/…` IMAP paths automatically.

> Note: each call currently opens its own IMAP connection (no pooling yet), so
> expect a few seconds of connection overhead per call. Phase 2 added the folder
> ops (create/rename/delete-mailbox) — resolving the IMAP slice of
> [#42](https://github.com/sweetrb/apple-mail-mcp/issues/42). IMAP-backed
> message-level mutations are still future work (see #43).
>
> **iCloud:** set `APPLE_MAIL_MCP_IMAP_HOST=imap.mail.me.com`, `APPLE_MAIL_MCP_IMAP_USER`
> to your iCloud address, `APPLE_MAIL_MCP_IMAP_ACCOUNT` to the Mail account name
> (e.g. `iCloud`), and use an **app-specific password** (from appleid.apple.com)
> stored in the Keychain.

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
| `attachments` | string[] | No | Absolute file paths to attach, max 20 files |

**Returns:** Confirmation that draft was created.

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

---

#### `forward-message`

Forward a message to new recipients.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID to forward |
| `to` | string[] | Yes | Recipients to forward to |
| `body` | string | No | Message to prepend |
| `send` | boolean | No | Send immediately (default: true, false = save as draft) |

---

#### `mark-as-read` / `mark-as-unread`

Change read status of a message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID |

---

#### `flag-message` / `unflag-message`

Flag or unflag a message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID |

---

#### `delete-message`

Delete a message (move to trash).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID |

---

#### `move-message`

Move a message to a different mailbox.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID |
| `mailbox` | string | Yes | Destination mailbox |
| `account` | string | No | Account containing mailbox |

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

#### `batch-delete-messages`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string[] | Yes | Message IDs to delete (max 100) |

#### `batch-move-messages`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string[] | Yes | Message IDs to move (max 100) |
| `mailbox` | string | Yes | Destination mailbox |
| `account` | string | No | Account containing mailbox |

#### `batch-mark-as-read` / `batch-mark-as-unread`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string[] | Yes | Message IDs (max 100) |

#### `batch-flag-messages` / `batch-unflag-messages`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string[] | Yes | Message IDs (max 100) |

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
| `mailbox` | string | No | Mailbox to check (omit for total) |
| `account` | string | No | Account to check |

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

---

#### `rename-mailbox`

Rename a mailbox (creates new, moves messages, deletes old).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `oldName` | string | Yes | Current mailbox name |
| `newName` | string | Yes | New mailbox name |
| `account` | string | No | Account containing mailbox |

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

### Contacts

#### `search-contacts`

Search contacts in Contacts.app.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Name to search for |
| `limit` | number | No | Max results (default: 10) |

**Returns:** List of contacts with name, email addresses, and phone numbers.

---

### Templates

Email templates are stored in memory for the duration of the server session.

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

#### `get-mail-stats`

Get mail statistics.

**Parameters:** None

**Returns:** Total and per-account message/unread counts, plus recently received stats (24h, 7d, 30d).

---

#### `get-sync-status`

Check Mail.app sync activity.

**Parameters:** None

**Returns:** Whether sync is detected, pending uploads, recent activity, and seconds since last change.

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
npm install -g github:sweetrb/apple-mail-mcp
```

### From Source

```bash
git clone https://github.com/sweetrb/apple-mail-mcp.git
cd apple-mail-mcp
npm install
npm run build
```

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

This repo ships a `.mcp.json` at its root so that, when you run `claude` from inside a clone, the server is registered automatically as a **project-scope** server — no manual config needed. After `npm run build`, just launch Claude Code from the repo directory and approve the server when prompted.

The entrypoint is written as:

```json
"args": ["${CLAUDE_PROJECT_DIR:-.}/build/index.js"]
```

`CLAUDE_PROJECT_DIR` is the variable Claude Code injects into a project/user-scoped server's environment, and it resolves to the repo root. **You must launch `claude` from inside the repo** for this to work — the bare `.` fallback is only a last resort and is *not* reliable, because it resolves against the launching process's working directory, not the repo.

> **Why not `${CLAUDE_PLUGIN_ROOT}`?** `CLAUDE_PLUGIN_ROOT` is set **only** for marketplace plugin installs, never for a project-scope clone, so it can't drive the clone workflow. Conversely, a plugin install can't use `CLAUDE_PROJECT_DIR` (in a plugin, that points at the *user's* project, not the plugin's own directory). Claude Code does **not** support nested defaults like `${CLAUDE_PLUGIN_ROOT:-${CLAUDE_PROJECT_DIR:-.}}`, so a single entrypoint string cannot serve both contexts. The two distribution paths are therefore decoupled: the **plugin** carries its own MCP config in `.claude-plugin/plugin.json` (using `${CLAUDE_PLUGIN_ROOT}`), while the root `.mcp.json` is dedicated to the **clone** workflow (using `${CLAUDE_PROJECT_DIR:-.}`). Because `plugin.json` declares its own `mcpServers`, the plugin does not also auto-load the root `.mcp.json`, so there is no double-registration.

> **Heads-up on scope precedence:** project-scope (`.mcp.json`) outranks user-scope. If you *also* have an `apple-mail` entry registered at user scope (e.g. an absolute path in `~/.claude.json`), the project-scope entry wins and the user-scope one is ignored entirely. Pick one — for local development on this repo, the project-scope `.mcp.json` is the intended source. To pin a specific local build instead, register it at **local** scope (`claude mcp add apple-mail -s local -- node /abs/path/build/index.js`), which outranks project scope.

---

## Security and Privacy

- **Local only** - All operations happen locally via AppleScript. No data is sent to external servers.
- **Permission required** - macOS will prompt for automation permission on first use.
- **No credential storage** - The server doesn't store any passwords or authentication tokens.
- **Email safety** - Use `create-draft` to review emails before sending.

---

## Known Limitations

| Limitation | Reason |
|------------|--------|
| macOS only | Apple Mail and AppleScript are macOS-specific |
| No sending HTML email | Emails are sent as plain text; reading HTML content is supported |
| Attachments require absolute paths | File attachments must use full absolute paths (e.g., `/Users/me/file.pdf`) |
| No smart mailboxes | Cannot access Smart Mailboxes via AppleScript |
| Very large mailboxes not searchable | Apple Mail's AppleScript bridge times out on mailboxes with tens of thousands of messages, so unscoped `search-messages` skips mailboxes above `APPLE_MAIL_MAX_SEARCH_MAILBOX` (default 5000) and reports them as a partial result. Scope with `mailbox` + a date window to search inside one. ([#24](https://github.com/sweetrb/apple-mail-mcp/issues/24)) |
| Can't delete/rename server-side mailboxes or mutate drafts | Mail.app's AppleScript bridge can only `delete`/`rename` **local "On My Mac"** mailboxes and cannot delete/move drafts — it throws `AppleEvent handler failed` for IMAP/Gmail/Workspace/iCloud/Exchange mailboxes and drafts (the GUI can do it). `delete-mailbox`/`rename-mailbox`/`delete-message`/`move-message` now return a clear "do it in Mail.app directly" error in that case instead of a generic failure. ([#42](https://github.com/sweetrb/apple-mail-mcp/issues/42)) |
| In-memory templates | Email templates are not persisted across server restarts |
| Numeric-only message IDs | Message IDs must contain only digits (validated by schema) |
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

See [#7](https://github.com/sweetrb/apple-mail-mcp/issues/7) for full details and the list of approaches that were tested.

### Backslash Escaping (Important for AI Agents)

When sending content containing backslashes (`\`) to this MCP server, **you must escape them as `\\`** in the JSON parameters.

**Why:** The MCP protocol uses JSON for parameter passing. In JSON, a single backslash is an escape character. To include a literal backslash in content, it must be escaped as `\\`.

**Example - Email with file path:**
```json
{
  "to": ["colleague@company.com"],
  "subject": "File Location",
  "body": "The file is at C:\\\\Users\\\\Documents\\\\report.pdf"
}
```

The `\\\\` in JSON becomes `\\` in the actual string, which represents a single `\` in the email.

**Common patterns requiring escaping:**
- Windows paths: `C:\Users\` → `C:\\\\Users\\\\` in JSON
- Shell escaped spaces: `Mobile\ Documents` → `Mobile\\\\ Documents` in JSON
- Regex patterns: `\d+` → `\\\\d+` in JSON

**If you see errors** when sending emails with backslashes, double-check that backslashes are properly escaped in the JSON payload.

---

## Troubleshooting

### "Mail.app not responding"
- Ensure Mail.app is not frozen
- Try opening Mail.app manually
- Restart the MCP server

### "Permission denied"
- macOS needs automation permission
- Go to System Preferences > Privacy & Security > Automation
- Ensure your terminal/Claude has permission to control Mail

### "Message not found"
- Message may have been deleted or moved
- Message IDs change if the message is moved between mailboxes
- Use `search-messages` to find the current message ID

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

### `apple-mail` server fails to connect when run from a clone
- The root `.mcp.json` resolves its entrypoint via `${CLAUDE_PROJECT_DIR:-.}/build/index.js`. **Launch `claude` from inside the repo directory** — `CLAUDE_PROJECT_DIR` only resolves to the repo root in that case; the bare `.` fallback uses the launching shell's working directory and will point at the wrong place otherwise.
- Run `npm run build` first — the server is `build/index.js`, which doesn't exist until you build.
- Run `claude mcp list` to check status. If you see a *conflicting scopes* warning for `apple-mail`, you have it registered at more than one scope; project-scope wins. See [Running from a clone](#running-from-a-clone-in-claude-code-project-scope-mcpjson) for how scope precedence resolves.
- If `claude mcp get apple-mail` shows **⏸ Pending approval**, approve the project-scope server (Claude Code prompts on startup, or run it again after approving).

---

## Development

```bash
npm install            # Install dependencies
npm run build          # Compile TypeScript
npm test               # Run unit tests
npm run test:integration  # Run integration tests (requires Mail.app)
npm run test:all       # Run all tests (unit + integration)
npm run lint           # Check code style
npm run format         # Format code
```

---

## Author

**Rob Sweet** - President, [Superior Technologies Research](https://www.superiortech.io)

A software consulting, contracting, and development company.

- Email: rob@superiortech.io
- GitHub: [@sweetrb](https://github.com/sweetrb)

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Related Projects

- [apple-notes-mcp](https://github.com/sweetrb/apple-notes-mcp) — MCP server for Apple Notes
- [apple-numbers-mcp](https://github.com/sweetrb/apple-numbers-mcp) — MCP server for Apple Numbers spreadsheets
- [apple-photos-mcp](https://github.com/sweetrb/apple-photos-mcp) — MCP server for Apple Photos
