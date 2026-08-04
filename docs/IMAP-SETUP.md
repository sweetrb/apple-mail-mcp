# IMAP / SMTP Setup Guide

`apple-mail-mcp` works out of the box over AppleScript with no configuration. The
**IMAP backend is opt-in** and makes the server talk to your mail provider
directly for the operations where that's faster and more reliable than driving
Mail.app — most importantly **search, counts, and large mailboxes**, where
AppleScript times out. Configuring **SMTP** additionally lets the server send
clean MIME (avoiding the macOS 15+ Mail.app `<blockquote>` wrapping).

This is **additive and per-account**: any account you don't configure for IMAP
keeps using AppleScript exactly as before. You can mix — e.g. Gmail over IMAP,
everything else over AppleScript.

> **TL;DR**
> 1. Generate an **app-specific password** at your mail provider.
> 2. Store it in the **macOS Keychain** (the server reads it from there — it
>    never goes in any config file).
> 3. Tell the server which account(s) to use, via an **`env` block** or a
>    **`config.json` file** (see Step 3 below).
> 4. **Restart** your MCP client and run the **`doctor`** tool to verify.

---

## What IMAP accelerates

When an account is IMAP-configured, these route to IMAP (otherwise AppleScript):

| Capability | Tools |
|------------|-------|
| Server-side search / list | `search-messages`, `list-messages` |
| Read a message | `get-message` |
| Message mutations | `mark-as-read`/`unread`, `flag`/`unflag-message`, `move-message`, `delete-message` |
| Batch mutations | `batch-mark-as-read`/`unread`, `batch-flag`/`unflag-messages`, `batch-move-messages`, `batch-delete-messages` |
| Folder ops | `create-mailbox`, `rename-mailbox`, `delete-mailbox` |
| Counts & stats | `get-unread-count`, `list-mailboxes`, `get-mail-stats` |
| Attachments | `list-attachments`, `save-attachment`, `fetch-attachment` |
| Threading | `get-thread` |
| New-mail push | IMAP IDLE notifications (opt-in) |

---

## Prerequisites

- macOS with Mail.app configured (the AppleScript backend still handles anything
  not IMAP-configured).
- **`apple-mail-mcp` v2.1.0+** for the IMAP acceleration features, and **v2.1.1+**
  if you need the `config.json` method (see Step 3, Method B).
- For each account: the ability to create an **app-specific password** (requires
  2-factor auth enabled on that account).

Check your version with the `doctor` tool, or `npm view apple-mail-mcp version`.

---

## Step 1 — Generate an app-specific password

Use an **app-specific password**, never your real account password. Where to get one:

