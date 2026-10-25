# Google sign-in for direct IMAP and SMTP

Version 2.20.31 adds an explicit local Google Desktop authorization-code flow
with PKCE. Mail.app accounts and existing password settings remain supported.
Microsoft and iCloud OAuth are not implemented. This is downstream mailbox
authorization, not hosted MCP authentication, and does not change native
Mail.app compose formatting.

## Prerequisites

Create your own **Desktop app** OAuth client in a Google Cloud project, enable
the appropriate consent configuration, and add your account as a test user when
the project is in testing. The distributed package contains no client ID or
confidential client secret. The client must permit a public desktop token
exchange without a secret. Organization policies can prohibit this flow.

Google IMAP/SMTP requires the broad `https://mail.google.com/` scope. Consent
also requests `openid email` to verify the selected account. This is not a
read-only permission. Public distribution is subject to Google's verification
and restricted-scope policies; testing-mode grants can expire. See Google's
[desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app)
and [IMAP/SMTP OAuth requirements](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol).

Use macOS with an unlocked login Keychain and a system browser. No credentials
are read, authorization browser opened, or provider contacted merely by importing
the OAuth code or discovering the default MCP tools. Explicitly enabled IMAP
IDLE and user-invoked diagnostics do contact providers.

## Non-secret configuration

Merge the following settings into the existing configuration file (do not
overwrite other accounts), normally
`~/Library/Application Support/apple-mail-mcp/config.json`:

```json
{
  "APPLE_MAIL_MCP_GOOGLE_CLIENT_ID": "YOUR_DESKTOP_CLIENT_ID.apps.googleusercontent.com",
  "APPLE_MAIL_MCP_IMAP_AUTH": "google",
  "APPLE_MAIL_MCP_IMAP_USER": "you@gmail.com",
  "APPLE_MAIL_MCP_IMAP_HOST": "imap.gmail.com",
  "APPLE_MAIL_MCP_SMTP_AUTH": "google",
  "APPLE_MAIL_MCP_SMTP_USER": "you@gmail.com",
  "APPLE_MAIL_MCP_SMTP_HOST": "smtp.gmail.com",
  "APPLE_MAIL_MCP_SMTP_PORT": "587"
}
```

Environment settings override file settings. IMAP requires implicit TLS on
`imap.gmail.com:993`. SMTP supports mandatory STARTTLS on `smtp.gmail.com:587`
or implicit TLS on port 465 with `APPLE_MAIL_MCP_SMTP_SECURE=1`. Plaintext and
other hosts are rejected before retrieving any token. Never put access tokens,
refresh tokens, or client secrets in the configuration, password fields, chat,
or plugin manifests.

For additional IMAP accounts, use the existing `APPLE_MAIL_MCP_IMAP_ACCOUNTS`
JSON string with entries such as:

```json
[{"account":"Personal","user":"you@gmail.com","host":"imap.gmail.com","auth":"google"}]
```

Each entry can supply its own non-secret `clientId`; otherwise the global client
ID applies. Entries without `auth` continue using passwords. SMTP still has one
configured identity; this feature does not add multi-account SMTP routing.

## Explicit lifecycle

From a source checkout after building, run:

```sh
node build/auth-cli.js connect you@gmail.com
node build/auth-cli.js status you@gmail.com
node build/auth-cli.js reconnect you@gmail.com
node build/auth-cli.js disconnect you@gmail.com
```

An installed release exposes the same commands as `apple-mail-auth`. Use the
CLI bundled with the same version as the running MCP server. Do not modify
installed plugin files. This candidate must be published before an npm install
of version 2.20.31 can be assumed available.

`connect` and `reconnect` open the external browser and wait up to three minutes
for an ephemeral `127.0.0.1` callback. Select the exact configured account.
Ctrl-C cancels. Signed OpenID identity, nonce, state, audience, issuer, scopes,
and callback are checked before storage. Reconnect replaces only that account's
grant after successful verification; a failed attempt leaves the previous grant.
No email is sent during authorization.

Credentials are stored as a namespaced generic-password Keychain item scoped to
the client ID and email. Writes use the security utility's stdin, not process
arguments, a shell, or temporary files. Status returns only the provider, email,
and local credential state; "connected" does not prove current provider access.
Tokens refresh at transport connection time, with an expiry margin and
single-flight refresh per identity. Revoked grants fail closed and require
reconnect; password fallback is never attempted for a Google configuration.

**Stop every running MCP instance before connect, reconnect, or disconnect, and
restart it afterward.**
The standalone CLI cannot close sockets in another process. Disconnect removes
local credentials; already authenticated provider sessions can otherwise remain
usable. In-process disconnect cancels pending OAuth work and closes matching
pooled IMAP sessions; it stops all IDLE watchers conservatively. Disconnect does
not revoke Google's server-side grant: remove the application's access in your
Google account to revoke it across processes/devices. Do not disconnect while a
send is in progress; a submitted message cannot be recalled.

Cross-process writes are coordinated through per-identity locks and opaque
revision files under `~/Library/Application Support/apple-mail-mcp/oauth-state`.
These contain no tokens or account addresses. A delayed refresh cannot restore
a disconnected grant or overwrite a newer sign-in. If a process crashes while
holding its storage lock, the next operation fails closed and identifies the
exact empty `.lock` directory. Stop all mail MCP/auth processes before removing
that one stale empty directory and retrying; do not remove revision files.

## Verification boundary

Automated tests exercise an actual loopback callback and HTTP token/JWKS fixture
through the production PKCE and signed OpenID validation code, including invalid
claims, state, replay, cancellation, refresh rotation, and disconnect races.
They use an in-memory store and never write the user's Keychain or send mail.
These tests do not establish Google registration approval, actual Google login,
macOS Keychain permission behavior, or live IMAP/SMTP acceptance. Live validation
requires a configured Google project and explicit interactive consent, followed
by a read-only IMAP login and SMTP authentication check. Sending remains a
separate user-authorized operation.
