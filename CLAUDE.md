# CLAUDE.md - Apple Mail MCP Server

This file provides guidance for AI agents (Claude, etc.) when using this MCP server.

## Overview

This MCP server enables AI assistants to interact with Apple Mail on macOS via AppleScript. All operations are local - no data leaves the user's machine.

> ⚠️ **Work in Progress** - Many tools are stubbed and not yet functional.

## Tool Usage Tips

### Message Operations

#### search-messages
- Use `query` for general text search across subject, sender, content
- Use `from` to filter by sender email address
- Use `subject` for subject line matching
- Combine `mailbox` and `account` to narrow search scope
- Default limit is 50 messages

#### send-email
- `to` must be an array of email addresses, even for single recipient
- `body` is plain text by default
- Specify `account` to send from a specific account

#### mark-as-read / mark-as-unread / flag-message / delete-message
- All require a message `id`
- Get message IDs from `search-messages` or `list-messages`

#### move-message
- Requires message `id` and destination `mailbox` name
- Specify `account` if mailbox is in a specific account

### Mailbox Operations

#### list-mailboxes
- Returns all mailboxes (folders) for an account
- Common mailboxes: INBOX, Sent, Drafts, Trash, Junk, Archive

#### get-unread-count
- Omit parameters to get total unread across all accounts
- Specify `mailbox` for specific folder count

### Multi-account

- Use `list-accounts` to see available accounts
- Pass `account` parameter to target specific account
- Default account is typically the first configured account

## Error Handling

| Error | Likely Cause |
|-------|--------------|
| "Mail.app not responding" | Mail.app frozen or not running |
| "Message not found" | Message ID is invalid or message was deleted |
| "Permission denied" | macOS automation permission needed |
| "Account not found" | Account name doesn't match exactly |

## Security Considerations

- **Sending emails**: Always confirm with user before sending
- **Deleting messages**: Warn user that deletion may be permanent
- **Reading emails**: May contain sensitive information

## Example Workflows

### Check for important emails
```
1. list-accounts → get available accounts
2. search-messages from="boss@company.com" → find emails from boss
3. get-message id="..." → read the full content
```

### Send a reply
```
1. get-message id="..." → read original
2. send-email to=["sender@..."] subject="Re: ..." body="..."
```

### Organize inbox
```
1. search-messages isRead=false → find unread
2. For each: get-message, then move-message to appropriate folder
```
