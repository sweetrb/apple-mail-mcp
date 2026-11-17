/**
 * Mail.app recovery: open Mail when it is closed, restart it when it is wedged.
 *
 * Every AppleScript call goes through one synchronous osascript, so a Mail.app
 * that has stopped answering Apple Events (days of uptime, a stuck sync) makes
 * every tool fail with `AppleEvent timed out (-1712)` until somebody restarts
 * it by hand. `ensureMailReady` runs before an AppleScript call and fixes the
 * two states a restart cures:
 *
 *   - Mail is not running: open it (`open -g -a Mail`) and wait until it answers.
 *   - Mail is running but a cheap probe times out: quit it, force-kill it if it
 *     will not quit, open it again and wait until it answers.
 *
 * It never retries a failed call, so a send that timed out is never sent twice;
 * the next call simply finds a healthy Mail. A restart happens at most once per
 * RESTART_COOLDOWN_MS, and only the current user's own Mail process is touched.
 * Permission refusals (-1743) are left alone: a restart does not cure them.
 *
 * Set APPLE_MAIL_MCP_AUTO_RECOVER=0 to turn the automatic part off; the
 * `restart-mail` tool keeps working.
 *
 * @module utils/mailRecovery
 */

import { spawnSync } from "child_process";

export const AUTO_RECOVER_ENV = "APPLE_MAIL_MCP_AUTO_RECOVER";

/**
 * The test a script runs first when it must not launch Mail (`application "Mail"
 * is running` does not start the app). Such a script is not given a Mail that
 * the recovery opens for it (see `ensureMailReady`).
 */
export const MAIL_RUNNING_GUARD = 'if application "Mail" is running then';

/** Outer limit for the probe; the in-script `with timeout` fires 4 s earlier. */
const PROBE_TIMEOUT_MS = 12_000;
/** A probe that succeeded is trusted for this long. */
const HEALTHY_TTL_MS = 30_000;
/** Minimum gap between two automatic restarts. */
const RESTART_COOLDOWN_MS = 10 * 60_000;
/** How long a freshly opened Mail may take to start answering. */
const READY_WAIT_MS = 45_000;
/** How long Mail gets to quit or die before the next step. */
const STOP_WAIT_MS = 6_000;
const POLL_MS = 1_500;
/** Pause before the one retry of a failed `open`. */
const OPEN_RETRY_MS = 2_000;
/** Gap before the second probe that confirms a stalled one. */
const CONFIRM_WAIT_MS = 5_000;

// Same refusals as PERMISSION_DENIED_PATTERN in applescript.ts, repeated here
// because applescript.ts imports this module.
const PERMISSION_DENIED = /\(-1743\)|not author(?:i[sz])ed|not permitted/i;

let healthyUntil = 0;
/** After a verdict that recovery cannot act on, calls go straight through until then. */
let skipUntil = 0;
let lastRestartAt = 0;
let busy = false;

export interface RecoveryReport {
  ok: boolean;
  steps: string[];
}

type Probe = "ok" | "wedged" | "denied" | "other";

/** Automatic recovery is on unless switched off, and stays off under vitest. */
export function autoRecoverEnabled(): boolean {
  const flag = (process.env[AUTO_RECOVER_ENV] ?? "").trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(flag)) return false;
  if (["1", "true", "on", "yes"].includes(flag)) return true;
  return !process.env.VITEST;
}

/** A call just timed out: do not trust the last good probe. */
export function markMailUnhealthy(): void {
  healthyUntil = 0;
}

function sleepMs(ms: number): void {
  spawnSync("sleep", [String(ms / 1000)], { stdio: "ignore" });
}

