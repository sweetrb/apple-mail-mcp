# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x.x   | :white_check_mark: |

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

## Email Security Best Practices

When using this server with AI assistants:
- Always review email content before sending
- Be cautious with auto-send functionality
- Monitor sent emails periodically
- Report any unexpected behavior immediately
