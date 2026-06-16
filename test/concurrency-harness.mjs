/**
 * Manual concurrency harness for issue #11.
 *
 * Boots the built server over stdio and fires a burst of concurrent tool calls
 * in a single write — the scenario that previously cascaded into -32001
 * "Request timed out" errors and left Mail.app wedged. Asserts every call
 * resolves (success or a clean tool error, never a transport timeout) and that
 * a health-check issued mid-burst still returns.
 *
 * Run: node test/concurrency-harness.mjs
 */
import { spawn } from "node:child_process";

const server = spawn("node", ["build/index.js"], { stdio: ["pipe", "pipe", "pipe"] });
server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

const pending = new Map();
let buf = "";
server.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function send(method, params, timeoutMs = 35000) {
  const id = nextId++;
  const t0 = Date.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ id, _timedOut: true, _ms: Date.now() - t0 });
    }, timeoutMs);
    pending.set(id, {
      resolve: (m) => {
        clearTimeout(timer);
        resolve({ ...m, _ms: Date.now() - t0 });
      },
    });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function summarize(label, r) {
  if (r._timedOut) return `${label}: ✗ TRANSPORT TIMEOUT after ${r._ms}ms`;
  const isErr = r.result?.isError;
  const text = r.result?.content?.[0]?.text?.split("\n")[0]?.slice(0, 60) ?? JSON.stringify(r).slice(0, 60);
  return `${label}: ${isErr ? "⚠ tool-error" : "✓"} (${r._ms}ms) ${text}`;
}

const call = (name, args = {}) => send("tools/call", { name, arguments: args });

async function main() {
  // Handshake
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "concurrency-harness", version: "0" },
  });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // Burst: 6 concurrent Mail.app-touching calls, fired in one tick, PLUS a
  // health-check injected into the middle of the burst to test liveness.
  const burst = [
    call("search-messages", { query: "the", limit: 5 }),
    call("get-unread-count", {}),
    call("list-mailboxes", {}),
    call("search-messages", { query: "a", limit: 5 }),
    call("health-check", {}),
    call("get-mail-stats", {}),
    call("list-accounts", {}),
    call("search-messages", { query: "meeting", limit: 5 }),
  ];
  const labels = [
    "search:the",
    "unread-count",
    "list-mailboxes",
    "search:a",
    "health-check",
    "mail-stats",
    "list-accounts",
    "search:meeting",
  ];

  const results = await Promise.all(burst);
  console.log("\n=== Concurrent burst results (8 calls fired at once) ===");
  results.forEach((r, i) => console.log("  " + summarize(labels[i], r)));

  const timeouts = results.filter((r) => r._timedOut);
  const ok = results.filter((r) => !r._timedOut);
  console.log(`\nResolved without transport timeout: ${ok.length}/${results.length}`);
  console.log(`Transport timeouts (the #11 failure mode): ${timeouts.length}`);

  server.kill();
  process.exit(timeouts.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  server.kill();
  process.exit(1);
});
