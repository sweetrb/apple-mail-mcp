# Apple Mail MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that enables AI assistants like Claude to read, send, search, and manage emails in Apple Mail on macOS.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> ⚠️ **Work in Progress** - This project is in early development. Many features are stubbed out and not yet implemented.

## What is This?

This server acts as a bridge between AI assistants and Apple Mail. Once configured, you can ask Claude (or any MCP-compatible AI) to:

- "Check my inbox for unread messages"
- "Find emails from john@example.com"
- "Send an email to the team about the meeting"
- "Move old newsletters to the Archive folder"
- "What emails do I have flagged?"

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

## Features (Planned)

| Feature | Status | Description |
|---------|--------|-------------|
| **List Messages** | 🚧 Stub | List messages in a mailbox |
| **Search Messages** | 🚧 Stub | Find emails by sender, subject, content |
| **Read Messages** | 🚧 Stub | Get full email content |
| **Send Email** | 🚧 Stub | Compose and send new emails |
| **Mark Read/Unread** | 🚧 Stub | Change read status |
| **Flag Messages** | 🚧 Stub | Flag/unflag messages |
| **Delete Messages** | 🚧 Stub | Move messages to trash |
| **Move Messages** | 🚧 Stub | Organize into mailboxes |
| **List Mailboxes** | 🚧 Stub | Show all folders |
| **List Accounts** | ✅ Done | Show configured accounts |
| **Health Check** | ✅ Done | Verify Mail.app connectivity |
| **Statistics** | 🚧 Stub | Unread counts, totals |

## Tool Reference

### Message Operations

#### `search-messages`
Search for messages matching criteria.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | No | Text to search for |
| `from` | string | No | Filter by sender |
| `subject` | string | No | Filter by subject |
| `mailbox` | string | No | Mailbox to search in |
| `account` | string | No | Account to search in |
| `isRead` | boolean | No | Filter by read status |
| `isFlagged` | boolean | No | Filter by flagged status |
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
| `unreadOnly` | boolean | No | Only unread messages |

#### `send-email`
Send a new email.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string[] | Yes | Recipient addresses |
| `subject` | string | Yes | Email subject |
| `body` | string | Yes | Email body |
| `cc` | string[] | No | CC recipients |
| `bcc` | string[] | No | BCC recipients |
| `account` | string | No | Send from account |

#### `mark-as-read` / `mark-as-unread`
Change read status of a message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Message ID |

#### `flag-message`
Flag a message.

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
List all mailboxes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account` | string | No | Account to list from |

#### `get-unread-count`
Get unread message count.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mailbox` | string | No | Mailbox to check |
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
Get mail statistics (total messages, unread counts).

**Parameters:** None

## Security and Privacy

- **Local only** - All operations happen locally via AppleScript
- **Permission required** - macOS will prompt for automation permission
- **No credential storage** - The server doesn't store any passwords

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
