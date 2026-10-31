/**
 * The build in a real child process. The server is bundled from src/index.ts
 * with esbuild, the way `pnpm run build` bundles it, into a temp dir with no
 * package.json above it (so builder mode must stop before the server reads
 * one), and forked in builder mode against a synthetic mail store. Every wait
 * is bounded.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { fork, spawn, type ChildProcess } from "child_process";
import { build as esbuild } from "esbuild";
import { BODY_INDEX_SCHEMA_VERSION, BodyIndexWriter } from "@/utils/bodyIndex.js";
import {
  BODY_INDEX_BUILDER_ARG,
  BUILDER_PROTOCOL,
  type BuilderReport,
} from "@/utils/bodyIndexBuild.js";
import {
  PAUSE_MS,
  STOP_GRACE_MS,
  BUILD_RESTART_MS,
  bodyIndexStatus,
  builderExecArgv,
  childProcessRunner,
  isBodyIndexBuilding,
  prepareBodySearch,
  resetBodyIndexForTests,
  startBackgroundIndexing,
  type BuildRunner,
  type WatchFn,
} from "@/utils/bodyIndexSync.js";
import { searchEnvelopeIndex } from "@/utils/envelopeIndex.js";
import {
  buildEnvelopeIndex,
  plainMessage,
  sqlite,
  writeEmlx,
} from "@/utils/envelopeIndex.testFixture.js";

const describeIfSqlite = sqlite ? describe : describe.skip;

const MESSAGES = 30;
const noWatch: WatchFn = () => ({ close() {} });

let bundleDir: string;
let bundle: string;

beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), "bodyidx-child-bundle-"));
  bundle = join(bundleDir, "index.mjs");
  await esbuild({
    entryPoints: [fileURLToPath(new URL("../index.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: bundle,
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: "silent",
  });
}, 30_000);
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

// Captured before any test fakes timers, so waits stay real under fake timers.
const realSetTimeout = globalThis.setTimeout;
const realWait = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));

/** Wait for `cond` in real time; fails after `ms`. */
async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`timed out after ${ms} ms`);
    await realWait(5);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wrap a runner to record what the build reported and when it was stopped. */
function recording(pick: (startIndex: number) => BuildRunner) {
  const reports: (BuilderReport | Record<string, unknown>)[] = [];
  const exits: string[] = [];
  const stops: Promise<void>[] = [];
  let starts = 0;
  const runner: BuildRunner = {
    runsOn: "child process",
    start(init, events) {
      const h = pick(starts++).start(init, {
        report: (m) => {
          reports.push(m);
          events.report(m);
        },
        exit: (why) => {
          exits.push(why);
          events.exit(why);
        },
      });
      return {
        post: h.post,
        stop: () => {
          const p = h.stop();
          stops.push(p);
          return p;
        },
      };
    },
  };
  return { runner, reports, exits, stops, starts: () => starts };
}

const saved = { ...process.env };
let root: string;
let v10: string;
let envIndex: string;
let indexFile: string;

function find(text: string): number[] {
  const ready = prepareBodySearch();
  if (!ready.ok) throw new Error(ready.reason);
  const r = searchEnvelopeIndex(
    { accountId: "ACC", limit: 100, mailbox: "INBOX", body: { text, indexFile: ready.file } },
    { indexPath: envIndex, sqlite }
  );
  if (!r.ok) throw new Error(r.reason);
  return r.rows.map((m) => m.id);
}

describe("builderExecArgv", () => {
  const quiet = "--disable-warning=ExperimentalWarning";
  it("carries over only --experimental-sqlite, from the command line or NODE_OPTIONS", () => {
    expect(builderExecArgv([], undefined)).toEqual([quiet]);
    expect(
      builderExecArgv(["--inspect=9229", "--max-old-space-size=4096"], "--trace-warnings")
    ).toEqual([quiet]);
    expect(builderExecArgv(["--experimental-sqlite"], undefined)).toEqual([
      "--experimental-sqlite",
      quiet,
    ]);
    expect(builderExecArgv([], "--no-warnings --experimental-sqlite")).toEqual([
      "--experimental-sqlite",
      quiet,
    ]);
  });

  it("silences Node's SQLite ExperimentalWarning, which would print on every fork", () => {
    expect(builderExecArgv([], undefined)).toContain(quiet);
  });
});

