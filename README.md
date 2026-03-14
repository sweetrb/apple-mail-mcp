# Apple Mail MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that enables AI assistants like Claude to read, send, search, and manage emails in Apple Mail on macOS.

[![npm version](https://img.shields.io/npm/v/apple-mail-mcp)](https://www.npmjs.com/package/apple-mail-mcp)
[![CI](https://github.com/sweetrb/apple-mail-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sweetrb/apple-mail-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

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
| `mailbox` | string | No | Mailbox to search in (default: INBOX) |
| `account` | string | No | Account to search in (omit to search all accounts) |
| `isRead` | boolean | No | Filter by read status |
| `isFlagged` | boolean | No | Filter by flagged status |
| `dateFrom` | string | No | Start date filter (e.g., "January 1, 2026") |
| `dateTo` | string | No | End date filter (e.g., "March 1, 2026") |
| `limit` | number | No | Max results (default: 50) |

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
| `mailbox` | string | No | Mailbox name (default: INBOX) |
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
| `account` | string | No | Send from specific account |
| `attachments` | string[] | No | Absolute file paths to attach (e.g., `["/Users/me/report.pdf"]`) |

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
| `attachments` | string[] | No | Absolute file paths to attach |

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

All batch operations accept an array of message IDs and return per-item success/failure results.

#### `batch-delete-messages`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string[] | Yes | Message IDs to delete |

#### `batch-move-messages`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string[] | Yes | Message IDs to move |
| `mailbox` | string | Yes | Destination mailbox |
| `account` | string | No | Account containing mailbox |

#### `batch-mark-as-read` / `batch-mark-as-unread`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string[] | Yes | Message IDs |

#### `batch-flag-messages` / `batch-unflag-messages`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string[] | Yes | Message IDs |

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
AI: [calls list-messages with mailbox="INBOX"]
    "You have 12 messages in your inbox. Here are the most recent..."

User: "Show me emails from Sarah"
AI: [calls search-messages with query="Sarah"]
    "Found 3 emails from Sarah..."

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
| In-memory templates | Email templates are not persisted across server restarts |

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

### "Account not found"
- Account names must match exactly (case-sensitive)
- Use `list-accounts` to see exact account names

### "Failed to send email"
- Check your network connection
- Verify Mail.app can send emails manually
- Check if the account is configured correctly in Mail.app

---

## Development

```bash
npm install      # Install dependencies
npm run build    # Compile TypeScript
npm test         # Run test suite (28 tests)
npm run lint     # Check code style
npm run format   # Format code
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

- [apple-notes-mcp](https://github.com/sweetrb/apple-notes-mcp) - MCP server for Apple Notes
