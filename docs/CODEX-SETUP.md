# Apple Mail in Codex

The repository already includes a Codex plugin that packages the Apple Mail
skill, icon, and local MCP configuration. It runs an exactly pinned release of
`apple-mail-mcp` through `npx`. It needs a local Mac and Node.js; installing the
plugin does not install Node, connect a new mail account, or implement OAuth.

## Install the existing plugin

Use macOS with Node.js 20 or later and at least one enabled account in Mail.app.
The MCP process must run on that Mac to use Mail.app.

In Terminal, with the Codex CLI available, run:

```bash
codex plugin marketplace add sweetrb/apple-mail-mcp
codex plugin add apple-mail@apple-mail-mcp
```

Start a new Codex session after installation. The plugin bundles its MCP server
configuration, so a second manual registration of `apple-mail` is unnecessary.
The release pin is maintained by the repository's version-sync script; do not
replace it with `@latest` to troubleshoot setup.

## Check Mail.app access

Ask Codex:

> Run the Apple Mail `doctor` tool and explain any setup failures. Do not send or
> change any mail.

On first use, macOS may ask for permission to automate Mail.app. Grant the
permission for the process shown in that prompt. Existing grants can be checked
under **System Settings → Privacy & Security → Automation**. If permissions stop
working after a Node update, see
[Node runtime and permission stability](NODE-RUNTIME-AND-TCC-PERMISSIONS.md).

`doctor` checks Mail.app reachability and account state. It also attempts a
connection to each configured IMAP account. Its SMTP check reports whether the
required configuration is present; it does **not** authenticate to SMTP or send
a test message. An SMTP "configured" result therefore does not prove that a send
will succeed.

Warnings that IMAP or SMTP is not configured are expected when using the default
Mail.app backend. Direct-provider access is optional. After resolving any
Mail.app failures, ask Codex to list accounts, then select the intended account
for a small inbox read.

## Optional: configure direct IMAP and SMTP access

The default backend uses the accounts already signed into Mail.app through
AppleScript. No additional mailbox password is needed for that path.

IMAP adds direct server-side reads and mailbox operations. SMTP adds direct
sending. They currently use password authentication, with macOS Keychain as the
recommended credential source. Follow the existing
[IMAP / SMTP Setup Guide](IMAP-SETUP.md) for supported provider settings and
Keychain commands.

For a plugin installation, the documented configuration-file method avoids
editing the installed plugin. Its default location is:

```text
~/Library/Application Support/apple-mail-mcp/config.json
```

Store only non-secret settings there, such as account labels, hosts, and Keychain
service/account references. Enter an app-specific password directly through the
local setup flow described in the guide, not in a chat or plugin manifest. Use
only providers and accounts that support that authentication method. An account
that requires OAuth cannot be enabled by pasting a token into the password field.

Restart the MCP client after changing configuration, then run `doctor` again.
An IMAP login failure should be resolved for that account; it is not a reason to
disable TLS or silently select a different account.

## Troubleshooting: newly written text arrives as a quotation

The Mail.app AppleScript path has a documented macOS 15+ limitation that can wrap
the newly authored body in `<blockquote type="cite">`, making an ordinary message
look quoted or forwarded. [Issue #12](https://github.com/sweetrb/apple-mail-mcp/issues/12)
was closed with an SMTP workaround; it does not establish that native sending
was fixed. Recurring quoted-body behavior has been reported with the Codex skill.
That report has not been reproduced in a live Codex delivery test for this guide.

Configuring SMTP alone does not guarantee that every tool call uses it:

- For a supported, authorized send, `transport: "smtp"` explicitly selects direct
  SMTP for `send-email`, `reply-to-message`, `forward-message`, or
  `send-serial-email`. Verify the
  returned `transport` and the intended sender. SMTP bypasses Mail.app's wrapper;
  it does not remove quotation markers already present in the submitted text.
- With `send-email`, omitted `transport` plus a Mail.app account label such as
  `"Work"` or `"iCloud"` selects AppleScript even when SMTP is configured. Explicit
  SMTP does not translate such a label into a different SMTP account: it uses
  the configured SMTP identity. An email-form `account` value is a From override
  subject to the sender restrictions. Confirm that identity before sending.
- A native Mail.app draft is a review step, not a delivery-format workaround.
  `send: false` on reply/forward saves a native draft; combining it with
  `transport: "smtp"` is rejected. Do not promise clean SMTP delivery for a draft
  that will later be sent through Mail.app.
- In 2.20.30, mail merge accepts explicit `transport: "smtp"` and preserves an
  allowed email-form sender override. Explicit SMTP rejects a bare Mail.app
  account label before sending; choose the matching configured SMTP identity or
  an allowed email address. A selected SMTP path stops on configuration,
  credential, or sender-validation failure before either backend sends.
  Earlier releases silently switched to Mail.app on configuration failure and
  ignored SMTP sender overrides. Batch results identify the actual `transport`;
  this does not itself verify delivered formatting. With transport omitted,
  absent SMTP configuration or a Mail.app account label still selects native
  delivery. Explicit `transport: "applescript"` deliberately selects that path.

When diagnosing this issue, inspect both the received message's raw MIME and its
rendered body. The new text should be outside quotation markup. Quoting the
original message in a reply or forward can be intentional and is a different
case. A successful tool response or Sent-folder entry alone does not verify the
recipient's rendering.

## Authentication and availability

The local MCP connection, macOS Automation permission, and direct-provider login
are separate. The marketplace's `ON_INSTALL` authentication policy does not
create a mail-provider sign-in flow. `codex mcp login` is not a setup command for
this local stdio server.

A repository marketplace is a distribution source for the local plugin. It does
not establish publication in OpenAI's universal plugin directory or make a Mac's
Mail.app available to a cloud or mobile session. See
[Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
for host and transport support.

For proposed improvements to guided setup and optional OAuth, see the
[plugin authentication proposal](CODEX-PLUGIN-AUTH-PROPOSAL.md). That document is
a design proposal, not a description of available OAuth features.
