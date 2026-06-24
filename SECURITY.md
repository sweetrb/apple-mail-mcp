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
- Uses AppleScript to interact with Mail.app
- Does not transmit data to external servers
- Does not store credentials or passwords
- Requires explicit user confirmation before sending emails (recommended)

The server requires macOS automation permissions to function. These permissions are managed by macOS and can be revoked at any time in System Preferences > Privacy & Security > Automation.

## Input Validation & Security Hardening

The server enforces multiple layers of input validation to prevent injection and abuse:

### Message ID Validation
All message IDs are validated against a numeric-only schema (`/^\d+$/`). Non-numeric IDs are rejected before reaching AppleScript. As a defense-in-depth measure, all ID values are also coerced through `Number(id)` at every AppleScript interpolation point.

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
