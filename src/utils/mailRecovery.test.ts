/**
 * Tests for Mail.app recovery. child_process.spawnSync is replaced by a small
 * fake world: a list of Mail PIDs, what the probe answers and whether
 * `quit` works.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface World {
  pids: number[];
  probe: "ok" | "wedged" | "denied";
  quitWorks: boolean;
  opened: number;
  killed: number[];
  quits: number;
  /** Probes that stall before Mail answers again (a busy, not wedged, Mail). */
  wedgedProbes: number;
  /** Whether `open -g -a Mail` brings up a Mail that answers. */
  openWorks: boolean;
  /** Probes run, to see whether a call paid for one. */
  probes: number;
  /** Next `open` calls that fail before `open` starts working (a transient refusal). */
  failOpens: number;
}

let world: World;

vi.mock("child_process", () => ({
  spawnSync: vi.fn((cmd: string, args: string[]) => {
    if (cmd === "pgrep") {
      return { status: world.pids.length ? 0 : 1, stdout: world.pids.join("\n") };
    }
    if (cmd === "open") {
      world.opened += 1;
      if (!world.openWorks) return { status: 1 };
      if (world.failOpens > 0) {
        world.failOpens -= 1;
        return { status: 1 };
      }
      world.pids = [999];
      world.probe = "ok";
      return { status: 0 };
    }
    if (cmd === "osascript") {
      const script = args[1] ?? "";
      if (script.includes("to quit")) {
        world.quits += 1;
        if (world.quitWorks) world.pids = [];
        return { status: 0 };
      }
      world.probes += 1;
      if (world.wedgedProbes > 0) {
        world.wedgedProbes -= 1;
        return { status: null, signal: "SIGKILL", stderr: "" };
      }
      if (world.probe === "ok") return { status: 0, stdout: "4" };
      if (world.probe === "wedged") return { status: null, signal: "SIGKILL", stderr: "" };
      return { status: 1, stderr: "Not authorized to send Apple events to Mail. (-1743)" };
    }
    // sleep: move the fake clock so the wait loops end without real time passing
    vi.advanceTimersByTime(Number(args[0]) * 1000);
    return { status: 0 };
  }),
}));

async function load() {
  vi.resetModules();
  return import("./mailRecovery.js");
}

