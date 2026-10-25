// Run with the oldest supported Node: no dependency install, provider, Keychain,
// browser, or Mail.app activity is permitted during default discovery.
import assert from "node:assert/strict";
import { mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "mail-oauth-bundle-"));
try {
  await cp("build", join(directory, "build"), { recursive: true });
  await cp("package.json", join(directory, "package.json"));
  await writeFile(join(directory, "guard.mjs"), `
    import child from "node:child_process";
    import net from "node:net";
    import tls from "node:tls";
    import { syncBuiltinESMExports } from "node:module";
    const forbidden = () => { console.error("UNEXPECTED_SIDE_EFFECT"); throw new Error("Discovery side effect"); };
    child.execFile = child.execFileSync = child.exec = child.execSync = child.spawn = forbidden;
    net.connect = net.createConnection = tls.connect = forbidden;
    globalThis.fetch = forbidden;
    syncBuiltinESMExports();
  `, "utf8");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("APPLE_MAIL_MCP_")));
  env.APPLE_MAIL_MCP_CONFIG_FILE = join(directory, "missing-config.json");
  const args = ["--import", join(directory, "guard.mjs")];
  const cli = spawnSync(process.execPath, [...args, "build/auth-cli.js"], { cwd: directory, env, encoding: "utf8", timeout: 10_000 });
  assert.equal(cli.status, 2, cli.stderr);
  assert.match(cli.stderr, /Usage: apple-mail-auth/);
  assert.doesNotMatch(cli.stderr, /UNEXPECTED_SIDE_EFFECT/);

  const server = spawn(process.execPath, [...args, "build/index.js"], { cwd: directory, env, stdio: "pipe" });
  let output = "";
  let errors = "";
  const deadline = setTimeout(() => server.kill("SIGKILL"), 10_000);
  const response = await new Promise((resolveResponse, reject) => {
    server.stderr.on("data", chunk => { errors += chunk; });
    server.stdout.on("data", chunk => {
      output += chunk;
      const lines = output.split("\n").slice(0, -1);
      for (const line of lines) {
        const message = JSON.parse(line);
        if (message.id === 2) { server.stdin.end(); resolveResponse(message); }
      }
    });
    server.on("error", reject);
    server.on("exit", code => { if (code !== 0) reject(new Error(`Server exited ${code}: ${errors}`)); });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "oauth-discovery-smoke", version: "1" } } }) + "\n");
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  });
  clearTimeout(deadline);
  assert.ok(response.result?.tools?.length > 0);
  assert.doesNotMatch(errors, /UNEXPECTED_SIDE_EFFECT/);
  server.kill("SIGTERM");
  console.log(`Standalone ${process.version}: auth CLI usage and ${response.result.tools.length} MCP tools discovered with provider/browser/Keychain/process activity forbidden.`);
  console.log(`Source bundles: ${resolve("build")}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
