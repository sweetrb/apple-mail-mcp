# Apple Mail in Codex

This guide describes the local plugin packaged in this repository and the
capabilities provided by `apple-mail-mcp`. The plugin packages the Apple Mail skill, assets, and MCP
configuration. It launches an exactly pinned npm release through `npx`; it does
not install Node.js, add mail accounts, or provide mailbox-provider OAuth.

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

The portable entry points are `codex/plugin.json` and `codex/mcp.json` (explicit
`stdio` transport). Existing `.codex-plugin/plugin.json` and `.mcp.json` files
remain as compatibility fallbacks, with matching identity, version, assets,
presentation, and launcher. See the current
[official packaging guidance](https://developers.openai.com/plugins/build/plugins).
Local discovery of an unpublished candidate does not establish that its pinned
npm runtime is available; publish the matching release before registry-based
runtime installation.

### Enablement and sign-in

Installation is opt-in. Disable the plugin in Codex settings, or disable only
its bundled MCP server in `~/.codex/config.toml`:

```toml
[plugins."apple-mail".mcp_servers.apple-mail]
enabled = false
```

The package does not override either choice or run installation hooks. Installing
it does not sign into a mailbox: the default backend uses accounts already
configured in Mail.app. macOS Automation permission is separate and may be
requested when the server first accesses Mail.

## Updates and migration

The Git marketplace provides the connection to this repository's releases. After
a new release is published, refresh the configured marketplace:

```bash
codex plugin marketplace upgrade apple-mail-mcp
```

This command refreshes the Git marketplace catalog; it does not replace the
runtime pin with `@latest`. Install the published plugin version from the
refreshed marketplace, then start a new Codex session. Confirm that the plugin
version and its pinned npm runtime refer to the same published release. A merged
PR or an unpublished candidate is not sufficient for the npm-backed launcher.
See the [official marketplace command reference](https://learn.chatgpt.com/docs/developer-commands).

An imported archive is a self-contained snapshot. Uploading it as a separate
private account plugin does not connect that copy to this repository's update
source. Update such copies by importing or uploading a replacement package;
refreshing the Git marketplace does not update them.

To move from an archive or private copy to the maintained Git marketplace:

1. Back up personal settings and approval choices, and check that the published
   release includes any fixes or workflow safeguards you rely on. Keep personal
   configuration outside the installed plugin cache so updates do not replace it.
2. Install through the repository marketplace using the commands above. Avoid
   enabling two Mail connections at once while switching installations.
3. Start a new Codex session and verify the replacement's icon, tools, and
   read-only Mail access. Before relying on it for replies, verify sender identity,
   `In-Reply-To`, `References`, and quotation formatting with an explicitly
   authorized test message.
4. Once the replacement passes, remove the redundant plugin and any redundant
   manual MCP registration. Preserve credentials, settings, and a rollback copy.

## Standalone plugin archive

Releases include `apple-mail-codex-plugin-v<version>.tar.gz`, a complete local
plugin with the bundled MCP server, both manifest formats, workflow skill,
icons, and license. Candidate archives are also available from the
`apple-mail-codex-plugin-<commit>` artifact on successful CI runs. GitHub wraps
that artifact in a ZIP; extract it to obtain the plugin's `.tar.gz` archive.

Use the archive with a host that supports importing local plugin packages.
The Codex CLI's repository-marketplace installation commands above remain the
supported CLI route; `codex plugin add` does not accept an archive filename.
Archive installation requires a Mac with Node.js 20 or later and configured
Mail.app accounts. It uses `node` to start the included server, so it needs no
`node_modules`, package installation, or unpublished npm release. Mail access
and Automation permissions are unchanged.

To build the archive from a checkout after the normal build and checks:

```bash
pnpm run package:codex /absolute/output/directory/apple-mail.tar.gz
pnpm run test:codex-package
```

The output directory must already exist. Packaging refuses to overwrite an
existing archive and rejects symlinked inputs and output directories. It copies
only the declared plugin files and committed server bundle, excluding local
configuration and credentials. Only the archive's MCP launchers are changed to
`${PLUGIN_ROOT}/server/index.js`; the repository marketplace retains its exact
npm release pin. Identical input files produce identical archive bytes.

The archive tests extract the package with the system `tar`, initialize the
included server without dependencies, and list its tools without accessing Mail.
Release automation builds the archive in a read-only job and attaches it only
to a release tag identifying the same commit.

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
mailbox operations, while SMTP adds direct sending. Both currently use password
authentication, with macOS Keychain as the recommended credential source.

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
does not add OAuth support.

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
Opening or saving an AppleScript-injected draft does not fix its body wrapper.

Hosts that provide supported computer control on the Mac can instead use the
packaged skill's native-editor workflow: create a genuine native Reply, insert
only new escaped prose as HTML divs with `font-size: inherit`, and leave the
native signature and history intact. The host provides the computer control;
there is no new MCP editor tool in this plugin. No companion helper is required.
Fixed pixel/point sizes can look correct on Mac yet differ from the native
signature on mobile; plain unsized HTML paste can acquire another default size.

Inspect the saved draft, then the actual Sent and recipient HTML, public parent
headers, sender identity, paragraph spacing, and target-client rendering.
Providers can rewrite an alias even when the composer and Sent copy show the
selected identity. Rich-text mode, Sent alone, and a Mac preview do not establish
recipient or mobile correctness. This workaround changes neither the runtime's
AppleScript setter nor provider authentication. If computer control is absent,
report that capability gap or use separately configured matching SMTP; do not
invent a plugin tool or silently fall back to quoted-body injection.

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
