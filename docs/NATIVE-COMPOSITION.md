# Composing through Mail's native editor

`send-email`, `create-draft`, `reply-to-message`, and `forward-message` accept
`composition: "native-editor"`. This opt-in mode inserts newly authored prose
through Mail's visible editor instead of assigning its AppleScript `content`
property. Mail retains its configured signature and, for replies and forwards,
the original HTML history. A reply starts from Mail's actual Reply command,
preserving its relationship to the parent message.

For example, create a self-addressed draft with an explicitly selected sender:

```json
{
  "to": ["me@example.com"],
  "account": "me@example.com",
  "subject": "Native composition check",
  "body": "New prose belongs above the signature and quoted history.",
  "composition": "native-editor"
}
```

For a reply, pass the original message's `id`, the new `body`,
`composition: "native-editor"`, and `send: false` to `reply-to-message`.
For a numeric ID, also pass the `account` and full `mailbox` path from the
search or listing together. The source read and Mail's reply target are then
confined to that mailbox; a missing or ambiguous source, or a changed original
`Message-ID`, stops the operation. An `imap:` ID already contains its source,
so omit those two fields for it. Do not include a manually reconstructed quote.
Review the draft before a separately authorized send.

## Requirements and failure behavior

Mail must have an accessible editor in the runtime's active GUI session. The
runtime needs existing Accessibility permission and Automation permission for
Mail and System Events. The bridge checks those grants without requesting them;
it does not change privacy settings. System Events is started if needed. Keep
Mail and the clipboard idle while composition runs.

Before checking permissions, the bridge queries the caller's Quartz session
with Apple's documented
[`CGSessionCopyCurrentDictionary`](<https://developer.apple.com/documentation/coregraphics/cgsessioncopycurrentdictionary()>)
and [session properties](https://developer.apple.com/documentation/coregraphics/window-server-session-properties).
A missing GUI session, an inactive console session, an incomplete login, or
unreadable session information stops the operation with a distinct diagnostic.
The session is checked again before native input and during insertion/readback.
The console and login flags do **not** prove that the screen is unlocked or
that an editor is usable. Exact window, focus, and content checks remain required.

### Closed lid, Clamshell, and Codex

Closing the lid is not itself a reason for this package to refuse native
composition. The session and verified editor must remain available. Keeping the
CPU awake alone does not establish that condition.

[Clamshell's screen-access guide](https://clamshell.dev/guides/agents-use-screen-lid-closed)
documents screen access during armed closed-lid sessions from version 1.4.19
and the **Let agents use the screen while the lid is closed** setting from
1.4.21. Its documentation also describes cases where the display is put to sleep
instead. Those are Clamshell's documented capabilities, not a verified
compatibility guarantee for this Mail bridge. The package does not toggle
Clamshell settings or infer screen availability from whether Clamshell is running.

Codex's [Locked use](https://learn.chatgpt.com/docs/computer-use#locked-use)
belongs to its Computer Use integration. OpenAI documents that it does not give
other applications or local processes a general unlock capability. This MCP
server's `osascript` bridge is a separate local process; enabling Locked use
does not establish that its native Mail editor is available.

For native composition, unavailable sessions stop before permission/UI work.
Later focus failures include a bounded reason such as `foreground`,
`main-window`, `position`, or `size`, instead of implying that Automation
permission was denied. No failure silently switches to SMTP, and a failed
insertion is never followed by the manager's save/send step. For an explicitly
chosen unattended SMTP operation, omit `composition: "native-editor"`; SMTP
does not reproduce Mail's native signature and quotation layout.

Tests execute session and focus failures against the generated program, and a
macOS-only test queries the actual CoreGraphics bridge without opening Mail or
touching the clipboard. These checks do not establish successful closed-lid
composition, screen unlocking, or delivery on a particular Mac.

### Clipboard and message verification

Temporary clipboard content is marked as transient and app-generated using
the [NSPasteboard conventions](https://nspasteboard.org/). This keeps compatible
clipboard history and formatting utilities from storing or rewriting it.
[Pure Paste](https://sindresorhus.com/pure-paste) documents support for these
markers. If another utility still changes the clipboard, composition stops;
the server does not disable utilities or change their settings.

Clipboard recovery preserves every readable format, including image and file
data, within a 64 MiB serialized snapshot budget. Base64 encoding counts toward
that budget. An oversized or unreadable snapshot stops composition before the
clipboard is changed; process-output and recovery-input limits include room
for protocol metadata. Recovery data stays in memory and is not logged or
written to a temporary file. A newer clipboard owner is never overwritten.

If the clipboard already carries another native-composition operation's marker,
the new operation stops with a `clipboard-busy` diagnostic before taking a
snapshot. This prevents a second operation from treating the first operation's
temporary prose as the user's original clipboard. It is an ownership check,
not a cross-process queue; keep concurrent composition requests serialized.

New messages require an explicit `account`. Replies use the parent message's
account and matching recipient identity, refusing an ambiguous sender. Native
composition selects Mail.app even when SMTP is configured. Combining it with
`transport: "smtp"` or caller-built threading headers is rejected. The default
composition path and mail merge are unchanged.

The server identifies one composer by its outgoing-message ID, temporary unique
subject, and sender. It briefly rechecks the marked window, subject, and editor
when Mail publishes them at different times; it never selects an unmarked or
ambiguous composer. It inserts escaped, inherited-size HTML only after verifying
body focus. The sender, subject, and recipients are checked again before saving
or sending. The temporary subject is then restored. Clipboard contents are
restored unless another application has changed them in the meantime.

Drafts close only after Mail confirms a new stored draft ID for the restored
subject. If confirmation does not arrive within ten seconds, the operation
reports failure and leaves the composer open rather than risking a lost draft.

A failed operation is not retried or rerouted. A partially composed draft may
remain open for inspection. A process crash can prevent clipboard restoration;
inspect the clipboard and draft before retrying. If final delivery is uncertain,
check Sent and Outbox first to avoid duplicates.

## Standalone prose renderer

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

## Rendering and delivery verification

The standalone helper renders a fragment; it does not drive Mail. The MCP option
above performs insertion itself. A host may also use the fragment through its
own supported native-editor interface, with the same identity and verification
requirements.

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

Native-editor mode avoids the affected body setter; it does not repair macOS
or guarantee identical rendering across providers and recipient clients.
Unit tests verify routing, escaping, and failure handling, not delivery or mobile
rendering. The standalone helper itself requires no Mail access or permissions.

### Proton draft synchronization

With Proton Bridge 3.27.1, a synchronized reply draft can lose its parent
relationship even when Mail's local draft has correct headers. Bridge's
[draft-import path](https://github.com/ProtonMail/proton-bridge/blob/v3.27.1/internal/services/imapservice/connector.go#L974-L998)
omits the parent from its server-side draft request. Native-editor mode does
not change that provider behavior. Verify the synchronized draft's ancestry
after reopening; an immediately sent reply retaining its thread does not
establish the same result for a saved draft. This package neither modifies
Bridge nor requires a custom Bridge build.
