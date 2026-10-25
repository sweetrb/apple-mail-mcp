# Apple Mail in Codex

This guide describes the existing local plugin and the capabilities available in
`apple-mail-mcp` 2.20.30. The plugin packages the Apple Mail skill, assets, and MCP
configuration. It launches an exactly pinned npm release through `npx`; it does
not install Node.js or add mail accounts. Google sign-in is an explicit optional
[local setup step](GMAIL-OAUTH.md), separate from plugin installation.

## Install the plugin

Use a Mac with Node.js 20 or later, the Codex CLI, and at least one enabled
account in Mail.app. The MCP process must run on that Mac to access Mail.app.

```bash
codex plugin marketplace add sweetrb/apple-mail-mcp
codex plugin add apple-mail@apple-mail-mcp
```

Start a new Codex session after installation. The plugin supplies its MCP server
configuration; a second manual registration of `apple-mail` is unnecessary. Keep
the packaged release pin rather than replacing it with `@latest` while
troubleshooting. The repository synchronizes that pin with each release.

## Verify access without sending mail

Ask Codex:

> Run the Apple Mail `doctor` tool and explain any setup failures. Do not send or
> change any mail.

On first use, macOS may request permission to automate Mail.app. Grant access
to the process identified in the prompt. Existing grants appear under
**System Settings → Privacy & Security → Automation**. If access stops working
after a Node update, see
[Node runtime and permission stability](NODE-RUNTIME-AND-TCC-PERMISSIONS.md).

`doctor` checks Mail.app reachability and account state, then attempts a
connection to each configured IMAP account. Its SMTP check only reports whether
the required host and user settings are present: it does not authenticate to
SMTP or send a test message. An SMTP "configured" result is not proof that a
send will succeed.

IMAP and SMTP are optional. Their absence produces warnings even when the
default Mail.app backend is usable. Resolve any Mail.app failures, then ask
Codex to list accounts and read a small selection from the intended inbox.

## Optional direct-provider access

The default backend uses AppleScript and accounts already signed into Mail.app;
it needs no additional mailbox password. IMAP adds direct server-side reads and
mailbox operations, while SMTP adds direct sending. Both support password
authentication, with macOS Keychain as the recommended credential source.
Google accounts can alternatively use [Google Desktop sign-in](GMAIL-OAUTH.md).

Follow the [IMAP / SMTP Setup Guide](IMAP-SETUP.md) for provider settings and
Keychain commands. For a plugin installation, its configuration-file method
avoids editing the installed plugin. The default location is:

```text
~/Library/Application Support/apple-mail-mcp/config.json
```

Keep only non-secret settings there, including account labels, hosts, and
Keychain references. Enter app-specific passwords locally as described in the
guide, never in chat or a plugin manifest. This method requires an account that
permits password authentication; putting an OAuth token in the password field
does not select OAuth. Use the explicit Google authentication settings instead.

Restart the MCP client after configuration changes and rerun `doctor`. Resolve
authentication failures for the affected account without disabling TLS or
substituting another account.

## Troubleshooting quoted message bodies

The Mail.app AppleScript path has a documented macOS 15+ limitation that can
wrap newly authored text in quotation markup. See
[issue #12](https://github.com/sweetrb/apple-mail-mcp/issues/12) for the direct-SMTP
workaround. [PR #329](https://github.com/sweetrb/apple-mail-mcp/pull/329) (2.20.30)
made explicit SMTP fail closed instead of falling back to Mail.app; it does not
fix native delivery, and this guide does not claim otherwise.

SMTP configuration alone does not prove that a particular operation used SMTP.
A native draft is also not a delivery-format workaround. Check the operation's
documented transport and sender behavior, then inspect the received message's
raw MIME and rendered body when verifying delivery. Newly authored text and
intentional quotations of an earlier message must be evaluated separately.

## Authentication boundaries

The local MCP connection, macOS Automation permission, and provider login are
separate. The marketplace's `ON_INSTALL` policy does not implement a provider
sign-in flow. `codex mcp login` is not a setup command for this local stdio
server; [Codex MCP OAuth](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
applies to HTTP MCP connections.

A repository marketplace distributes the local plugin. It does not establish
universal-directory publication or make a Mac's Mail.app available to cloud or
mobile sessions. The [guided setup and OAuth proposal](CODEX-PLUGIN-AUTH-PROPOSAL.md)
describes possible future work, not additional features available today.
