# Proposal: Codex compose parity, guided setup, and optional provider OAuth

**Status: proposed design. Provider OAuth is not implemented by this document.**

## Goal

Make the existing local Codex plugin easier to install, diagnose, and connect to
supported mail providers, with the same release attention given to Claude Code.
Prioritize correct delivered email formatting in Codex alongside setup work.
Preserve the default Mail.app workflow and add provider authorization as an
optional capability.

The plugin already exists: [PR #54](https://github.com/sweetrb/apple-mail-mcp/pull/54)
introduced `codex/` and the repository marketplace. The current package bundles
the skill, assets, and MCP configuration; its exact npm runtime pin is kept in
sync by `scripts/sync-plugin-version.mjs`. It does not bundle Node.js or an OAuth
implementation. The supported setup today is documented in
[Apple Mail in Codex](CODEX-SETUP.md).

This is the same local packaging model used in the LinkedIn proposal
[stickerdaniel/linkedin-mcp-server#862](https://github.com/stickerdaniel/linkedin-mcp-server/issues/862)
and implementation [#863](https://github.com/stickerdaniel/linkedin-mcp-server/pull/863).
The next step here is to extend the existing plugin's setup experience.

## Codex compose parity: current recurring issue

I repeatedly see newly authored email arrive as quoted blocks when I compose
through Codex's Apple Mail skill. The cause remains unresolved until an actual
delivery test traces the selected transport and verifies the received message.
The accompanying code change removes a verified mail-merge fallback,
but does not establish that the native Mail.app formatting issue is fixed.

There is a documented underlying limitation: Mail.app's AppleScript send path on
macOS 15+ can put the body inside `<blockquote type="cite">` under
`Apple-Mail-URLShareWrapperClass`. [Issue #12](https://github.com/sweetrb/apple-mail-mcp/issues/12)
was closed after adding a direct-SMTP workaround. The native limitation remains
documented in the README and `src/services/smtpMailer.ts`.

The current routing also explains why "SMTP is configured" is not sufficient
evidence that Codex used the workaround. `shouldUseSmtp(undefined, "Work", true)`
returns `false`: an account label selects Mail.app when transport is omitted.
Explicit SMTP uses the configured SMTP identity, not a provider chosen from that
label. Native draft creation also remains separate from direct SMTP delivery.
These verified code paths identify cases to test; they do not prove which path
produced the messages I received.

Mail merge has its own verified routing bug. In 2.20.29, `send-serial-email`
silently selected Mail.app when a chosen SMTP path failed to resolve its
configuration or credentials. An isolated mocked-handler test reproduced that
fallback without sending real mail. The accompanying 2.20.30 fix returns an
error before either backend sends, preserves deliberate native selection, and
reports the transport in attempted-batch results. It also adds explicit
transport selection and preserves an approved email-form sender override, which
the previous implementation silently ignored. Explicit SMTP rejects bare
Mail.app account labels, and sender validation completes before the first
message is submitted. Failed SMTP submissions are not retried through Mail.app.

Give the installed Codex plugin the same acceptance gate as Claude Code. Run the
same compose scenarios through both hosts and record the selected tool,
transport, sender, and delivered result. A Claude-only success or a passing
mocked unit suite does not close a Codex delivery report.

The compose matrix should cover new mail, replies, forwards, review-first native
drafts, named accounts, explicit SMTP, unavailable credentials, and mail merge.
Inspect received raw MIME and the recipient's rendered message: newly authored
text must not be converted into a quotation, while intentional quotation of
original reply/forward content should remain intact. Verify the actual sender
and threading as well. Use disposable accounts and deliberate test sends; tool
discovery and authentication tests should not send messages.

The canonical skill and tool description now explain the verified routing and
the bundled skill copies are synchronized. Keep actual Codex delivery validation
as a release gate. Keep OAuth work separate: adding a sign-in flow does not fix
compose selection or outbound MIME formatting.

## Keep the authentication boundaries explicit

| Connection | Current behavior | Proposed direction |
| --- | --- | --- |
| Codex to MCP | Local stdio process launched from an exact npm release | Keep the existing local, opt-in plugin |
| MCP to Mail.app | macOS Automation permission; Mail.app manages accounts | Guide users through the existing permission and diagnostic steps |
| MCP to an optional provider | IMAP/SMTP password login, normally resolved from Keychain | Add provider-specific OAuth and credential lifecycle support |

The IMAP and SMTP connection builders currently pass `{ user, pass }`. Adding
OAuth requires a real token-based connection path; a marketplace
`authentication: "ON_INSTALL"` field does not supply it.

[Codex MCP OAuth](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) protects
HTTP MCP connections. It does not automatically sign a local stdio process into
a mailbox. Likewise, an [OAuth declaration in a plugin package](https://developers.openai.com/plugins/build/plugins)
describes an existing integration rather than creating an authorization service.

## First increment: guided local setup

Use the existing plugin and `doctor` tool to distinguish installation problems,
Mail.app permissions, and optional provider configuration. Build on the current
Keychain and configuration-file workflow rather than asking users to edit
installed manifests or paste credentials into chat.

Keep installation and enablement under user control. Do not open a provider
login or change account configuration merely because the host lists tools. A
future connect workflow should start only when requested and should report
which account and capabilities it is connecting.

Before adding any new setup helper, verify default `initialize` and `tools/list`
behavior on macOS: no browser/login launch, Keychain lookup, provider connection,
or mail write. Test explicitly enabled IMAP IDLE behavior separately. Setup
diagnostics can contact configured providers when the user invokes them; they
must distinguish a successful IMAP login from merely present SMTP settings.

The current exact npm pin remains the supported distribution path. If a fully
self-contained plugin is desired, evaluate bundling the built server inside the
plugin as a separate packaging change. Prove installed-path resolution,
relocation, release-version synchronization, and artifact integrity in a real
desktop installation before changing the launcher. Node would remain a runtime
dependency unless separately packaged and maintained.

## Second increment: optional provider authorization

Add a typed credential provider shared by IMAP and SMTP, preserving the existing
app-password mode. Expose explicit connect, status, reconnect, and disconnect
workflows. Use provider-supported desktop authorization with authorization code
and PKCE where available. Bind each transaction to its account, issuer, expected
callback, state, and requested scopes.

Store refresh credentials in macOS Keychain; keep tokens out of manifests,
configuration files, tool results, and logs. Handle expiry, rotation, revocation,
and concurrent refresh per account. A distributed desktop package must not
contain a confidential client secret. Authentication failures must not switch
accounts or downgrade TLS.

Provider choices need separate implementation decisions:

- **Google:** IMAP/SMTP OAuth uses the broad `https://mail.google.com/` scope.
  Verification and minimum-scope requirements apply. A product requiring narrower
  permissions may need a Gmail API backend rather than describing IMAP OAuth as
  read-only. [Google documentation](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol).
- **Microsoft:** delegated IMAP and SMTP permissions are separate. Application
  registration and tenant/provider policy remain prerequisites; refresh access
  is requested when needed. [Microsoft documentation](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth).
- **iCloud:** Apple supports Apple Account authorization for supported third-party
  apps and app-specific passwords for others. This repository does not establish
  eligibility for or implement that authorization mechanism. Investigate developer
  access separately and retain the current Keychain path until support is
  confirmed. [Apple U.S. documentation](https://support.apple.com/en-us/121539).

OAuth authenticates an account; the user's instruction and host tool approval
policy still govern sending and destructive actions. Bind credentials to the
selected account and verify that reconnecting one account cannot alter another
account's identity or sender.

## Acceptance criteria for an implementation PR

1. Codex and Claude Code both pass the expected results in the compose matrix
   above. Direct SMTP messages preserve unquoted newly authored text, intentional
   historical quotes, correct sender, and threading in received MIME and
   rendering. Any native-path limitation remains explicit rather than being
   reported as a fixed delivery feature.
2. A fresh macOS Codex installation loads the correct plugin/runtime version and
   discovers tools without starting provider authorization.
3. Diagnostics distinguish missing runtime, Automation permission, credential,
   provider, scope, and account failures without revealing secrets.
4. Mocked tests cover rejected state/callback/account combinations, expired and
   revoked credentials, concurrent refresh, rotation, cancellation, and redaction.
5. Multi-account tests prove credential isolation and preserve existing transport
   selection and TLS requirements.
6. Plugin manifests, runtime pin, assets, and generated skill copies stay in sync.
   A desktop smoke test covers the actual package; provider checks use disposable
   test accounts and do not send mail during discovery or authentication.

## A hosted plugin would be a separate product decision

An Unsplash-style hosted connection needs an actual HTTP service and
[MCP OAuth discovery and per-request authorization](https://developers.openai.com/plugins/build/auth).
It also needs account isolation and protected provider-token storage. Hosting a
server does not grant access to a user's Mail.app; that requires an explicit
local companion or a provider-only backend with a different capability set.

Choose the local provider-authorization increment first unless remote access is
an explicit requirement. No remote endpoint, OAuth support, or universal-directory
publication is claimed by this proposal.