describeIfSqlite("the build in a child process", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bodyidx-child-"));
    v10 = join(root, "V10");
    mkdirSync(join(v10, "MailData"), { recursive: true });
    envIndex = join(v10, "MailData", "Envelope Index");
    const ids = Array.from({ length: MESSAGES }, (_, i) => i + 1);
    buildEnvelopeIndex(
      envIndex,
      ids.map((id) => ({
        id,
        account: "ACC",
        mailbox: "INBOX",
        subject: `m${id}`,
        address: "a@x.com",
        received: 1_700_000_000 + id,
      }))
    );
    for (const id of ids) {
      writeEmlx(v10, "ACC", "INBOX", id, plainMessage("a", `harbour note ${id}`));
    }
    indexFile = join(root, "support", "body.db");
    process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
    process.env.APPLE_MAIL_MCP_BODY_INDEX = "1";
    process.env.APPLE_MAIL_MCP_MAIL_DIR = root;
    process.env.APPLE_MAIL_MCP_BODY_INDEX_FILE = indexFile;
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await resetBodyIndexForTests();
    process.env = { ...saved };
    rmSync(root, { recursive: true, force: true });
  });

  it("walks and parses in the child, not in the server, and the child exits once caught up", async () => {
    const walkStep = vi.spyOn(BodyIndexWriter.prototype, "walkStep");
    const indexStep = vi.spyOn(BodyIndexWriter.prototype, "indexStep");
    const rec = recording(() => childProcessRunner(bundle));
    await resetBodyIndexForTests({ watch: noWatch, runner: rec.runner });
    startBackgroundIndexing();
    await until(() => rec.stops.length === 1);
    await rec.stops[0]; // resolved on the child's "exit"
    expect(rec.reports.map((r) => r.type)).toEqual(["ready", "walked", "idle"]);
    const ready = rec.reports[0] as Extract<BuilderReport, { type: "ready" }>;
    expect(ready.pid).not.toBe(process.pid);
    expect(alive(ready.pid)).toBe(false);
    expect(rec.exits).toEqual([]); // stopped by the server, not crashed
    // The spies see the server's module only; the child loads its own copy.
    expect(walkStep).not.toHaveBeenCalled();
    expect(indexStep).not.toHaveBeenCalled();
    expect(isBodyIndexBuilding()).toBe(false);
    expect(bodyIndexStatus()).toMatchObject({
      build: { runsOn: "child process", running: false },
      counts: { indexed: MESSAGES, queued: 0 },
    });
    expect(find("harbour")).toHaveLength(MESSAGES);
    // What the child's connection created is as private as the rest.
    for (const p of [indexFile, `${indexFile}-wal`, `${indexFile}-shm`]) {
      if (existsSync(p)) expect(statSync(p).mode & 0o777).toBe(0o600);
    }
  }, 30_000);

  it("forks the given bundle with the builder flag, an empty environment, no Node flags and stdout discarded", async () => {
    const probe = join(root, "probe.mjs");
    writeFileSync(
      probe,
      `import { fstatSync, statSync } from "fs";
       process.on("message", (m) => {
         if (m.type !== "start") return;
         process.stdout.write("this must not reach the MCP stream\\n");
         process.send({
           type: "probe",
           argv: process.argv.slice(2),
           execArgv: process.execArgv,
           env: Object.keys(process.env),
           stdoutIsDevNull: fstatSync(1).rdev === statSync("/dev/null").rdev,
           init: m.init,
         });
       });
       process.on("disconnect", () => process.exit(0));`
    );
    process.env.AMCP_SECRET_SENTINEL = "must not be inherited";
    const rec = recording(() => childProcessRunner(probe));
    await resetBodyIndexForTests({ watch: noWatch, runner: rec.runner });
    startBackgroundIndexing();
    await until(() => rec.reports.length === 1);
    // macOS adds __CF_USER_TEXT_ENCODING to every process; nothing else may be there.
    const probed = rec.reports[0] as { env: string[] };
    expect(probed.env.filter((k) => k !== "__CF_USER_TEXT_ENCODING")).toEqual([]);
    expect(rec.reports[0]).toEqual({
      type: "probe",
      argv: [BODY_INDEX_BUILDER_ARG],
      execArgv: ["--disable-warning=ExperimentalWarning"],
      env: probed.env,
      stdoutIsDevNull: true,
      init: {
        versionDir: v10,
        indexPath: indexFile,
        sliceMs: 50,
        pauseMs: 100,
        protocol: BUILDER_PROTOCOL,
        schemaVersion: BODY_INDEX_SCHEMA_VERSION,
      },
    });
  }, 30_000);

  it("in builder mode the server bundle never starts the MCP server, and exits when the channel closes", async () => {
    const child = fork(bundle, [BODY_INDEX_BUILDER_ARG], {
      env: {},
      execArgv: [],
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    child.stdin!.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    const report = new Promise((r) => child.once("message", r));
    child.send({
      type: "start",
      init: {
        versionDir: v10,
        indexPath: indexFile,
        sliceMs: 50,
        pauseMs: 100,
        protocol: BUILDER_PROTOCOL,
        schemaVersion: BODY_INDEX_SCHEMA_VERSION,
      },
    });
    // No index file yet: it reports instead of creating one. It read no config, wrote no stdout.
    expect(await report).toMatchObject({ type: "failed", where: "open" });
    expect(existsSync(indexFile)).toBe(false);
    await realWait(300);
    expect(out).toBe("");
    child.disconnect();
    expect(await exited).toBe(0);
  }, 30_000);

  it("a real build process refuses a server of another version, before touching anything", async () => {
    const child = fork(bundle, [BODY_INDEX_BUILDER_ARG], {
      env: {},
      execArgv: [],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    const report = new Promise((r) => child.once("message", r));
    child.send({
      type: "start",
      init: {
        versionDir: v10,
        indexPath: indexFile,
        sliceMs: 50,
        pauseMs: 100,
        protocol: BUILDER_PROTOCOL + 1,
        schemaVersion: BODY_INDEX_SCHEMA_VERSION,
      },
    });
    expect(await report).toMatchObject({ type: "failed", where: "version" });
    expect(existsSync(indexFile)).toBe(false);
    child.disconnect();
    expect(await exited).toBe(0);
  }, 30_000);

  it("the build process exits when the server process dies", async () => {
    const server = join(root, "server.mjs");
    writeFileSync(
      server,
      `import { fork } from "child_process";
       const c = fork(process.argv[2], [process.argv[3]], { env: {}, execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });
       process.stdout.write(String(c.pid) + "\\n");
       setInterval(() => {}, 1000);`
    );
    const s: ChildProcess = spawn(process.execPath, [server, bundle, BODY_INDEX_BUILDER_ARG], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const pid = await new Promise<number>((r) =>
      s.stdout!.once("data", (d) => r(Number(String(d))))
    );
    await realWait(300);
    expect(alive(pid)).toBe(true);
    s.kill("SIGKILL");
    await until(() => !alive(pid), 10_000);
  }, 30_000);

  it("a build process that crashes is noted and restarted; the server never waits on it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const crash = join(root, "crash.mjs");
    writeFileSync(
      crash,
      `process.on("message", (m) => {
         if (m.type !== "start") return;
         process.send({ type: "ready", pid: process.pid });
         setImmediate(() => { throw new Error("boom in the build process"); });
       });`
    );
    const rec = recording((n) => childProcessRunner(n === 0 ? crash : bundle));
    await resetBodyIndexForTests({ watch: noWatch, runner: rec.runner });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    startBackgroundIndexing();
    vi.advanceTimersByTime(PAUSE_MS);
    expect(isBodyIndexBuilding()).toBe(true);
    // A search while it runs answers at once, without indexing in the server.
    const t0 = performance.now();
    expect(prepareBodySearch()).toEqual({ ok: true, file: indexFile });
    expect(performance.now() - t0).toBeLessThan(500);
    await until(() => rec.exits.length === 1);
    expect(rec.exits[0]).toBe("exit code 1");
    expect(isBodyIndexBuilding()).toBe(false);
    expect(bodyIndexStatus().lastError).toMatch(
      /build process stopped unexpectedly \(exit code 1\)/
    );
    expect(rec.starts()).toBe(1);
    vi.advanceTimersByTime(BUILD_RESTART_MS + 1);
    expect(rec.starts()).toBe(2);
    await until(() => rec.reports.some((r) => r.type === "idle"));
    expect(isBodyIndexBuilding()).toBe(false);
    err.mockRestore();
    expect(find("harbour")).toHaveLength(MESSAGES);
  }, 30_000);

  it("a Node binary that can't be spawned is noted once, and the build runs on the main thread", async () => {
    const rec = recording(() =>
      childProcessRunner(bundle, { execPath: join(root, "missing", "node") })
    );
    await resetBodyIndexForTests({ watch: noWatch, runner: rec.runner });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    startBackgroundIndexing();
    await until(() => !isBodyIndexBuilding() && bodyIndexStatus().counts?.indexed === MESSAGES);
    log.mockRestore();
    expect(rec.exits).toEqual([expect.stringMatching(/ENOENT/)]);
    expect(bodyIndexStatus().build?.fallback).toMatch(/could not start \(.*ENOENT/);
    expect(find("harbour")).toHaveLength(MESSAGES);
  }, 30_000);

  it("a build process that ignores its closed channel is killed after the grace period", async () => {
    const stubborn = join(root, "stubborn.mjs");
    writeFileSync(
      stubborn,
      `process.on("message", (m) => {
         if (m.type === "start") process.send({ type: "ready", pid: process.pid });
       });
       process.on("disconnect", () => {}); // and stays
       setInterval(() => {}, 1000);`
    );
    const reports: BuilderReport[] = [];
    const handle = childProcessRunner(stubborn).start(
      {
        versionDir: v10,
        indexPath: indexFile,
        sliceMs: 50,
        pauseMs: 100,
        protocol: BUILDER_PROTOCOL,
        schemaVersion: BODY_INDEX_SCHEMA_VERSION,
      },
      { report: (m) => reports.push(m), exit: () => {} }
    );
    await until(() => reports.length === 1);
    const pid = (reports[0] as Extract<BuilderReport, { type: "ready" }>).pid;
    const t0 = performance.now();
    await handle.stop();
    const took = performance.now() - t0;
    expect(alive(pid)).toBe(false);
    expect(took).toBeGreaterThanOrEqual(STOP_GRACE_MS - 50);
    expect(took).toBeLessThan(STOP_GRACE_MS + 5_000);
    await handle.stop(); // already gone: returns at once
  }, 30_000);

  it("a bundle replaced on disk after the server loaded it is not run: the build stays on the main thread", async () => {
    // The server loaded this copy; an update then rewrites it in place.
    const copy = join(root, "copy.mjs");
    writeFileSync(copy, readFileSync(bundle));
    const loaded = childProcessRunner(copy); // as the server's is, at startup
    appendFileSync(copy, "\n// a newer release\n");
    const rec = recording(() => loaded);
    await resetBodyIndexForTests({ watch: noWatch, runner: rec.runner });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    startBackgroundIndexing();
    await until(() => bodyIndexStatus().build?.fallback !== undefined);
    expect(bodyIndexStatus().build?.fallback).toMatch(
      /^the server's files were replaced on disk after it started .*; building on the main thread$/
    );
    await until(() => !isBodyIndexBuilding() && bodyIndexStatus().counts!.indexed === MESSAGES);
    log.mockRestore();
    expect(rec.starts()).toBe(1);
    expect(find("harbour")).toHaveLength(MESSAGES);
  }, 30_000);

  it("a build process that can't load is noted once, and the build runs on the main thread", async () => {
    const rec = recording(() => childProcessRunner(join(root, "missing", "index.js")));
    await resetBodyIndexForTests({ watch: noWatch, runner: rec.runner });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    startBackgroundIndexing();
    await until(() => bodyIndexStatus().build?.fallback !== undefined);
    expect(bodyIndexStatus().build?.fallback).toMatch(
      /^build process could not start \(exit code 1\); building on the main thread$/
    );
    await until(() => !isBodyIndexBuilding() && bodyIndexStatus().counts!.indexed === MESSAGES);
    err.mockRestore();
    log.mockRestore();
    expect(rec.starts()).toBe(1);
    expect(bodyIndexStatus().build).toMatchObject({ runsOn: "main thread", running: false });
    expect(find("harbour")).toHaveLength(MESSAGES);
  }, 30_000);
});

/** A process that holds a write transaction on the index, as a build process would mid-slice. */
const HOLDER = `
  const { DatabaseSync } = require("node:sqlite");
  let db;
  process.on("message", (cmd) => {
    if (cmd.open) {
      db = new DatabaseSync(cmd.open);
      db.exec("PRAGMA busy_timeout = 0");
      process.send("open");
    } else if (cmd.hold !== undefined) {
      db.exec("BEGIN IMMEDIATE");
      db.exec("INSERT INTO meta (key, value) VALUES ('lastError', 'uncommitted')");
      process.send("holding");
      if (cmd.hold === null) for (;;) {} // until killed
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, cmd.hold);
      db.exec("COMMIT");
      process.send("committed");
    } else if (cmd.write) {
      db.exec("INSERT INTO meta (key, value) VALUES ('lastRebuild', 'x') ON CONFLICT(key) DO UPDATE SET value = 'y'");
      process.send("written");
    }
  });
  process.on("disconnect", () => process.exit(0));
`;

describeIfSqlite("two writer connections: the server and its build process", () => {
  let dir: string;
  let store: string;
  let path: string;
  let main: BodyIndexWriter;
  let holder: ChildProcess | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bodyidx-twowriters-"));
    store = join(dir, "V10");
    path = join(dir, "body.db");
    writeEmlx(store, "ACC", "INBOX", 1, plainMessage("a", "harbour"));
    const opened = BodyIndexWriter.open(store, path, sqlite!);
    if ("reason" in opened) throw new Error(opened.reason);
    main = opened;
  });
  afterEach(async () => {
    if (holder && holder.exitCode === null && holder.signalCode === null) {
      const gone = new Promise((r) => holder!.once("exit", r));
      holder.kill("SIGKILL");
      await gone;
    }
    holder = null;
    main.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function startHolder(): Promise<ChildProcess> {
    const script = join(dir, "holder.cjs");
    writeFileSync(script, HOLDER);
    holder = fork(script, [], {
      env: {},
      execArgv: [],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    holder.send({ open: path });
    expect(await next(holder)).toBe("open");
    return holder;
  }
  const next = (c: ChildProcess) => new Promise<unknown>((r) => c.once("message", r));
  const emlxPath = () =>
    join(store, "ACC", "INBOX.mbox", "STORE-UUID", "Data", "Messages", "1.emlx");

  it("the server's write waits for the build process's transaction instead of failing", async () => {
    const h = await startHolder();
    h.send({ hold: 300 });
    expect(await next(h)).toBe("holding");
    const committed = next(h);
    const t0 = performance.now();
    main.applyChanges([emlxPath()]); // BEGIN IMMEDIATE under busy_timeout
    const waited = performance.now() - t0;
    expect(await committed).toBe("committed");
    expect(waited).toBeGreaterThan(150);
    expect(waited).toBeLessThan(5_000);
    expect(main.state().counts.queued).toBe(1);
  }, 30_000);

  it("why IMMEDIATE: a deferred transaction that read first fails at once, busy_timeout or not", async () => {
    const h = await startHolder();
    const reader = new sqlite!.DatabaseSync(path);
    reader.exec("PRAGMA busy_timeout = 5000");
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) AS n FROM docs").get(); // its snapshot
      h.send({ write: true });
      expect(await next(h)).toBe("written"); // the other connection commits
      const t0 = performance.now();
      expect(() => reader.exec("INSERT INTO docs VALUES (9, 'p', 0, 0, 0)")).toThrow(
        /database is locked/
      );
      expect(performance.now() - t0).toBeLessThan(1_000);
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
    }
  }, 30_000);

  it("a build process killed mid-transaction leaves no lock and no half-written data", async () => {
    const probe = new sqlite!.DatabaseSync(path);
    probe.exec("PRAGMA busy_timeout = 0");
    try {
      const h = await startHolder();
      h.send({ hold: null });
      expect(await next(h)).toBe("holding");
      expect(() => probe.exec("BEGIN IMMEDIATE")).toThrow(/database is locked/);
      const gone = new Promise((r) => h.once("exit", r));
      h.kill("SIGKILL");
      await gone;
      holder = null;
      probe.exec("BEGIN IMMEDIATE"); // free at once
      probe.exec("ROLLBACK");
      expect(main.state().meta.lastError).toBeUndefined();
      const t0 = performance.now();
      main.applyChanges([emlxPath()]);
      expect(performance.now() - t0).toBeLessThan(1_000);
    } finally {
      probe.close();
    }
  }, 30_000);
});
