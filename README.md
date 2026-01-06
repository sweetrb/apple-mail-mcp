# Apple Mail MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that enables AI assistants like Claude to read, send, search, and manage emails in Apple Mail on macOS.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/apple-mail-mcp.svg)](https://www.npmjs.com/package/apple-mail-mcp)

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

### Manual Installation

**1. Clone and build:**
```bash
git clone https://github.com/sweetrb/apple-mail-mcp.git
cd apple-mail-mcp
npm install
npm run build
```

**2. Add to Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
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

**3. Restart Claude Desktop** and start using natural language:
```
"Show me my unread emails"
```

On first use, macOS will ask for permission to automate Mail.app. Click "OK" to allow.

## Requirements

- **macOS** - Apple Mail and AppleScript are macOS-only
- **Node.js 20+** - Required for the MCP server
- **Apple Mail** - Must have at least one account configured

## Features

| Feature | Status | Description |
|---------|--------|-------------|
| **List Messages** | ✅ | List messages in any mailbox |
| **Search Messages** | ✅ | Find emails by sender, subject, content |
| **Read Messages** | ✅ | Get full email content |
| **Send Email** | ✅ | Compose and send new emails |
| **Create Draft** | ✅ | Save emails to Drafts folder |
| **Reply** | ✅ | Reply to messages (with reply-all support) |
| **Forward** | ✅ | Forward messages to new recipients |
| **Mark Read/Unread** | ✅ | Change read status |
| **Flag/Unflag** | ✅ | Flag or unflag messages |
| **Delete Messages** | ✅ | Move messages to trash |
| **Move Messages** | ✅ | Organize into mailboxes |
| **List Mailboxes** | ✅ | Show all folders with counts |
| **List Accounts** | ✅ | Show configured accounts |
| **Unread Count** | ✅ | Get unread counts per mailbox |
| **Health Check** | ✅ | Verify Mail.app connectivity |
| **Statistics** | ✅ | Message and unread counts |

## Tool Reference

### Message Operations

#### `search-messages`
Search for messages matching criteria.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | No | Text to search in subject/sender |
| `mailbox` | string | No | Mailbox to search in (default: INBOX) |
| `account` | string | No | Account to search in |
| `limit` | number | No | Max results (default: 50) |

#### `get-message`
Get the full content of a message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID |

#### `list-messages`
List messages in a mailbox.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mailbox` | string | No | Mailbox name (default: INBOX) |
| `account` | string | No | Account name |
| `limit` | number | No | Max messages (default: 50) |

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

#### `reply-to-message`
Reply to an existing message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID to reply to |
| `body` | string | Yes | Reply body |
| `replyAll` | boolean | No | Reply to all recipients (default: false) |
| `send` | boolean | No | Send immediately (default: true, false = save as draft) |

#### `forward-message`
Forward a message to new recipients.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID to forward |
| `to` | string[] | Yes | Recipients to forward to |
| `body` | string | No | Message to prepend |
| `send` | boolean | No | Send immediately (default: true, false = save as draft) |

#### `mark-as-read` / `mark-as-unread`
Change read status of a message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID |

#### `flag-message` / `unflag-message`
Flag or unflag a message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID |

#### `delete-message`
Delete a message (move to trash).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID |

#### `move-message`
Move a message to a different mailbox.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID |
| `mailbox` | string | Yes | Destination mailbox |
| `account` | string | No | Account containing mailbox |

### Mailbox Operations

#### `list-mailboxes`
List all mailboxes for an account.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account` | string | No | Account to list from |

#### `get-unread-count`
Get unread message count.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mailbox` | string | No | Mailbox to check (omit for total) |
| `account` | string | No | Account to check |

### Account Operations

#### `list-accounts`
List all configured Mail accounts.

**Parameters:** None

### Diagnostics

#### `health-check`
Verify Mail.app connectivity and permissions.

**Parameters:** None

#### `get-mail-stats`
Get mail statistics (total messages, unread counts per account).

**Parameters:** None

## Security and Privacy

- **Local only** - All operations happen locally via AppleScript
- **Permission required** - macOS will prompt for automation permission
- **No credential storage** - The server doesn't store any passwords
- **Email safety** - Review emails before sending via `create-draft` + manual send

## Development

```bash
npm install      # Install dependencies
npm run build    # Compile TypeScript
npm test         # Run test suite
npm run lint     # Check code style
npm run format   # Format code
```

## Author

**Rob Sweet** - President, [Superior Technologies Research](https://www.superiortech.io)

- Email: rob@superiortech.io
- GitHub: [@sweetrb](https://github.com/sweetrb)

## License

MIT License - see [LICENSE](LICENSE) for details.

## Related Projects

- [apple-notes-mcp](https://github.com/sweetrb/apple-notes-mcp) - MCP server for Apple Notes
