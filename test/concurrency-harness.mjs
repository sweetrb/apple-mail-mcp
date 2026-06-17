/**
 * Manual concurrency harness for issue #11 (recalibrated 2026-06-17).
 *
 * Issue #11: concurrent tool calls caused cascading 30s timeouts. Parallel
 * `tell application "Mail"` dispatches piled up inside Mail.app's
 * single-threaded AppleScript handler, the later ones blew past their
 * timeouts while earlier ones were still draining, and even cheap calls got
 * dragged into the cascade — leaving Mail.app wedged for the next batch.
 *
 * The fix (src/utils/serialize.ts + the `with timeout` / SIGKILL changes in
 * src/utils/applescript.ts) trades concurrency for stability: calls run one at
 * a time, Mail.app's dispatch queue never piles up, each osascript is bounded
 * and reaped, and the server stays responsive to protocol traffic throughout.
 *
 * This harness proves that guarantee directly. It fires a burst of Mail.app-
 * touching calls in a single tick, injects a health-check into the middle of
 * the burst, and asserts:
 *   1. ZERO transport timeouts — the #11 cascade failure mode (a call that
 *      never gets a response, distinct from a clean tool-error).
 *   2. The mid-burst health-check stays live (responds quickly) — proves the
 *      server is not blocked while the batch drains.
 *   3. A follow-up call after the burst resolves promptly — proves Mail.app is
 *      not left wedged.
 *
 * Deliberate scoping decisions:
 *   - It does NOT use the multi-account `search-messages` path. That op is
 *     independently slow/broken (25-60s per account, returns empty) on real
 *     multi-account setups — a separate bug from #11 — and firing several of
 *     them would blow any client window for reasons unrelated to concurrency,
 *     masking the actual signal. Contention here comes from call VOLUME (many
 *     concurrent osascript spawns), which is exactly the #11 trigger.
 *   - Every account-scoped call targets a single PERSONAL account (default
 *     "iCloud"; override with HARNESS_ACCOUNT or argv[2]). The harness refuses
 *     to run against non-personal/client accounts (e.g. an Exchange account).
 *
 * Run:  node test/concurrency-harness.mjs            (defaults to iCloud)
 *       HARNESS_ACCOUNT="rob@example.com" node test/concurrency-harness.mjs
 */
import { spawn } from "node:child_process";

const ACCOUNT = process.env.HARNESS_ACCOUNT || process.argv[2] || "iCloud";

// Guardrail: never exercise a client / non-personal account.
if (/service\s*express|serviceexpress|exchange/i.test(ACCOUNT)) {
  console.error(
    `Refusing to run against non-personal account "${ACCOUNT}". ` +
      `Pass a personal account via HARNESS_ACCOUNT or argv[2].`
  );
  process.exit(2);
}

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
// Generous per-call window: the #11 failure is a NEVER-answered call, not a
// slow one. Serialized real calls can legitimately take a while; only a call
// that never returns counts as the cascade failure mode.
function send(method, params, timeoutMs = 60000) {
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

  // Burst: 10 Mail.app-touching calls fired in one tick. Each spawns its own
  // `tell application "Mail"` osascript — the concurrent-dispatch contention
  // that issue #11 is about. A health-check sits in the MIDDLE of the burst as
  // a liveness probe: under the bug it would be dragged into the cascade; under
  // the fix it must still return quickly.
  const A = ACCOUNT;
  const spec = [
    ["unread-count#1", "get-unread-count", { account: A }],
    ["list-mailboxes#1", "list-mailboxes", { account: A }],
    ["list-accounts#1", "list-accounts", {}],
    ["list-messages#1", "list-messages", { account: A, limit: 5 }],
    ["health-check(mid)", "health-check", {}],
    ["unread-count#2", "get-unread-count", { account: A }],
    ["list-mailboxes#2", "list-mailboxes", { account: A }],
    ["list-messages#2", "list-messages", { account: A, limit: 5, unreadOnly: true }],
    ["list-accounts#2", "list-accounts", {}],
    ["unread-count#3", "get-unread-count", { account: A }],
  ];

  console.log(`\n=== Concurrent burst: ${spec.length} calls fired at once (account: ${A}) ===`);
  const results = await Promise.all(spec.map(([, name, args]) => call(name, args)));
  results.forEach((r, i) => console.log("  " + summarize(spec[i][0], r)));

  const timeouts = results.filter((r) => r._timedOut);
  const health = results[spec.findIndex(([l]) => l.startsWith("health-check"))];

  // Post-burst liveness: Mail.app must not be wedged once the batch drains.
  const after = await call("get-unread-count", { account: A });
  console.log("\n" + summarize("post-burst unread-count", after));

  const healthOk = !health._timedOut && health._ms < 8000;
  const afterOk = !after._timedOut;

  console.log(`\nTransport timeouts (the #11 cascade failure mode): ${timeouts.length}`);
  console.log(`Mid-burst health-check stayed live (<8s): ${healthOk ? "yes" : "NO"} (${health._ms}ms)`);
  console.log(`Mail.app not wedged after burst: ${afterOk ? "yes" : "NO"}`);

  const pass = timeouts.length === 0 && healthOk && afterOk;
  console.log(`\nRESULT: ${pass ? "✓ PASS" : "✗ FAIL"}`);

  server.kill();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  server.kill();
  process.exit(1);
});
