# CLAUDE.md - Apple Mail MCP Server

This file provides guidance for AI agents (Claude, etc.) when using this MCP server.

## Overview

This MCP server enables AI assistants to interact with Apple Mail on macOS via AppleScript. All operations are local - no data leaves the user's machine.

## Critical: Backslash Escaping

**When sending content with backslashes to any tool, you MUST escape them.**

The MCP protocol uses JSON for parameters. In JSON, `\` is an escape character. To include a literal backslash:

| You want | Send in JSON parameter |
|----------|------------------------|
| `\` | `\\` |
| `\\` | `\\\\` |
| `C:\Users\` | `C:\\Users\\` |

### Why This Matters

If you send a single backslash without escaping:
- The JSON parser interprets `\` as an escape sequence
- Invalid sequences like `\ ` (backslash-space) cause silent failures
- The email send/draft may fail with no clear error

### Examples

**Correct - Windows path in email:**
```
body: "The file is at C:\\Users\\Documents\\report.pdf"
```

**Incorrect - Will fail:**
```
body: "The file is at C:\Users\Documents\report.pdf"
```

## Tool Usage Tips

### Using Message IDs (Required)

All message operations require an `id` parameter. **Always get IDs first** using `list-messages` or `search-messages`:

```
# List messages returns IDs
list-messages mailbox="INBOX"
→ Messages with IDs like "12345", "12346", etc.

# Use ID for all subsequent operations
get-message id="12345"
mark-as-read id="12345"
delete-message id="12345"
reply-to-message id="12345" body="Thanks!"
```

### Recipient Arrays

The `to`, `cc`, and `bcc` parameters must always be arrays:

**Correct:**
```json
{
  "to": ["bob@example.com"],
  "subject": "Hello"
}
```

**Incorrect:**
```json
{
  "to": "bob@example.com",
  "subject": "Hello"
}
```

### send-email vs create-draft

- Use `send-email` for immediate sending
- Use `create-draft` when the user should review first
- **Recommendation**: For important emails, use `create-draft` and tell the user to review in Mail.app

### reply-to-message

- Set `replyAll: true` to reply to all recipients
- Set `send: false` to save as draft instead of sending immediately
- Default behavior: reply to sender only, send immediately

### forward-message

- Requires message `id` and `to` array
- Optional `body` to prepend a message
- Set `send: false` to save as draft

### Multi-account

- Default account is typically the first configured
- Use `list-accounts` to see available accounts
- Pass `account` parameter to target specific account

## Error Handling

| Error | Likely Cause |
|-------|--------------|
| "Mail.app not responding" | Mail.app frozen or not running |
| "Message not found" | Message ID is invalid or message was deleted/moved |
| "Permission denied" | macOS automation permission needed |
| "Account not found" | Account name doesn't match exactly (case-sensitive) |
| "Failed to send email" | Network issue or Mail.app configuration problem |
| Silent failure | Backslash not escaped in content |

## Security Considerations

- **Sending emails**: Always confirm with user before sending. Recommend `create-draft` for review.
- **Deleting messages**: Warn user that deletion moves to Trash (can be recovered).
- **Reading emails**: May contain sensitive information - summarize rather than display full content when appropriate.

## Example Workflows

### Check for important emails
```
1. list-accounts → get available accounts
2. search-messages query="boss@company.com" → find emails from boss
3. get-message id="..." → read the full content
```

### Send a reply safely
```
1. get-message id="..." → read original message
2. reply-to-message id="..." body="..." send=false → save as draft
3. Tell user to review in Mail.app before sending
```

### Compose and send
```
1. create-draft to=["recipient@example.com"] subject="..." body="..."
2. Tell user: "I've created a draft. Review it in Mail.app and send when ready."
   OR if user confirms they want to send immediately:
3. send-email to=["recipient@example.com"] subject="..." body="..."
```

### Forward an email
```
1. get-message id="..." → read the message to forward
2. forward-message id="..." to=["colleague@company.com"] body="FYI - see below"
```

### Organize inbox
```
1. search-messages query="newsletter" → find newsletters
2. For each: move-message id="..." mailbox="Archive"
```

### Batch operations (efficient for multiple messages)
```
1. search-messages query="old" → find messages to clean up
2. batch-delete-messages ids=["123", "456", "789"] → delete multiple
   OR
   batch-move-messages ids=["123", "456"] mailbox="Archive" → archive multiple
   OR
   batch-mark-as-read ids=["123", "456"] → mark multiple as read
```

### Check for attachments
```
1. list-messages mailbox="INBOX" → get message IDs
2. list-attachments id="..." → see attachments (name, MIME type, size)
```

### Check mail sync status
```
1. get-sync-status → see if Mail.app is running and syncing
2. get-mail-stats → see total/unread counts and recently received counts
```

## Testing Your Understanding

Before sending emails with paths or special characters, verify escaping:

- `~/path/to/file` - No escaping needed (no backslashes)
- `C:\Users\` - Needs escaping: `C:\\Users\\`
- `file\ name.txt` - Needs escaping: `file\\ name.txt`
