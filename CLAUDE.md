# CLAUDE.md - Apple Mail MCP Server

This file provides guidance for AI agents (Claude, etc.) when using this MCP server.

## Overview

This MCP server enables AI assistants to interact with Apple Mail on macOS via AppleScript. All operations are local - no data leaves the user's machine.

## Critical: Backslash Escaping

**When sending content with backslashes to any tool, you MUST escape them.**

The MCP protocol uses JSON for parameters. In JSON, `\` is an escape character. To include a literal backslash:

| You want    | Send in JSON parameter |
|-------------|------------------------|
| `\`         | `\\`                   |
| `\\`        | `\\\\`                 |
| `C:\Users\` | `C:\\Users\\`          |

### Why This Matters

If you send a single backslash without escaping:

- The JSON parser interprets `\` as an escape sequence
- Invalid sequences like `\ ` (backslash-space) cause silent failures
- The email send/draft may fail with no clear error

### Examples

**Correct - Windows path in email:**

```text
body: "The file is at C:\\Users\\Documents\\report.pdf"
```

**Incorrect - Will fail:**

```text
body: "The file is at C:\Users\Documents\report.pdf"
```

## Tool Usage Tips

### Using Message IDs (Required)

All message operations require an `id` parameter. **Always get IDs first** using `list-messages` or `search-messages`:

```text
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
- Both support optional `attachments` parameter (array of absolute file paths)
- **Recommendation**: For important emails, use `create-draft` and tell the user to review in Mail.app

### send-serial-email (mail merge)

- Sends individual personalized emails to a list of recipients
- Use `{{placeholder}}` tokens in subject and body, replaced per-recipient
- Each recipient gets their own email — recipients don't see each other
- Max 100 recipients per batch, delay between sends (default 500ms, max 10000ms)
- Example variables: `{ "Name": "Alice", "Company": "Acme" }`

### reply-to-message

