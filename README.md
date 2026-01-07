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

| Feature | Description |
|---------|-------------|
| **List Messages** | List messages in any mailbox |
| **Search Messages** | Find emails by sender, subject, content |
| **Read Messages** | Get full email content |
| **Send Email** | Compose and send new emails |
| **Create Draft** | Save emails to Drafts folder |
| **Reply** | Reply to messages (with reply-all support) |
| **Forward** | Forward messages to new recipients |
| **Mark Read/Unread** | Change read status |
| **Flag/Unflag** | Flag or unflag messages |
| **Delete Messages** | Move messages to trash |
| **Move Messages** | Organize into mailboxes |
| **List Mailboxes** | Show all folders with counts |
| **List Accounts** | Show configured accounts |
| **Unread Count** | Get unread counts per mailbox |
| **Health Check** | Verify Mail.app connectivity |
| **Statistics** | Message and unread counts |

---

## Tool Reference

This section documents all available tools. AI agents should use these tool names and parameters exactly as specified.

### Message Operations

#### `search-messages`

Search for messages matching criteria.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | No | Text to search in subject/sender |
| `mailbox` | string | No | Mailbox to search in (default: INBOX) |
| `account` | string | No | Account to search in |
| `limit` | number | No | Max results (default: 50) |

---

#### `get-message`

Get the full content of a message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID |

**Returns:** Subject line and plain text body of the message.

---

#### `list-messages`

List messages in a mailbox.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mailbox` | string | No | Mailbox name (default: INBOX) |
| `account` | string | No | Account name |
| `limit` | number | No | Max messages (default: 50) |

**Returns:** List of messages with ID, subject, sender, date, read status, and flagged status.

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

**Example:**
```json
{
  "to": ["colleague@company.com"],
  "subject": "Meeting Tomorrow",
  "body": "Hi, just confirming our meeting at 2pm tomorrow.",
  "account": "Work"
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

### Mailbox Operations

#### `list-mailboxes`

List all mailboxes for an account.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account` | string | No | Account to list from |

**Returns:** List of mailbox names with unread counts.

---

#### `get-unread-count`

Get unread message count.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mailbox` | string | No | Mailbox to check (omit for total) |
| `account` | string | No | Account to check |

---

### Account Operations

#### `list-accounts`

List all configured Mail accounts.

**Parameters:** None

**Returns:** List of account names (e.g., "iCloud", "Gmail", "Exchange").

---

### Diagnostics

#### `health-check`

Verify Mail.app connectivity and permissions.

**Parameters:** None

**Returns:** Status of all health checks (app running, permissions, account access).

---

#### `get-mail-stats`

Get mail statistics (total messages, unread counts per account).

**Parameters:** None

**Returns:** Total counts and per-account breakdown.

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

By default, operations use the first configured account. To work with specific accounts:

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
| Plain text only | Email body is plain text; HTML formatting not supported |
| No attachments | Cannot add or read attachments via AppleScript |
| Message ID scope | Message IDs are searched across all mailboxes (may be slow with large mailboxes) |
| No smart mailboxes | Cannot access Smart Mailboxes via AppleScript |

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