- **Gmail (personal):** [myaccount.google.com](https://myaccount.google.com) →
  **Security** → (2-Step Verification must be ON) → **App passwords** → create one,
  name it `apple-mail-mcp`. You get a 16-character password shown **once**.
- **Google Workspace** (e.g. a company `you@yourdomain.com` on Google): same flow,
  signed in as that account. ⚠️ Your Workspace **admin must allow app passwords**;
  if the option is missing, app-password IMAP isn't available for that account.
- **iCloud:** [account.apple.com](https://account.apple.com) → **Sign-In and
  Security** → **App-Specific Passwords**. Note the two different identities below.
- **Other IMAP providers (Fastmail, etc.):** create an app password in the
  provider's security settings.

> **iCloud gotcha — Apple ID vs IMAP login.** Your **Apple ID** (what you sign in
> to account.apple.com with, possibly a Gmail address) is *not* your IMAP login.
> The IMAP **username** is your iCloud mailbox address, e.g. `you@icloud.com`
> (or a `@me.com` alias). The app password is generated under the Apple ID but
> authenticates the iCloud mailbox login. Also note an iCloud app password only
> works for iCloud — it can't log into Gmail.

---

## Step 2 — Store the password in the Keychain

The server reads the password from the macOS login Keychain via `security
find-internet-password -s <service> -a <account>`. Add an entry to match. Run
this in **Terminal** (the `-w` flag prompts for the password silently, so it's
never in your shell history):

```bash
# Gmail / Google Workspace (service is always imap.gmail.com)
security add-internet-password -U -s imap.gmail.com -a you@gmail.com -r imap -w

# iCloud (service imap.mail.me.com; account is the iCloud MAILBOX address)
security add-internet-password -U -s imap.mail.me.com -a you@icloud.com -r imap -w
```

Paste the app-specific password at the prompt and press Return. The `-s` (service)
and `-a` (account) values must match what you put in the config in Step 3
(`KEYCHAIN_SERVICE` / `KEYCHAIN_ACCOUNT`).

If you also want **SMTP** sending and your provider uses the same app password for
SMTP (Gmail does), you don't need a second Keychain entry — just point the SMTP
`KEYCHAIN_SERVICE`/`KEYCHAIN_ACCOUNT` at the same item.

---

## Step 3 — Configure the server

The server reads `APPLE_MAIL_MCP_*` settings. There are two ways to supply them;
**use whichever your MCP client supports.**

### Method A — `env` block in your MCP client config

Works with clients that pass an `env` block through to the server (e.g. **Claude
Code** via `~/.claude.json`, and most standard `mcpServers` configs).

```jsonc
{
  "mcpServers": {
    "apple-mail": {
      "command": "node",
      "args": ["/path/to/apple-mail-mcp/build/index.js"],
      "env": {
        "APPLE_MAIL_MCP_IMAP_USER": "you@gmail.com",
        "APPLE_MAIL_MCP_IMAP_ACCOUNT": "you@gmail.com",
        "APPLE_MAIL_MCP_IMAP_HOST": "imap.gmail.com",
        "APPLE_MAIL_MCP_IMAP_KEYCHAIN_SERVICE": "imap.gmail.com",
        "APPLE_MAIL_MCP_IMAP_KEYCHAIN_ACCOUNT": "you@gmail.com"
      }
    }
  }
}
```

### Method B — `config.json` file (for hosts that strip `env`)  *(v2.1.1+)*

Some host apps (notably **Claude Desktop**) launch MCP servers with a **scrubbed
environment and ignore the `env` block**, so Method A silently does nothing
there. For those, put the same settings in a JSON file the host doesn't manage:

- Default path: `~/Library/Application Support/apple-mail-mcp/config.json`
- Or set `APPLE_MAIL_MCP_CONFIG_FILE` to a path of your choice.

```json
{
  "APPLE_MAIL_MCP_IMAP_USER": "you@gmail.com",
  "APPLE_MAIL_MCP_IMAP_ACCOUNT": "you@gmail.com",
  "APPLE_MAIL_MCP_IMAP_HOST": "imap.gmail.com",
  "APPLE_MAIL_MCP_IMAP_KEYCHAIN_SERVICE": "imap.gmail.com",
  "APPLE_MAIL_MCP_IMAP_KEYCHAIN_ACCOUNT": "you@gmail.com"
}
```

At startup the server merges these into its environment **without overriding**
anything already set, so Method A still wins if both are present. **Only
non-secret config goes here — passwords stay in the Keychain.**

> Not sure which method? Configure with Method A; if `doctor` still says "not
> configured" after a restart, your host strips `env` — switch to Method B.
> Plugin-marketplace installs (Claude Code `/plugin install apple-mail`) have no
> editable `env` block at all, so they always use Method B.

### `APPLE_MAIL_MCP_IMAP_ACCOUNT` and routing

`APPLE_MAIL_MCP_IMAP_ACCOUNT` should equal the **Mail.app account name** (what
`list-accounts` shows), because that is how an **explicitly named** `account`
argument is matched to an IMAP config.

**Since v2.6.0 you do not need to pass `account` at all for reads.** When any
IMAP account is configured, the read tools (`search-messages`, `get-thread`,
`list-messages`, `list-mailboxes`, `get-unread-count`, `get-mail-stats`) prefer
IMAP automatically:

- explicit IMAP `account` → that account over IMAP;
- explicit non-IMAP `account` → AppleScript;
- **no `account` → fan out over every configured IMAP account**, with AppleScript
  used only for the accounts no IMAP config covers.

The name still matters for targeting a specific account and for the
mailbox-write ops (`create`/`delete`/`rename-mailbox`), which route to IMAP only
for an explicitly named IMAP account.

### Multiple accounts

Configure additional accounts with `APPLE_MAIL_MCP_IMAP_ACCOUNTS`, a JSON **array
of objects, passed as a single string value** (the whole array is one env-var /
config-file string, as in the example below). The legacy single-account
vars above define the first/default account; the array adds the rest:

```json
{
  "APPLE_MAIL_MCP_IMAP_USER": "you@gmail.com",
  "APPLE_MAIL_MCP_IMAP_ACCOUNT": "you@gmail.com",
  "APPLE_MAIL_MCP_IMAP_HOST": "imap.gmail.com",
  "APPLE_MAIL_MCP_IMAP_KEYCHAIN_SERVICE": "imap.gmail.com",
  "APPLE_MAIL_MCP_IMAP_KEYCHAIN_ACCOUNT": "you@gmail.com",
  "APPLE_MAIL_MCP_IMAP_ACCOUNTS": "[{\"account\":\"Work\",\"user\":\"you@company.com\",\"host\":\"imap.gmail.com\",\"keychainService\":\"imap.gmail.com\",\"keychainAccount\":\"you@company.com\"},{\"account\":\"iCloud\",\"user\":\"you@icloud.com\",\"host\":\"imap.mail.me.com\",\"keychainService\":\"imap.mail.me.com\",\"keychainAccount\":\"you@icloud.com\"}]"
}
```

Each array entry accepts: `account`, `user`, `host`, `port`, `password`
(discouraged — prefer Keychain), `keychainService`, `keychainAccount`. Each
account keeps its own pooled IMAP connection.

---

## Step 4 (optional) — SMTP sending

Lets `send-email` submit clean MIME directly (use `transport: "smtp"`), avoiding
the macOS 15+ blockquote wrapping. SMTP is single-account (the default sender):

```json
{
  "APPLE_MAIL_MCP_SMTP_HOST": "smtp.gmail.com",
  "APPLE_MAIL_MCP_SMTP_PORT": "587",
  "APPLE_MAIL_MCP_SMTP_USER": "you@gmail.com",
  "APPLE_MAIL_MCP_SMTP_FROM": "you@gmail.com",
  "APPLE_MAIL_MCP_SMTP_ALLOWED_FROM": "alias@example.com",
  "APPLE_MAIL_MCP_SMTP_KEYCHAIN_SERVICE": "imap.gmail.com",
  "APPLE_MAIL_MCP_SMTP_KEYCHAIN_ACCOUNT": "you@gmail.com"
}
```

(Reusing the IMAP Keychain item is fine when the provider accepts the same app
password for SMTP, as Gmail does.)

---

## Step 5 (optional) — New-mail push (IMAP IDLE)

Add `"APPLE_MAIL_MCP_IMAP_IDLE": "1"` to get new-mail notifications for every
configured IMAP account. See the README's "Push notifications (IMAP IDLE)"
section for details. Tune the pooled-connection idle timeout with
`APPLE_MAIL_MCP_IMAP_IDLE_MS` (default `30000`; `0` = never close).

---

## Step 6 — Restart and verify

1. **Restart your MCP client** so the server picks up the new config (env and
   config-file changes are read at startup).
2. Run the **`doctor`** tool. Each configured account should report:
   `IMAP: <account> → connected to <host>`, and SMTP `configured` if you set it up.

If an account shows `connection failed`, see Troubleshooting.

---

## Upgrading from an earlier version

- **From a version with no IMAP backend (before 1.7.0):** IMAP is purely
  additive — nothing you had changes. Just follow Steps 1–6 for the accounts you
  want to accelerate.
- **From 2.0.0 / 2.1.0:** the optimizations (attachments, batch, counts/stats,
  threading) light up automatically for any account already IMAP-configured — no
  new setup needed. If you weren't using IMAP yet, follow Steps 1–6.
- **If your host app strips `env`** (e.g. Claude Desktop): upgrade to **2.1.1+**
  and move your settings into `config.json` (Method B). This is the most common
  reason an upgrade "doesn't seem to use IMAP."
- **Already had iCloud working, now adding Gmail:** remember each provider needs
  its **own** app password — an iCloud password can't authenticate Gmail.

---

## Troubleshooting

**`doctor` says "IMAP backend: not configured" after a restart.**
The server isn't seeing your settings. Most often the host stripped the `env`
block — switch to the `config.json` method (Method B) and confirm the file is at
`~/Library/Application Support/apple-mail-mcp/config.json` (or wherever
`APPLE_MAIL_MCP_CONFIG_FILE` points). Verify it parses: `python3 -m json.tool < <path>`.

**`doctor` says "connection failed" for an account.**
- The Keychain item is missing or under a different service/account. Check:
  `security find-internet-password -s imap.gmail.com -a you@gmail.com` (should
  return without "could not be found"). It must match your `KEYCHAIN_SERVICE` /
  `KEYCHAIN_ACCOUNT`.
- You used your real password instead of an **app-specific** password.
- **iCloud:** you used your Apple ID as the login instead of the iCloud mailbox
  address; try `you@icloud.com`, the `@me.com` alias, or the bare local part.
- **Workspace:** your admin disabled app passwords (or requires OAuth) — IMAP via
  app password isn't available for that account.

**Storing the Keychain password over SSH / headless fails with `User interaction is not allowed`.**
`security add-internet-password` — and the server *reading* the password back —
need the login Keychain **unlocked**, which normally only happens in a **GUI login
session**. From a plain `ssh` session the Keychain is locked, so the write fails
with `SecKeychainAddInternetPassword: User interaction is not allowed` (exit 36),
and a server started there can't read passwords either. Options:

- **Run it in a GUI session** — a Terminal on the Mac itself, or via Screen Sharing.
- **Unlock over SSH with a tty:**
  `ssh -t you@host 'security unlock-keychain && security add-internet-password -U -r imap -s imap.gmail.com -a you@gmail.com -w'`
  — the `-t` lets `unlock-keychain` prompt for your macOS **login** password, after
  which the add (and later server reads) succeed. A metadata check —
  `security find-internet-password -s … -a …` with no `-w` — does work over plain
  ssh, so you can confirm an item *exists* even when you can't unlock it.
- **Truly headless** (CI, or a server with no GUI login and no unlockable Keychain):
  skip the Keychain — set `APPLE_MAIL_MCP_SMTP_PASSWORD` / `APPLE_MAIL_MCP_IMAP_PASSWORD`
  (or a per-account `"password"` inside `APPLE_MAIL_MCP_IMAP_ACCOUNTS`) directly, and
  restrict the config file's permissions to the service account.

**Calls aren't routing to IMAP even though `doctor` shows connected.**
For the six **read** tools this should not happen since v2.6.0 — they prefer IMAP
as soon as any account is configured, with no `account` argument needed. If reads
still look like AppleScript (slow, or partial-coverage warnings), the usual cause
is that the server never saw your settings at all: a host that strips the `env`
block (use the `config.json` method), or a Keychain service/account mismatch so
the password lookup fails. Run `doctor` — it reports each account separately.

For **targeting one specific account**, and for the mailbox-write ops
(`create`/`delete`/`rename-mailbox`), the `account` argument must match the
configured account's name/login: set `APPLE_MAIL_MCP_IMAP_ACCOUNT` to the exact
Mail.app account name from `list-accounts` and pass that same `account`.

**A disabled Mail account.** IMAP connects to the server directly, so it works
even if the account is disabled in Mail.app — useful for reaching an account the
GUI is ignoring.

---

## Security notes

- **Passwords live only in the macOS Keychain.** No config file or env value
  here holds a secret — only account names, hosts, and Keychain *references*.
  (You *can* put a `password` directly in config, but don't.)
- Use **app-specific passwords** so you can revoke access per-integration without
  changing your real password.
- The `config.json` and env values are non-sensitive (addresses/hosts), but
  there's no reason to share them either.

---

## Full environment variable reference

| Variable | Purpose |
|----------|---------|
| `APPLE_MAIL_MCP_DEFAULT_ACCOUNT` | Account used when a tool omits `account` (name or email). |
| `APPLE_MAIL_MCP_IMAP_USER` | Primary IMAP login; setting it enables IMAP. |
| `APPLE_MAIL_MCP_IMAP_ACCOUNT` | Mail.app account name to match for routing (default = USER). |
| `APPLE_MAIL_MCP_IMAP_HOST` | IMAP host (default `imap.gmail.com`). |
| `APPLE_MAIL_MCP_IMAP_PORT` | IMAP port (default `993`, implicit TLS). |
| `APPLE_MAIL_MCP_IMAP_PASSWORD` | Password (discouraged; prefer Keychain). |
| `APPLE_MAIL_MCP_IMAP_KEYCHAIN_SERVICE` | Keychain item service/server name. |
| `APPLE_MAIL_MCP_IMAP_KEYCHAIN_ACCOUNT` | Keychain item account (default = USER). |
| `APPLE_MAIL_MCP_IMAP_ACCOUNTS` | JSON array of additional accounts (multi-account). |
| `APPLE_MAIL_MCP_IMAP_IDLE` | `1` to enable IMAP IDLE new-mail push. |
| `APPLE_MAIL_MCP_IMAP_IDLE_MS` | Pooled-connection idle timeout in ms (default `30000`; `0` = never close). |
| `APPLE_MAIL_MCP_SMTP_HOST` | SMTP host; setting it enables `transport:"smtp"`. |
| `APPLE_MAIL_MCP_SMTP_PORT` | SMTP port (`465` if secure, else `587`). |
| `APPLE_MAIL_MCP_SMTP_SECURE` | `true` for implicit TLS (465); else STARTTLS. |
| `APPLE_MAIL_MCP_SMTP_USER` / `_FROM` | SMTP login / From address. |
| `APPLE_MAIL_MCP_SMTP_PASSWORD` | Password (discouraged; prefer Keychain). |
| `APPLE_MAIL_MCP_SMTP_KEYCHAIN_SERVICE` / `_KEYCHAIN_ACCOUNT` | SMTP Keychain reference. |
| `APPLE_MAIL_MCP_CONFIG_FILE` | Path to the config JSON (default app-support dir). |
| `APPLE_MAIL_MCP_TEMPLATES_FILE` | Email-templates store path (default `~/Library/Application Support/apple-mail-mcp/templates.json`). |
| `APPLE_MAIL_MCP_MAX_BUFFER` | Max AppleScript (`osascript`) output buffer in bytes (default 64 MiB). |
| `APPLE_MAIL_MAX_SEARCH_MAILBOX` | Per-mailbox message-count guard for unscoped AppleScript search (default `5000`; `0` disables). Note: no `_MCP` in the name. |