- Set `replyAll: true` to reply to all recipients
- Set `send: false` to save as draft instead of sending immediately
- Default behavior: reply to sender only, send immediately
- **Transport (v2.5.0):** when SMTP is configured, sends via **clean direct SMTP**, threading the reply with proper RFC 5322 `In-Reply-To`/`References` headers (built from the original) so it stays in the same conversation. Falls back to Mail.app's AppleScript `reply … without opening window` when SMTP isn't configured (or the original lacks the headers needed to thread). The `without opening window` path opens no compose window, which ensures reliable body delivery from background processes (see [Known Issues](#known-issue-resolved-reply--forward-empty-body-from-background-processes) below)

### forward-message

- Requires message `id` and `to` array
- Optional `body` to prepend a message
- Set `send: false` to save as draft
- **Transport (v2.5.0):** when SMTP is configured, sends via **clean direct SMTP** (a forward starts a new conversation — no threading headers). Falls back to AppleScript `forward … without opening window` when SMTP isn't configured — same background-process fix as reply-to-message

### Multi-account

- Default account is Mail.app's configured default send account
- `search-messages` searches all accounts when no `account` is specified
- Use `list-accounts` to see available accounts
- Pass `account` parameter to target specific account
- **Reads prefer direct IMAP when configured (v2.6.0).** When any `APPLE_MAIL_MCP_IMAP_*` account is configured, the read tools (`search-messages`, `get-thread`, `list-messages`, `list-mailboxes`, `get-unread-count`, `get-mail-stats`) go to IMAP instead of AppleScript:
  - explicit IMAP `account` → that account over IMAP (fast, server-side);
  - explicit non-IMAP `account` → AppleScript;
  - **no `account` → merge across all accounts**: the query fans out over every configured IMAP account, and AppleScript runs **only for the accounts no IMAP config covers** (the account list is partitioned — IMAP-served accounts aren't re-scanned; if all accounts are IMAP, AppleScript is skipped entirely). Message lists de-dup messages seen in both backends (preferring the IMAP copy and its `imap:` id) and sort newest-first; count tools count each account via exactly one backend so a coverage mismatch can never double-count.
  - With IMAP unconfigured, reads behave exactly as before (pure AppleScript). The mailbox-write ops (`create`/`delete`/`rename-mailbox`) still route to IMAP only for an explicitly-named IMAP account.

## Error Handling

| Error                    | Likely Cause                                  |
|--------------------------|-----------------------------------------------|
| "Mail.app not responding" | Mail.app frozen or not running               |
| "Message not found"      | Message ID is invalid or message was deleted/moved |
| "Permission denied"      | macOS automation permission needed            |
| "Account not found"      | Account name doesn't match exactly (case-sensitive) |
| "Failed to send email"   | Network issue or Mail.app configuration problem |
| Silent failure           | Backslash not escaped in content              |

## Security Considerations

- **Sending emails**: Always confirm with user before sending. Recommend `create-draft` for review.
- **Deleting messages**: Warn user that deletion moves to Trash (can be recovered).
- **Reading emails**: May contain sensitive information - summarize rather than display full content when appropriate.

## Example Workflows

### Check for important emails

```text
1. list-accounts → get available accounts
2. search-messages query="boss@company.com" → find emails from boss
3. get-message id="..." → read the full content
```

### Send a reply safely

```text
1. get-message id="..." → read original message
2. reply-to-message id="..." body="..." send=false → save as draft
3. Tell user to review in Mail.app before sending
```

### Compose and send

```text
1. create-draft to=["recipient@example.com"] subject="..." body="..."
2. Tell user: "I've created a draft. Review it in Mail.app and send when ready."
   OR if user confirms they want to send immediately:
3. send-email to=["recipient@example.com"] subject="..." body="..."
```

### Forward an email

```text
1. get-message id="..." → read the message to forward
2. forward-message id="..." to=["colleague@company.com"] body="FYI - see below"
```

### Organize inbox

```text
1. search-messages query="newsletter" → find newsletters
2. For each: move-message id="..." mailbox="Archive"
```

### Batch operations (efficient for multiple messages)

```text
1. search-messages query="old" → find messages to clean up
2. batch-delete-messages ids=["123", "456", "789"] → delete multiple
   OR
   batch-move-messages ids=["123", "456"] mailbox="Archive" → archive multiple
   OR
   batch-mark-as-read ids=["123", "456"] → mark multiple as read
   OR
   batch-mark-as-unread ids=["123", "456"] → mark multiple as unread
   OR
   batch-flag-messages ids=["123", "456"] → flag multiple
   OR
   batch-unflag-messages ids=["123", "456"] → unflag multiple
   Note: all batch operations are limited to 100 messages per request
```

### Check for attachments

```text
1. list-messages mailbox="INBOX" → get message IDs
2. list-attachments id="..." → see attachments (name, MIME type, size)
3. save-attachment id="..." attachmentName="report.pdf" savePath="/tmp" → save to disk
```

### Manage mailboxes

```text
1. list-mailboxes → see all folders
2. create-mailbox name="Projects" → create new folder
3. rename-mailbox oldName="Projects" newName="Active Projects" → rename
4. delete-mailbox name="Old Folder" → delete
```

### Work with mail rules

```text
1. list-rules → see all rules and their status
2. disable-rule name="Newsletter Filter" → turn off a rule
3. enable-rule name="Newsletter Filter" → turn it back on
```

### Look up contacts

```text
1. search-contacts query="John" → find contacts by name
   Returns names, email addresses, and phone numbers from Contacts.app
```

### Use email templates

```text
1. save-template name="Weekly Report" subject="Weekly Report" body="..." to=["team@..."]
2. list-templates → see saved templates
3. use-template id="tmpl_1" → create draft from template
4. use-template id="tmpl_1" to=["other@..."] → override recipients
   Note: templates persist to disk (APPLE_MAIL_MCP_TEMPLATES_FILE) and survive restarts
```

### Send email with attachments

```text
1. send-email to=["colleague@company.com"] subject="Report" body="See attached." attachments=["/Users/me/report.pdf"]
   OR to let the user review first:
2. create-draft to=["colleague@company.com"] subject="Report" body="See attached." attachments=["/Users/me/report.pdf"]
   Note: attachment paths must be absolute and the files must exist; max 20 files per message
```

### Send personalized emails (mail merge)

```text
1. send-serial-email recipients=[
     {"email": "alice@acme.com", "variables": {"Name": "Alice", "Company": "Acme"}},
     {"email": "bob@globex.com", "variables": {"Name": "Bob", "Company": "Globex"}}
   ] subject="Hello {{Name}}" body="Great to connect about {{Company}}."
   Each recipient gets their own individual email with placeholders replaced.
```

### Check mail sync status

```text
1. get-sync-status → see if Mail.app is running and syncing
2. get-mail-stats → see total/unread counts and recently received counts
```

## Known Issue (Resolved): Reply / Forward Empty Body from Background Processes

### The Problem

Prior to v1.4.0, `reply-to-message` and `forward-message` would send replies/forwards with **empty body text** when the MCP server was running as a background process (e.g., spawned via `execSync` from a Node.js MCP server, which is how Claude Code invokes it).

The root cause was the AppleScript `reply msg with opening window` command. This creates a GUI compose window asynchronously. When `set content` runs immediately after, the window may not be ready yet, and the content assignment is **silently ignored**. Even adding delays (`delay 1`, `delay 2`) was unreliable — the compose window's readiness depends on system load, Mail.app state, and whether the process has GUI access.

A secondary issue: the old code appended `& content of theReply` (the original quoted message) to the body. This was always a no-op — the quoted content lives in the HTML layer of the compose window, not the plaintext `content` property.

### The Fix

Replaced `with opening window` with `without opening window` for both `reply` and `forward` commands. With this approach:

- `set content` works **immediately** — no delay needed
- Works reliably from background processes (Node.js `execSync`, MCP stdio transport)
- `In-Reply-To` and `References` headers are still set correctly by Mail.app (the `reply` command knows which message it's replying to)
- No GUI compose window is opened (better for a server process)
- `reply to all` and `send` both work as expected

### Approaches That Were Tested and Failed

| Approach | Result |
|----------|--------|
| `delay 1` / `delay 2` before `set content` | Body still empty from background process (works interactively) |
| `reply msg without opening window` (old attempt) | Previously dismissed, but actually works — `set content` is reliable without the window |
| `set html content` on reply object | AppleScript error — not a valid property |
| System Events UI scripting (keystroke) | Blocked: "osascript is not allowed to send keystrokes" from background process |
| `make new outgoing message` with same subject | Body arrives, but no `In-Reply-To`/`References` headers (can't set `reply id` on outgoing messages) |
| Manual headers on `outgoing message` | Not possible — Mail.app's `outgoing message` class doesn't expose a `headers` property |

### References

- GitHub Issue: [#7 — reply-to-message sends empty body when called from background process](https://github.com/sweetrb/apple-mail-mcp/issues/7)

## Testing Your Understanding

Before sending emails with paths or special characters, verify escaping:

- `~/path/to/file` - No escaping needed (no backslashes)
- `C:\Users\` - Needs escaping: `C:\\Users\\`
- `file\ name.txt` - Needs escaping: `file\\ name.txt`

## Recurring macOS permission prompts → offer the official-Node fix

If a user reports being **repeatedly** prompted for Full Disk Access or
Automation for "node" (especially after a `brew upgrade`), or that this MCP
loses its permissions every so often, the cause is almost always an **ad-hoc
signed Node** (typically Homebrew's) whose cdhash changes on every update, so
macOS TCC keeps treating it as a brand-new binary.

Detect it:

```bash
codesign -dvvv "$(which node)" 2>&1 | grep -E 'Signature=adhoc|TeamIdentifier=not set'
```

If that matches (ad-hoc / no Team ID), **offer to migrate this MCP to the
official Developer-ID-signed Node** per
[`docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md`](docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md):
install an official LTS Node to a stable path (e.g. `~/mcp-runtime/node-current`),
repoint this server's `command` at it, and have the user grant the permission
once — it then persists across Node updates. Do not repoint `npx`-launched
servers that don't need Full Disk Access.
