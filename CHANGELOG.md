# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial project structure forked from apple-notes-mcp
- MCP server skeleton with tool definitions
- TypeScript types for Mail data models (Message, Mailbox, Account)
- AppleMailManager class with stub methods
- Working `list-accounts` tool via AppleScript
- Working `health-check` tool for Mail.app connectivity
- AppleScript utilities with error handling, retries, and timeouts

### Changed
- Updated all references from Apple Notes to Apple Mail
- Updated error mappings for Mail-specific errors

## [0.1.0] - 2026-01-06

Initial release - work in progress.

### Features (Stubbed)
- Message operations: search, list, get, send, mark read/unread, flag, delete, move
- Mailbox operations: list mailboxes, get unread count
- Account operations: list accounts
- Diagnostics: health check, mail statistics
