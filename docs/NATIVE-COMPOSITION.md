# Rendering prose for a native Mail editor

The dependency-free `scripts/render-authored-body.mjs` helper converts new prose
into an escaped HTML fragment. It preserves blank paragraphs and Unicode while
inheriting the native message's font size instead of pinning authored text to a
pixel or point size. It does not choose a font, replace a signature, reconstruct
quoted history, open Mail, change preferences, or send a message.

From a repository checkout or the root of an installed package:

```sh
node scripts/render-authored-body.mjs < authored-message.json
```

The input is UTF-8 JSON, for example:

```json
{ "body": "Thank you for the update.\n\nI will review the details." }
```

The helper writes only the fragment to stdout and reports invalid input to
stderr with a nonzero exit status. Authored markup is escaped as text, not
interpreted as HTML. The helper is also importable through its
`renderAuthoredBody({ body })` export.

## Host and verification requirements

Using the result in Mail requires a separate, supported native-editor interface
or manual interaction. Neither this helper nor the MCP server provides computer
control or an HTML clipboard API. A host that cannot operate the native editor
must not claim this workflow is available or substitute an unverified send path.

For a reply, open the selected original through Mail's native Reply command;
a new composition with a `Re:` subject is not equivalent. Verify the sender and
participants, then insert only newly authored content through the host's
supported HTML insertion route, outside the existing quoted history. Preserve
the configured signature and native styling. Inspect the resulting draft before
any separately authorized send. Saving a draft is not authorization to send it.

Validate the actual stored and received artifacts: an HTML part with new text
outside the quote structure, original history inside it, and correct parent
headers. Compare the rendered authored text and signature in the relevant
recipient client. An inherited CSS declaration or a matching desktop font label
alone does not establish consistent rendering after serialization or on another
client; plain-text quote markers alone do not prove HTML quotation bars.

This is a prose-rendering helper for a host-driven native-editor workaround. It
does not repair Mail's AppleScript body setter, change an MCP tool or transport,
or establish uniform behavior across accounts, macOS versions, and recipient
clients. Unit tests verify the fragment and CLI contract, not Mail delivery or
mobile rendering. No new permissions or account access are required by the
helper itself.
