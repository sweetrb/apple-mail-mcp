# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.x.x   | :white_check_mark: |
| < 2.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it by emailing:

**rob@superiortech.io**

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You will receive a response within 48 hours acknowledging receipt. Security issues will be prioritized and addressed as quickly as possible.

## Security Considerations

This MCP server:
- Runs locally on your machine
- Uses AppleScript to interact with Mail.app, and — when you configure the opt-in IMAP/SMTP backends — connects directly to **your own** mail provider over TLS
- Does not transmit data to this project or any third party. With the default AppleScript backend everything stays on-device; the opt-in IMAP/SMTP backends necessarily reach your provider, which is their purpose
- Does not store credentials or passwords (IMAP/SMTP passwords are read from the macOS Keychain at use time)
- Requires explicit user confirmation before sending emails (recommended)

The server requires macOS automation permissions to function. These permissions are managed by macOS and can be revoked at any time in System Settings > Privacy & Security > Automation.

## Input Validation & Security Hardening

The server enforces multiple layers of input validation to prevent injection and abuse:

### Message ID Validation
Message IDs are validated against `/^(\d+|imap:[A-Za-z0-9_-]+)$/` — either an AppleScript numeric id or an opaque `imap:` token from the IMAP read path. Anything else is rejected before reaching a backend. As defense-in-depth, numeric ids are additionally coerced through `Number(id)` at every AppleScript interpolation point, and `imap:` ids never reach AppleScript at all — they are decoded and used as IMAP UIDs, so they cannot participate in AppleScript injection.

### Batch Operation Limits
Batch operations (`batch-delete-messages`, `batch-move-messages`, `batch-mark-as-read`, `batch-mark-as-unread`, `batch-flag-messages`, `batch-unflag-messages`) are capped at 100 messages per request to prevent resource exhaustion.

### Date Filter Validation
Date filter parameters (`dateFrom`, `dateTo`) are validated to accept only alphanumeric characters and safe punctuation (spaces, commas, slashes, hyphens, colons, periods). An additional `escapeForAppleScript()` call is applied as a belt-and-suspenders safeguard before any date string is interpolated into AppleScript.

### Attachment Save Path Restrictions
The `save-attachment` tool prevents path traversal attacks:
- Save paths are resolved to absolute paths using `path.resolve`
- Only paths within the user's home directory, `/tmp`, `/private/tmp`, and `/Volumes` are allowed
- Attachment filenames containing `/`, `\`, null bytes (`\0`), or `..` are rejected

### Attachment Count Limits
The `send-email` and `create-draft` tools accept a maximum of 20 file attachments per message. The `send-serial-email` tool enforces a maximum of 100 recipients per batch and a maximum inter-send delay of 10,000ms.

## Email Security Best Practices

When using this server with AI assistants:
- Always review email content before sending
- Be cautious with auto-send functionality
- Monitor sent emails periodically
- Report any unexpected behavior immediately