/** PIDs of this user's Mail.app, never another user's. */
function mailPids(): number[] {
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  const result = spawnSync("pgrep", ["-u", String(uid), "-x", "Mail"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function probe(): Probe {
  const result = spawnSync(
    "osascript",
    ["-e", 'with timeout of 8 seconds\ntell application "Mail" to count of accounts\nend timeout'],
    { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL" }
  );
  if (result.status === 0) return "ok";
  const text = result.stderr ?? "";
  if (PERMISSION_DENIED.test(text)) return "denied";
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  if (timedOut || result.signal || /\(-1712\)/.test(text)) return "wedged";
  return "other";
}

function waitUntilGone(ms: number): boolean {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (mailPids().length === 0) return true;
    sleepMs(500);
  }
  return mailPids().length === 0;
}

function waitUntilAnswering(ms: number): boolean {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (mailPids().length > 0 && probe() === "ok") return true;
    sleepMs(POLL_MS);
  }
  return false;
}

function openMail(): boolean {
  const open = () => spawnSync("open", ["-g", "-a", "Mail"], { stdio: "ignore" }).status === 0;
  // Seen once right after a force-kill: `open` failed and Mail stayed closed. One retry
  // after a pause; a Mail that really cannot start fails twice and is left to the cooldown.
  return open() || (sleepMs(OPEN_RETRY_MS), open());
}

/**
 * Quit Mail (force-kill if it will not quit), open it again and wait until it
 * answers. Ignores the cooldown: this is what `restart-mail` runs.
 */
export function restartMail(): RecoveryReport {
  const steps: string[] = [];
  lastRestartAt = Date.now();
  healthyUntil = 0;
  skipUntil = 0;

  const running = mailPids();
  if (running.length === 0) {
    steps.push("Mail was not running");
  } else {
    spawnSync(
      "osascript",
      ["-e", 'with timeout of 5 seconds\ntell application "Mail" to quit\nend timeout'],
      { timeout: 8_000, killSignal: "SIGKILL", stdio: "ignore" }
    );
    if (waitUntilGone(STOP_WAIT_MS)) {
      steps.push("Mail quit normally");
    } else {
      const stuck = mailPids();
      for (const pid of stuck) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      steps.push(`Mail did not quit; force-killed pid ${stuck.join(", ")}`);
      if (!waitUntilGone(STOP_WAIT_MS)) {
        steps.push("Mail is still running after SIGKILL");
        return { ok: false, steps };
      }
    }
  }

  if (!openMail()) {
    steps.push("`open -g -a Mail` failed");
    return { ok: false, steps };
  }
  const ready = waitUntilAnswering(READY_WAIT_MS);
  steps.push(
    ready
      ? "Mail opened again and is answering Apple Events"
      : `Mail opened again but did not answer within ${READY_WAIT_MS / 1000}s`
  );
  if (ready) healthyUntil = Date.now() + HEALTHY_TTL_MS;
  return { ok: ready, steps };
}

/**
 * Called before an AppleScript call. Returns nothing: it only makes the next
 * call more likely to find Mail answering, and logs what it did to stderr.
 * `launch: false` leaves a closed Mail closed; a running one is still checked.
 *
 * `budgetMs` is the caller's own timeout. The checks (probe, confirming probe)
 * and the wait for a Mail we just opened must fit in it, so a call with a 30 s
 * timeout is not held for more than that before it even starts; a check that
 * cannot fit is skipped. A restart already decided on is not cut short: half a
 * restart (Mail quit, not reopened) is worse than a long one, and it happens at
 * most once per RESTART_COOLDOWN_MS.
 */
export function ensureMailReady(options: { launch?: boolean; budgetMs?: number } = {}): void {
  if (busy || !autoRecoverEnabled() || Date.now() < Math.max(healthyUntil, skipUntil)) return;
  const deadline = options.budgetMs === undefined ? Infinity : Date.now() + options.budgetMs;
  const left = () => deadline - Date.now();
  busy = true;
  try {
    if (mailPids().length === 0) {
      // A call that checks "Mail is running" first exists to NOT launch Mail (a
      // by-id read launched it with no accounts loaded and answered "not found"):
      // leave Mail closed and let the call say so.
      if (options.launch === false) return;
      // A Mail that cannot be launched costs READY_WAIT_MS per call: one try per cooldown.
      if (Date.now() - lastRestartAt < RESTART_COOLDOWN_MS) {
        console.error(
          "mail-recovery: Mail.app is not running; last open failed under 10 minutes ago, not retrying"
        );
        skipUntil = Date.now() + HEALTHY_TTL_MS;
        return;
      }
      console.error("mail-recovery: Mail.app is not running; opening it");
      const cut = left() < READY_WAIT_MS;
      const ready = openMail() && waitUntilAnswering(Math.min(READY_WAIT_MS, left()));
      console.error(
        `mail-recovery: ${ready ? "Mail is answering" : cut ? "Mail is still starting; the call's timeout ended the wait" : "Mail did not answer in time"}`
      );
      if (ready) healthyUntil = Date.now() + HEALTHY_TTL_MS;
      // A wait cut short by the caller's timeout says nothing about whether Mail can start.
      else if (!cut) lastRestartAt = Date.now();
      return;
    }
    if (left() < PROBE_TIMEOUT_MS) return; // a probe that stalls would outlast the call's timeout
    let state = probe();
    if (state === "wedged") {
      // A busy Mail drains an abandoned Apple Event for a while; only a probe that
      // stalls twice means it is wedged and worth quitting (a restart loses drafts).
      if (left() < CONFIRM_WAIT_MS + PROBE_TIMEOUT_MS) return; // cannot confirm in time: leave it
      sleepMs(CONFIRM_WAIT_MS);
      state = probe();
    }
    if (state === "ok") {
      healthyUntil = Date.now() + HEALTHY_TTL_MS;
      return;
    }
    if (state !== "wedged") return; // denied / unrelated failure: a restart would not help
    if (Date.now() - lastRestartAt < RESTART_COOLDOWN_MS) {
      console.error(
        "mail-recovery: Mail.app is not answering; last restart was under 10 minutes ago, not restarting"
      );
      // Not cached as healthy, but do not pay the probes again on every call.
      skipUntil = Date.now() + HEALTHY_TTL_MS;
      return;
    }
    console.error("mail-recovery: Mail.app is not answering; restarting it");
    const report = restartMail();
    console.error(`mail-recovery: ${report.steps.join("; ")}`);
    if (!report.ok) skipUntil = Date.now() + HEALTHY_TTL_MS;
  } finally {
    busy = false;
  }
}
