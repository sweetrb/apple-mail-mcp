---
name: apple-mail
description: Use this skill when the user wants to manage Apple Mail on macOS - reading, searching, sending, replying to, forwarding, and organizing emails and mailboxes. This skill provides access to Apple Mail through MCP tools.
---

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
| `list-messages` | List messages in a mailbox (all mailboxes if omitted) |
| `search-messages` | Find messages by sender, subject, or content |
| `get-message` | Read the full content of a message |
| `get-thread` | Get the full conversation thread for a message |
| `send-email` | Send a new email immediately |
| `send-serial-email` | Send personalized copies to many recipients (mail merge with `{{Key}}` placeholders) |
| `create-draft` | Save an email to Drafts for review |
| `reply-to-message` | Reply to a message (supports reply-all) |
| `forward-message` | Forward a message to new recipients |
| `mark-as-read` | Mark a message as read |
| `mark-as-unread` | Mark a message as unread |
| `flag-message` | Flag a message for follow-up (optional color) |
| `unflag-message` | Remove flag from a message |
| `delete-message` | Move a message to Trash |
| `move-message` | Move a message to a different mailbox |
| `resolve-message-id` | Convert `imap:` ids to numeric Mail.app ids for the AppleScript reply/forward path. Direct SMTP replies and forwards accept `imap:` ids without conversion. **Not** needed for flag colors: since 2.10.0 `flag-message`/`batch-flag-messages` write the color over IMAP directly |
| `list-attachments` | List a message's attachments (name, MIME type, size) |
| `save-attachment` | Save an attachment to disk |
| `fetch-attachment` | Fetch an attachment's bytes inline as base64 |

### Batch Operations (1-100 ids per call)

| Tool | Purpose |
|------|---------|
| `batch-delete-messages` | Move multiple messages to Trash |
| `batch-move-messages` | Move multiple messages to a mailbox |
| `batch-mark-as-read` | Mark multiple messages as read |
| `batch-mark-as-unread` | Mark multiple messages as unread |
| `batch-flag-messages` | Flag multiple messages (optional color) |
| `batch-unflag-messages` | Remove flags from multiple messages |

### Mailbox Operations

| Tool | Purpose |
|------|---------|
| `list-mailboxes` | List all mailboxes/folders in an account |
| `get-unread-count` | Get count of unread messages |
| `create-mailbox` | Create a new mailbox/folder |
| `delete-mailbox` | Delete a mailbox |
| `rename-mailbox` | Rename a mailbox |

### Account Operations

| Tool | Purpose |
|------|---------|
| `list-accounts` | List configured email accounts |

### Smart Mailbox Operations

Smart mailboxes are **criteria-based virtual views**, not real folders — use these
when the user wants a saved filter/search rather than moving mail. They work on
localized macOS because they edit `SyncedSmartMailboxes.plist` directly (backed up
and atomic; existing smart mailboxes are never rewritten).

| Tool | Purpose |
|------|---------|
| `list-smart-mailboxes` | List smart mailboxes and their criteria |
| `create-smart-mailbox` | Create one (needs at least one of fromContains / subjectContains / bodyContains) |
| `delete-smart-mailbox` | Delete one by name |
| `create-newsletter-smart-mailboxes` | Propose "NL: <sender>" views for newsletter senders — **defaults to `dryRun: true`**; pass `dryRun: false` to actually create them |

Requires Full Disk Access for the Node runtime (`~/Library/Mail` is TCC-protected);
without it these report "no smart mailboxes" rather than a permission error.
Changes appear the next time Mail is launched — **have the user quit Mail first**
for reliable results. These tools never quit or restart Mail themselves.

### Rules

| Tool | Purpose |
|------|---------|
| `list-rules` | List Mail rules and their enabled state |
| `create-rule` | Create a Mail rule (conditions + actions) |
| `enable-rule` | Enable a rule by name |
| `disable-rule` | Disable a rule by name |
| `delete-rule` | Delete a rule by name |

### Contacts

| Tool | Purpose |
|------|---------|
| `search-contacts` | Look up people in macOS Contacts to find their email addresses |

### Templates

| Tool | Purpose |
|------|---------|
| `save-template` | Create or update a reusable email template |
| `list-templates` | List saved templates |
| `get-template` | Read a template's full contents |
| `use-template` | Compose a draft from a template (with overrides) |
| `delete-template` | Delete a template |

### Diagnostics

| Tool | Purpose |
|------|---------|
| `health-check` | Verify Mail.app connectivity |
| `doctor` | Diagnose setup problems (permissions, accounts, IMAP/SMTP) with remediation steps |
| `get-mail-stats` | Get message and unread statistics (one IMAP `STATUS` per mailbox — the priciest read; a `partial: true` result means the totals are floors, see `failedAccounts`) |
| `get-sync-status` | Check whether Mail.app is running and syncing |

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
3. **Account Selection**: Read tools (`list-messages`, `search-messages`) cover all accounts when `account` is omitted; other operations default to Mail's default account (first enabled account as fallback). Use the `account` parameter to target a specific one.
4. **Draft vs Send**: Use `create-draft` when the user wants to review before sending. Recommend this for important emails.
5. **Backslash Escaping**: When email content contains backslashes, escape them as `\\` in the JSON.
6. **macOS Only**: This skill only works on macOS systems.

## Error Handling

- **"Message not found"**: The message ID may be invalid or the message was deleted. Use search-messages to find it again.
- **"Permission denied"**: User needs to grant automation permission in System Settings > Privacy & Security > Automation. Run the `doctor` tool for a full diagnosis.
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


### Preserve reply threading and delivery format

Use `reply-to-message` with the original message id for replies. `send-email`
creates a new conversation; a `Re:` subject alone does not create threading
headers. For clean sending, use `transport: "smtp"` on reply/forward (requires
SMTP setup). Composite `imap:` sources are read directly, without Mail.app
synchronization. Once SMTP is selected, errors do not silently switch delivery
backends. Explicit `transport: "applescript"` keeps the native alternative,
including its known quote-wrapping limitation. For drafts, use `send: false`
with transport omitted or `applescript`, not `smtp`. Read the returned
`transport`; SMTP success may also include the sent `messageId`.

SMTP forwards need a readable plain-text original. HTML-only IMAP messages and
failed Mail.app body reads are rejected before sending, so the original content
cannot silently disappear. Explicit AppleScript forwarding remains available;
do not retry through it automatically. Original attachments are not reattached
by the plain-text SMTP forward path.
