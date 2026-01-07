# Apple Mail Skill

This skill enables you to manage Apple Mail on macOS through natural language. Use it whenever the user mentions email, wants to send messages, or needs to read, search, or organize their inbox.

## When to Use This Skill

Use this skill when the user:

- Wants to check their email or inbox
- Asks to find or search for emails
- Wants to read a specific email message
- Needs to send an email or reply to one
- Wants to create a draft email for review
- Asks to forward an email to someone
- Wants to mark emails as read/unread or flag them
- Asks to delete or move emails
- Mentions Apple Mail, Mail app, inbox, or "my email"

## Available Tools

### Message Operations

| Tool | Purpose |
|------|---------|
| `list-messages` | List messages in a mailbox (default: INBOX) |
| `search-messages` | Find messages by sender, subject, or content |
| `get-message` | Read the full content of a message |
| `send-email` | Send a new email immediately |
| `create-draft` | Save an email to Drafts for review |
| `reply-to-message` | Reply to a message (supports reply-all) |
| `forward-message` | Forward a message to new recipients |
| `mark-as-read` | Mark a message as read |
| `mark-as-unread` | Mark a message as unread |
| `flag-message` | Flag a message for follow-up |
| `unflag-message` | Remove flag from a message |
| `delete-message` | Move a message to Trash |
| `move-message` | Move a message to a different mailbox |

### Mailbox Operations

| Tool | Purpose |
|------|---------|
| `list-mailboxes` | List all mailboxes/folders in an account |
| `get-unread-count` | Get count of unread messages |

### Account Operations

| Tool | Purpose |
|------|---------|
| `list-accounts` | List configured email accounts |

### Diagnostics

| Tool | Purpose |
|------|---------|
| `health-check` | Verify Mail.app connectivity |
| `get-mail-stats` | Get message and unread statistics |

## Usage Patterns

### Checking Email

When the user wants to see their inbox:

```
User: "Check my email"
Action: Use list-messages with mailbox="INBOX"

User: "Do I have any unread emails?"
Action: Use get-unread-count, then list-messages if they want details
```

### Finding Emails

When the user wants to find specific emails:

```
User: "Find emails from Sarah"
Action: Use search-messages with query="Sarah"

User: "Search for emails about the project deadline"
Action: Use search-messages with query="project deadline"
```

### Reading Emails

When the user wants to see email content:

```
User: "Show me that email from John"
Action: First search-messages to find it, then get-message with the ID
```

### Sending Emails

When the user wants to send an email:

```
User: "Send an email to bob@example.com about the meeting"
Action: Use send-email with to=["bob@example.com"], appropriate subject and body

User: "Draft an email to the team" (wants to review first)
Action: Use create-draft, then tell user to review in Mail.app
```

### Replying and Forwarding

When the user wants to respond to emails:

```
User: "Reply to that email"
Action: Use reply-to-message with the message ID and body

User: "Reply all with my thoughts"
Action: Use reply-to-message with replyAll=true

User: "Forward this to my colleague"
Action: Use forward-message with the message ID and recipient
```

### Organizing Email

When the user wants to organize:

```
User: "Mark that as read"
Action: Use mark-as-read with the message ID

User: "Move these newsletters to Archive"
Action: Use move-message with mailbox="Archive"

User: "Delete that spam"
Action: Use delete-message with the message ID
```

## Important Guidelines

1. **Message IDs**: All message operations require an ID. Get IDs from `list-messages` or `search-messages` first.
2. **Recipient Arrays**: The `to`, `cc`, and `bcc` parameters must be arrays, even for single recipients: `["email@example.com"]`
3. **Default Account**: Operations default to the first configured account. Use `account` parameter for others.
4. **Draft vs Send**: Use `create-draft` when the user wants to review before sending. Recommend this for important emails.
5. **Backslash Escaping**: When email content contains backslashes, escape them as `\\` in the JSON.
6. **macOS Only**: This skill only works on macOS systems.

## Error Handling

- **"Message not found"**: The message ID may be invalid or the message was deleted. Use search-messages to find it again.
- **"Permission denied"**: User needs to grant automation permission in System Preferences > Privacy & Security > Automation.
- **"Account not found"**: Account names are case-sensitive. Use list-accounts to see exact names.
- **"Failed to send"**: Check network connection and Mail.app configuration.

## Examples

### Quick inbox check
```
User: "Any important emails today?"
→ list-messages to see recent messages
→ Summarize senders and subjects for user
```

### Email workflow
```
User: "Reply to Sarah's email about the budget"
→ 1. search-messages query="Sarah budget"
→ 2. get-message to read content
→ 3. reply-to-message with user's response
```

### Safe sending pattern
```
User: "Send an email to the client about the delay"
→ 1. create-draft with the composed email
→ 2. Tell user: "I've created a draft. Please review it in Mail.app before sending."
```

### Multi-account usage
```
User: "Check my work email"
→ 1. list-accounts to find work account name
→ 2. list-messages with account="Work Exchange"
```
