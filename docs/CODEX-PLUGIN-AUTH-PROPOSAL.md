# Proposal: guided Codex setup and optional provider OAuth

Status: design accepted through PR #330. The initial Google implementation is
documented in [Google sign-in](GMAIL-OAUTH.md); broader provider and hosted work
remain proposed. This document does not install a plugin or provide a hosted
service.

## Purpose and precedent

Extend the existing local Codex plugin with clearer setup and optional
mail-provider authorization. Preserve the default
Mail.app workflow and existing app-password configuration. Users should be able
to identify which connection needs attention without confusing plugin
installation, macOS permissions, and mailbox authentication.

[PR #54](https://github.com/sweetrb/apple-mail-mcp/pull/54) introduced the Codex
package and repository marketplace. The package already contains the skill,
assets, and MCP configuration, with its npm runtime pin synchronized by
`scripts/sync-plugin-version.mjs`. Build on that package rather than creating a
duplicate. [Apple Mail in Codex](CODEX-SETUP.md) documents the current setup.

The LinkedIn MCP proposal
[#862](https://github.com/stickerdaniel/linkedin-mcp-server/issues/862) and merged
implementation [#863](https://github.com/stickerdaniel/linkedin-mcp-server/pull/863)
provide a useful local-plugin precedent: package workflow guidance and a pinned
MCP command together, preserve independent enablement, and keep installation
separate from sign-in. LinkedIn's browser-session login is not mailbox OAuth;
its packaging approach is reusable, but its authentication mechanism is not a
provider integration for Apple Mail.

An Unsplash-style hosted OAuth connection represents a different architecture.
[Unsplash user authentication](https://unsplash.com/documentation#user-authentication)
authorizes access to a remote API. A comparable experience here would need an
authorization service and a deliberate choice between provider-only access and
a local companion; packaging the existing stdio server is insufficient.

## Separate the three connections

| Connection        | Current behavior                                                    | Proposed work                                                |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| Codex to MCP      | Local stdio process launched from a pinned npm release              | Retain the existing opt-in package                           |
| MCP to Mail.app   | macOS Automation permission; Mail.app manages its accounts          | Guide permission checks and diagnostics                      |
| MCP to a provider | Optional IMAP/SMTP password authentication, normally using Keychain | Add provider-specific OAuth and credential lifecycle support |

The original IMAP and SMTP connection builders passed `{ user, pass }`. The
initial Google implementation adds a shared token-aware credential path while
retaining password accounts; neither a marketplace authentication policy nor a
manifest declaration alone implements OAuth.
[Codex MCP OAuth](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) authenticates
HTTP MCP connections, not the local server's downstream mailbox connections.

Compose correctness remains a separate workstream. The quotation limitation is
documented in [issue #12](https://github.com/sweetrb/apple-mail-mcp/issues/12), and
transport corrections shipped in 2.20.30 via [PR #329](https://github.com/sweetrb/apple-mail-mcp/pull/329).
Adding authorization must not be presented as a fix for delivery formatting.

## First increment: guided local setup

Build on the existing `doctor`, configuration-file, and Keychain workflows.
Distinguish a missing runtime, denied Automation permission, disabled account,
provider connection failure, and incomplete SMTP configuration. Explain what
each check proves: an IMAP login check and an SMTP configuration check are not
equivalent. Never ask users to paste credentials into chat or edit installed
plugin manifests.

Keep connection changes explicit and account-specific. Discovery must not start
authorization or write mail. Before adding setup helpers, verify default
`initialize` and `tools/list` behavior on macOS, including the absence of browser
launches, Keychain lookups, and provider connections. Test explicitly enabled
IMAP IDLE separately. User-invoked diagnostics may contact configured providers.

Retain the exact npm pin. Bundling the server or Node runtime would be a separate
packaging decision requiring installed-path, relocation, version-sync, and
desktop validation; it is not necessary for guided setup.

## Second increment: provider authorization

Introduce a typed credential provider shared by IMAP and SMTP while preserving
app-password support. Provide explicit connect, status, reconnect, and disconnect
operations. Use provider-supported desktop flows, with authorization code and
PKCE where available. Bind each transaction to its account, issuer, expected
callback, state, and requested scopes.

Store refresh credentials in macOS Keychain. Keep tokens out of manifests,
configuration files, tool results, and logs, and do not embed a confidential
client secret in a distributed desktop package. Handle expiration, revocation,
rotation, cancellation, and concurrent refresh independently for each account.
Authentication failures must not switch accounts or downgrade TLS.

Provider support must be assessed individually:

- **Google:** IMAP/SMTP OAuth uses the broad `https://mail.google.com/` scope and
  carries verification and user-data-policy requirements. A narrower-permission
  design may require a Gmail API backend rather than calling IMAP OAuth
  read-only. See [Google's OAuth documentation](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol).
- **Microsoft:** delegated IMAP and SMTP scopes are separate. Application
  registration and applicable tenant policies remain prerequisites; request
  `offline_access` when refresh tokens are needed. See
  [Microsoft's protocol authorization guide](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth).
- **iCloud:** Apple documents Apple Account authorization for supported
  third-party apps and app-specific passwords for others. Eligibility and
  developer access for this project are unconfirmed; retain the Keychain
  app-password path until support is established. See
  [Apple's third-party access guidance](https://support.apple.com/en-us/121539).

Authorization grants provider access; it does not authorize a particular send
or destructive action. Preserve user instructions and host tool approvals.
Reconnecting one account must not change another account's credentials or sender
identity.

## Acceptance criteria

An implementation should demonstrate:

1. A fresh macOS Codex installation loads the expected plugin/runtime version
   and discovers tools without initiating provider authorization or mail writes.
2. Setup diagnostics distinguish runtime, permission, credential, provider,
   scope, and account failures without exposing secrets or overstating checks.
3. Tests reject mismatched state, issuer, callback, and account combinations,
   and cover expiration, revocation, concurrent refresh, rotation, cancellation,
   and redaction.
4. Multi-account tests prove credential isolation and preserve existing transport
   selection, sender identity, TLS requirements, and app-password behavior.
5. Plugin metadata, runtime pins, assets, and generated skill copies remain
   synchronized, with a smoke test of the actual installed package. Provider
   validation uses disposable accounts and sends no mail during discovery or
   authentication.

Any change affecting compose behavior also requires delivered-message checks
through Codex and Claude Code. Received MIME and rendering, rather than tool
success alone, establish formatting; the detailed transport regression work
belongs with the separate compose change.

## Hosted access is a separate decision

A hosted connection would require an HTTP MCP service, MCP authorization,
protected provider-token storage, and tenant/account isolation. It cannot
directly access a user's local Mail.app. A provider-only backend would expose a
different capability set; preserving local Mail.app operations would require an
explicit local companion.

Prioritize guided local setup, then a narrowly scoped provider-authorization
implementation. Consider hosting only if remote access is an agreed requirement.
This proposal claims neither a remote endpoint nor universal-directory
publication.
