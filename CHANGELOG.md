# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-01-06

First stable release with full Apple Mail integration.

### Features

#### Message Operations
- **search-messages** - Search messages by query, sender, subject with filtering options
- **list-messages** - List messages in any mailbox with pagination
- **get-message** - Retrieve full message content (subject, body, metadata)
- **send-email** - Send emails with To, CC, BCC recipients from any account
- **create-draft** - Save emails to Drafts folder without sending
- **reply-to-message** - Reply to messages with reply-all support, send or save as draft
- **forward-message** - Forward messages to new recipients with optional body
- **mark-as-read** / **mark-as-unread** - Toggle message read status
- **flag-message** / **unflag-message** - Toggle message flagged status
- **delete-message** - Move messages to Trash
- **move-message** - Organize messages into mailboxes

#### Mailbox Operations
- **list-mailboxes** - List all mailboxes/folders with unread counts
- **get-unread-count** - Get unread count for specific mailbox or all accounts

#### Account Operations
- **list-accounts** - List all configured Mail accounts

#### Diagnostics
- **health-check** - Verify Mail.app connectivity and permissions
- **get-mail-stats** - Get message and unread counts per account

### Technical
- Full AppleScript integration with proper escaping and error handling
- Retry logic with exponential backoff for transient failures
- User-friendly error messages with actionable suggestions
- Debug logging support (set DEBUG=1 or VERBOSE=1)
- 60-second timeout for message search operations
- Message ID lookup across all mailboxes for reliable operations

## [0.1.0] - 2026-01-06

Initial release - project skeleton.

### Added
- Initial project structure forked from apple-notes-mcp
- MCP server skeleton with tool definitions
- TypeScript types for Mail data models
- AppleScript utilities with error handling
