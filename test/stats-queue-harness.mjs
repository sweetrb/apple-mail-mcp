/**
 * Manual harness for issue #135 (second follow-up): does the get-mail-stats
 * deadline bound the CALL, or only the handler?
 *
 * Every tool call is serialized through the AppleScript gate (#11), so concurrent
 * calls run strictly one at a time. Before this fix the deadline clock started on
 * the handler's first line — which runs only after the gate releases — so a call
 * measured its own execution and none of the time it spent queued, while the
 * caller had been waiting since it sent the request.
 *
 * That is invisible to batch-only timing, which is all the reporter could
 * measure: N concurrent calls taking ~N x the solo cost looks the same whether
 * the client serialized dispatch or the server did. PER-CALL send->response
 * latency tells them apart, and that is what this prints.
 *
 * Measured on a 3-IMAP-account setup, ~5.2s solo cost:
 *
 *   before | default deadline | 5.5s / 10.3s / 15.6s, all `partial: false`
 *   before | deadline 6000ms  | 5.5s / 10.3s / 15.9s, last one `partial: false`
 *                               -- a 6s deadline did not bound a 15.9s call
 *   after  | deadline 6000ms  | 5.7s / 5.8s / 5.8s, the two queued calls
 *                               failing fast and naming the queue wait
 *
 * A staircase of latencies is EXPECTED and correct (the gate is deliberate). What
 * this asserts is that the staircase stays inside the deadline, and that a call
 * which spent its deadline queued says so instead of doing work whose answer will
 * land after the client has given up.
 *
 * Verified to be a real guard rather than a tautology by running it against the
 * shipped 2.10.8 bundle, which FAILS it (worst call 13.9s against a 6s deadline,
 * all three reporting `partial: false`); 2.10.9 passes. Point argv[3] at another
 * build to repeat that comparison.
 *
 * Run:  node test/stats-queue-harness.mjs [N]
 *       APPLE_MAIL_MCP_STATS_DEADLINE_MS=6000 node test/stats-queue-harness.mjs 3
 *
 * Requires a real IMAP-configured setup (it reads live mailboxes) and is
 * READ-ONLY — get-mail-stats issues IMAP STATUS / SEARCH and mutates nothing.
 */
import { spawn } from "node:child_process";

const N = Number(process.argv[2] ?? 3);
const SERVER = process.argv[3] ?? "build/index.js";
const deadlineMs = Number(process.env.APPLE_MAIL_MCP_STATS_DEADLINE_MS ?? 50_000);

const server = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
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
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p.resolve({ msg, at: Date.now() });
    }
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  const sentAt = Date.now();
  const p = new Promise((resolve) => pending.set(id, { resolve }));
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return p.then(({ msg, at }) => ({ msg, sentAt, elapsed: at - sentAt }));
}

const init = await send("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "stats-queue-harness", version: "1.0.0" },
});
console.log(`serverInfo: ${JSON.stringify(init.msg.result?.serverInfo)}`);
console.log(`deadline:   ${deadlineMs}ms`);
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

// Warm the account-enumeration cache (60s TTL) so the burst measures the
// steady-state path rather than one cold AppleScript read.
const warm = await send("tools/call", { name: "get-mail-stats", arguments: {} });
const soloMs = warm.elapsed;
console.log(`solo cost:  ${(soloMs / 1000).toFixed(1)}s (warm-up call)`);

console.log(`\nfiring ${N} concurrent unscoped get-mail-stats calls in one tick...\n`);
const batchStart = Date.now();
const results = await Promise.all(
  Array.from({ length: N }, () => send("tools/call", { name: "get-mail-stats", arguments: {} }))
);
const batch = Date.now() - batchStart;

console.log(`call  latency   partial  result`);
for (const [i, r] of results.entries()) {
  const sc = r.msg.result?.structuredContent ?? {};
  const failed = r.msg.result?.isError || r.msg.error;
  console.log(
    `#${i + 1}   ${(r.elapsed / 1000).toFixed(1).padStart(6)}s  ` +
      `${String(sc.partial ?? false).padEnd(7)}  ` +
      (failed
        ? `error: ${(r.msg.result?.content?.[0]?.text ?? JSON.stringify(r.msg.error)).slice(0, 110)}`
        : `${sc.totalMessages} msgs / ${sc.totalUnread} unread` +
          (sc.queueWaitMs ? `, queueWaitMs=${sc.queueWaitMs}` : ``) +
          (sc.failedAccounts ? `, failed=${JSON.stringify(sc.failedAccounts)}` : ``))
  );
}

const lat = results.map((r) => r.elapsed);
const maxLat = Math.max(...lat);
console.log(
  `\nbatch wall-clock: ${(batch / 1000).toFixed(1)}s` +
    `\nper-call latency: min ${(Math.min(...lat) / 1000).toFixed(1)}s  ` +
    `max ${(maxLat / 1000).toFixed(1)}s`
);

// The guarantee: the deadline is anchored at arrival, so no call may outlive it
// by more than the slack of one in-flight IMAP read. Latencies forming a
// staircase is fine; a staircase that climbs past the deadline is the bug.
const slackMs = 5000;
const overrun = lat.filter((ms) => ms > deadlineMs + slackMs);
if (overrun.length > 0) {
  console.error(
    `\nFAIL: ${overrun.length} call(s) outlived the ${deadlineMs}ms deadline ` +
      `(worst ${(maxLat / 1000).toFixed(1)}s). Queue wait is not being charged ` +
      `against the deadline — the #135 regression.`
  );
  server.kill();
  process.exit(1);
}
// A queued call must be able to see its wait; without that, the deadline has
// nothing to charge and the report explains nothing.
const queued = results.filter((r) => {
  const sc = r.msg.result?.structuredContent ?? {};
  return sc.queueWaitMs !== undefined || r.msg.result?.isError;
});
if (N > 1 && queued.length === 0 && maxLat > soloMs * 1.5) {
  console.error(
    `\nFAIL: calls clearly queued (worst ${(maxLat / 1000).toFixed(1)}s vs ` +
      `${(soloMs / 1000).toFixed(1)}s solo) but none reported queueWaitMs or an error. ` +
      `Queue wait is invisible again.`
  );
  server.kill();
  process.exit(1);
}
console.log(
  `\nPASS: every call stayed inside the ${deadlineMs}ms deadline, and ` +
    `${queued.length}/${N} reported their queue wait.`
);
server.stdin.end();
server.kill();
process.exit(0);