describe("mailRecovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    world = {
      pids: [],
      probe: "ok",
      quitWorks: true,
      opened: 0,
      killed: [],
      quits: 0,
      wedgedProbes: 0,
      openWorks: true,
      probes: 0,
      failOpens: 0,
    };
    vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      world.killed.push(pid);
      world.pids = world.pids.filter((p) => p !== pid);
      return true;
    }) as typeof process.kill);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.APPLE_MAIL_MCP_AUTO_RECOVER = "1";
  });

  afterEach(() => {
    delete process.env.APPLE_MAIL_MCP_AUTO_RECOVER;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("is off by default under vitest and obeys the switch", async () => {
    const { autoRecoverEnabled } = await load();
    delete process.env.APPLE_MAIL_MCP_AUTO_RECOVER;
    expect(autoRecoverEnabled()).toBe(false);
    process.env.APPLE_MAIL_MCP_AUTO_RECOVER = "1";
    expect(autoRecoverEnabled()).toBe(true);
    process.env.APPLE_MAIL_MCP_AUTO_RECOVER = "0";
    expect(autoRecoverEnabled()).toBe(false);
    for (const off of ["off", "No", " FALSE "]) {
      process.env.APPLE_MAIL_MCP_AUTO_RECOVER = off;
      expect(autoRecoverEnabled(), off).toBe(false);
    }
    for (const on of ["on", "Yes", "true"]) {
      process.env.APPLE_MAIL_MCP_AUTO_RECOVER = on;
      expect(autoRecoverEnabled(), on).toBe(true);
    }
  });

  it("does nothing when switched off", async () => {
    process.env.APPLE_MAIL_MCP_AUTO_RECOVER = "0";
    const { ensureMailReady } = await load();
    ensureMailReady();
    expect(world.opened).toBe(0);
  });

  it("opens Mail when it is not running", async () => {
    const { ensureMailReady } = await load();
    ensureMailReady();
    expect(world.opened).toBe(1);
    expect(world.quits).toBe(0);
  });

  it("does not open a closed Mail for a call that must not launch it", async () => {
    const { ensureMailReady } = await load();
    ensureMailReady({ launch: false });
    expect(world.opened).toBe(0);
  });

  it("still restarts a wedged Mail for a call that must not launch it", async () => {
    world.pids = [123];
    world.probe = "wedged";
    const { ensureMailReady } = await load();
    ensureMailReady({ launch: false });
    expect(world.opened).toBe(1);
  });

  it("leaves a healthy Mail alone and trusts the probe for a while", async () => {
    world.pids = [123];
    const { ensureMailReady } = await load();
    ensureMailReady();
    world.probe = "wedged"; // inside the TTL: not probed again
    ensureMailReady();
    expect(world.opened).toBe(0);
    expect(world.quits).toBe(0);
  });

  it("restarts a wedged Mail: quit, force-kill, open again", async () => {
    world.pids = [123];
    world.probe = "wedged";
    world.quitWorks = false;
    const { ensureMailReady } = await load();
    ensureMailReady();
    expect(world.quits).toBe(1);
    expect(world.killed).toEqual([123]);
    expect(world.opened).toBe(1);
  });

  it("does not restart a busy Mail that answers the confirming probe", async () => {
    world.pids = [123];
    world.wedgedProbes = 1;
    const { ensureMailReady } = await load();
    ensureMailReady();
    expect(world.quits).toBe(0);
    expect(world.killed).toEqual([]);
    expect(world.opened).toBe(0);
  });

  it("does not force-kill when Mail quits normally", async () => {
    world.pids = [123];
    world.probe = "wedged";
    const { ensureMailReady } = await load();
    ensureMailReady();
    expect(world.killed).toEqual([]);
    expect(world.opened).toBe(1);
  });

  it("skips the probe when the call's timeout is shorter than a stalled probe", async () => {
    world.pids = [123];
    world.probe = "wedged";
    const { ensureMailReady } = await load();
    ensureMailReady({ budgetMs: 5_000 });
    expect(world.probes).toBe(0);
    expect(world.quits).toBe(0);
  });

  it("does not restart on one stalled probe it has no time to confirm", async () => {
    world.pids = [123];
    world.probe = "wedged";
    const { ensureMailReady } = await load();
    ensureMailReady({ budgetMs: 15_000 });
    expect(world.probes).toBe(1);
    expect(world.quits).toBe(0);
    expect(world.opened).toBe(0);
  });

  it("runs a restart it decided on to the end, whatever the budget left", async () => {
    world.pids = [123];
    world.probe = "wedged";
    const { ensureMailReady } = await load();
    ensureMailReady({ budgetMs: 30_000 });
    expect(world.quits).toBe(1);
    expect(world.opened).toBe(1);
  });

  it("a wait cut short by the call's timeout does not start the open cooldown", async () => {
    world.openWorks = false;
    const { ensureMailReady } = await load();
    ensureMailReady({ budgetMs: 1_000 });
    ensureMailReady({ budgetMs: 1_000 });
    expect(world.opened).toBe(4); // two calls, each `open` plus its retry
  });

  it("restarts at most once per cooldown", async () => {
    world.pids = [123];
    world.probe = "wedged";
    const { ensureMailReady, markMailUnhealthy } = await load();
    ensureMailReady();
    expect(world.opened).toBe(1);
    world.probe = "wedged";
    markMailUnhealthy();
    ensureMailReady();
    expect(world.opened).toBe(1);
  });

  it("does not pay the probes again on every call once a restart was refused", async () => {
    world.pids = [123];
    world.probe = "wedged";
    const { ensureMailReady, markMailUnhealthy } = await load();
    ensureMailReady(); // restarts
    world.probe = "wedged";
    markMailUnhealthy();
    ensureMailReady(); // cooldown: refused, probes paid once
    const probes = world.probes;
    markMailUnhealthy();
    ensureMailReady(); // inside the same window: straight through
    expect(world.probes).toBe(probes);
    expect(world.opened).toBe(1);
  });

  it("tries to launch a Mail that will not start once per cooldown", async () => {
    world.openWorks = false;
    const { ensureMailReady } = await load();
    ensureMailReady();
    ensureMailReady();
    expect(world.opened).toBe(2); // one try is `open` plus its single retry
  });

  it("retries a failed open once, so a transient refusal does not leave Mail closed", async () => {
    world.failOpens = 1;
    const { ensureMailReady } = await load();
    ensureMailReady();
    expect(world.opened).toBe(2);
    expect(world.pids).toEqual([999]);
  });

  it("does not restart for a permission refusal", async () => {
    world.pids = [123];
    world.probe = "denied";
    const { ensureMailReady } = await load();
    ensureMailReady();
    expect(world.quits).toBe(0);
    expect(world.opened).toBe(0);
  });

  it("restartMail reports its steps and ignores the cooldown", async () => {
    world.pids = [123];
    const { restartMail } = await load();
    const first = restartMail();
    const second = restartMail();
    expect(first.ok).toBe(true);
    expect(first.steps[0]).toBe("Mail quit normally");
    expect(second.ok).toBe(true);
    expect(world.opened).toBe(2);
  });
});
