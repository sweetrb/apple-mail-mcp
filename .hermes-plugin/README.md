# Apple Mail — Hermes Agent

Using the Apple Mail MCP server with [NousResearch's Hermes Agent](https://hermes-agent.nousresearch.com/).

Hermes doesn't install plugins from a repository — MCP servers are registered in `~/.hermes/config.yaml`, or via the `hermes mcp` CLI. There is no `plugin.json` / `marketplace.json` to point at; use one of the methods below.

## Add the server

**CLI (recommended):**

```bash
hermes mcp add apple-mail --command npx --args -y apple-mail-mcp
```

**Manual** — merge [`config.yaml`](./config.yaml) into `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  apple-mail:
    command: npx
    args: ["-y", "apple-mail-mcp"]
```

Restart your Hermes session afterward so the tools load.

## Requirements

- macOS — the server drives Apple Mail via AppleScript
- Node.js 18+ — `npx` fetches the published `apple-mail-mcp` package

## Nous catalog (optional)

A one-command `hermes mcp install apple-mail` would require an entry in NousResearch's [`optional-mcps/`](https://github.com/NousResearch/hermes-agent/tree/main/optional-mcps) catalog, which is added by PR to the hermes-agent repo (Nous approval required). Not needed for the methods above.
