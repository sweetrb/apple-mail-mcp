/**
 * Body index sync: the writer role, the watcher and the background loop, all on
 * a synthetic mail store with an injected watcher and clock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { spawn } from "child_process";
import { join } from "path";
import {
  BUILD_STALL_MS,
  FALLBACK_RETRY_MS,
  PAUSE_MS,
  RESCAN_WATCHED_MS,
  SEARCH_CATCHUP_MAX_BYTES,
  SEARCH_CATCHUP_MS,
  SLICE_MS,
  WATCH_DEBOUNCE_MS,
  BUILD_RESTART_MS,
  WRITER_RETRY_MS,
  bodyIndexStatus,
  bodyIndexUnavailable,
  isBodyIndexBuilding,
  isBodyIndexEnabled,
  isBodyIndexWatching,
  isBodyIndexWriter,
  mainThreadRunner,
  nextTickDelay,
  type BuildEvents,
  type BuildRunner,
  prepareBodySearch,
  resetBodyIndexForTests as resetForTests,
  startBackgroundIndexing,
  stopBodyIndexing,
  type WatchFn,
} from "@/utils/bodyIndexSync.js";
import { BODY_INDEX_SCHEMA_VERSION, bodyIndexLockPath, type Clock } from "@/utils/bodyIndex.js";
import {
  BUILDER_PROTOCOL,
  HEARTBEAT_MS,
  type BuilderInit,
  type BuilderWork,
} from "@/utils/bodyIndexBuild.js";
import { FULL_DISK_ACCESS_REASON, searchEnvelopeIndex } from "@/utils/envelopeIndex.js";
import {
  buildEnvelopeIndex,
  plainMessage,
  sqlite,
  writeEmlx,
  type FixtureMessage,
} from "@/utils/envelopeIndex.testFixture.js";

const describeIfSqlite = sqlite ? describe : describe.skip;

/**
 * These tests drive the background loop with fake timers, so the build runs
 * on this thread (the same loop the build process runs; bodyIndexChild.test.ts
 * covers the child process itself).
 */
function resetBodyIndexForTests(opts: Parameters<typeof resetForTests>[0] = {}) {
  return resetForTests({ runner: mainThreadRunner, ...opts });
}

/** A watcher the test drives by hand. */
function fakeWatch() {
  const state = {
    onEvent: null as null | ((t: string, f: string | null) => void),
    onError: null as null | ((e: unknown) => void),
    closed: false,
    dir: "",
  };
  const watch: WatchFn = (dir, onEvent, onError) => {
    state.dir = dir;
    state.onEvent = onEvent;
    state.onError = onError;
    return {
      close: () => {
        state.closed = true;
      },
    };
  };
  return { state, watch };
}

const saved = { ...process.env };
let root: string;
let v10: string;
let envIndex: string;
let indexFile: string;

function msg(id: number, mailbox = "INBOX"): FixtureMessage {
  return {
    id,
    account: "ACC",
    mailbox,
    subject: `m${id}`,
    address: "a@x.com",
    received: 1_700_000_000 + id,
  };
}

function setup(ids: number[] = [1]): void {
  root = mkdtempSync(join(tmpdir(), "bodyidx-sync-"));
  v10 = join(root, "V10");
  mkdirSync(join(v10, "MailData"), { recursive: true });
  envIndex = join(v10, "MailData", "Envelope Index");
  buildEnvelopeIndex(
    envIndex,
    [...ids, 2, 3, 4, 5, 6, 7, 8, 9].filter((v, i, a) => a.indexOf(v) === i).map((id) => msg(id))
  );
  writeEmlx(v10, "ACC", "INBOX", 1, plainMessage("a", "harbour cruise tickets"));
  indexFile = join(root, "support", "body.db");
  process.env.APPLE_MAIL_MCP_ENVELOPE_INDEX = "1";
  process.env.APPLE_MAIL_MCP_BODY_INDEX = "1";
  process.env.APPLE_MAIL_MCP_MAIL_DIR = root;
  process.env.APPLE_MAIL_MCP_BODY_INDEX_FILE = indexFile;
}

function teardown(): void {
  vi.useRealTimers();
  resetBodyIndexForTests();
  process.env = { ...saved };
  rmSync(root, { recursive: true, force: true });
}

/** Body search the way the manager runs it: prepare, then the Envelope Index query. */
function find(text: string): { ids: number[]; partial: boolean } | { reason: string } {
  const ready = prepareBodySearch();
  if (!ready.ok) return { reason: ready.reason };
  const r = searchEnvelopeIndex(
    { accountId: "ACC", limit: 50, mailbox: "INBOX", body: { text, indexFile: ready.file } },
    { indexPath: envIndex, sqlite }
  );
  if (!r.ok) return { reason: r.reason };
  const c = r.bodyCoverage!;
  return {
    ids: r.rows.map((m) => m.id),
    partial: c.notIndexedYet + c.partlyDownloaded + c.tooLarge > 0,
  };
}

/** Let the background loop run to idle (walk + index), with fake timers. */
function runToIdle(): void {
  for (let i = 0; i < 200; i++) vi.advanceTimersByTime(PAUSE_MS + 5);
}

describe("isBodyIndexEnabled", () => {
  it("needs both the body and the envelope switches", () => {
    expect(isBodyIndexEnabled({ APPLE_MAIL_MCP_BODY_INDEX: "1" })).toBe(false);
    expect(isBodyIndexEnabled({ APPLE_MAIL_MCP_ENVELOPE_INDEX: "1" })).toBe(false);
    expect(
      isBodyIndexEnabled({ APPLE_MAIL_MCP_BODY_INDEX: "1", APPLE_MAIL_MCP_ENVELOPE_INDEX: "yes" })
    ).toBe(true);
  });
});

describeIfSqlite("when off or unavailable, nothing is created", () => {
  beforeEach(() => setup());
  afterEach(teardown);

  it.each([
    ["the body flag", "APPLE_MAIL_MCP_BODY_INDEX"],
    ["the envelope flag", "APPLE_MAIL_MCP_ENVELOPE_INDEX"],
  ])("without %s: no file, no watcher, no timer", (_label, flag) => {
    delete process.env[flag];
    const fake = fakeWatch();
    resetBodyIndexForTests({ watch: fake.watch });
    vi.useFakeTimers();
    startBackgroundIndexing();
    expect(vi.getTimerCount()).toBe(0);
    expect(fake.state.dir).toBe("");
    expect(existsSync(join(root, "support"))).toBe(false);
    expect(prepareBodySearch()).toEqual({ ok: false, reason: "body index disabled" });
    expect(bodyIndexStatus()).toEqual({ enabled: false });
  });

  it("on a runtime without node:sqlite (Node < 22.5): turns itself off with a reason", () => {
    resetBodyIndexForTests({ sqlite: null });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    startBackgroundIndexing();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("requires Node >= 22.5"));
    err.mockRestore();
    expect(existsSync(join(root, "support"))).toBe(false);
    expect(bodyIndexUnavailable()).toMatch(/Node >= 22\.5/);
    expect(bodyIndexStatus()).toMatchObject({
      enabled: true,
      unavailable: expect.stringMatching(/22\.5/),
    });
  });

  it("without Full Disk Access: the same wording as the Envelope Index", () => {
    process.env.APPLE_MAIL_MCP_MAIL_DIR = join(root, "unreadable");
    expect(prepareBodySearch()).toEqual({ ok: false, reason: FULL_DISK_ACCESS_REASON });
    expect(existsSync(join(root, "support"))).toBe(false);
  });
});

describeIfSqlite("one writer per index file", () => {
  let other: InstanceType<NonNullable<typeof sqlite>["DatabaseSync"]> | null = null;

  /** Stand in for another server instance holding the writer role. */
  function holdLockAsOtherInstance(): void {
    mkdirSync(join(root, "support"), { recursive: true });
    other = new sqlite!.DatabaseSync(bodyIndexLockPath(indexFile));
    other.exec("PRAGMA journal_mode = MEMORY");
    other.exec("BEGIN EXCLUSIVE");
  }
  function otherInstanceExits(): void {
    other?.exec("ROLLBACK");
    other?.close();
    other = null;
  }

  beforeEach(() => setup());
  afterEach(() => {
    otherInstanceExits();
    teardown();
  });

  it("the first instance becomes the writer, watches the store, and locks privately", () => {
    const fake = fakeWatch();
    resetBodyIndexForTests({ watch: fake.watch });
    startBackgroundIndexing();
    expect(isBodyIndexWriter()).toBe(true);
    expect(isBodyIndexWatching()).toBe(true);
    expect(fake.state.dir).toBe(v10);
    const lock = bodyIndexLockPath(indexFile);
    expect(statSync(lock).mode & 0o777).toBe(0o600);
    expect(existsSync(`${lock}-journal`)).toBe(false);
  });

  it("a second instance reads only: no watcher, no writes, no file of its own", () => {
    holdLockAsOtherInstance();
    const fake = fakeWatch();
    resetBodyIndexForTests({ watch: fake.watch });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    startBackgroundIndexing();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("reader"));
    err.mockRestore();
    expect(isBodyIndexWriter()).toBe(false);
    expect(isBodyIndexWatching()).toBe(false);
    // The (stand-in) writer hasn't created the index yet: not searched, not empty.
    expect(find("harbour")).toEqual({ reason: "body index not created yet" });
    expect(existsSync(indexFile)).toBe(false);
  });

  it("a reader searches what the writer indexed", () => {
    expect(find("harbour")).toMatchObject({ ids: [] }); // writer: first search starts the walk
    vi.useFakeTimers();
    resetBodyIndexForTests();
    startBackgroundIndexing();
    runToIdle();
    expect(find("harbour")).toEqual({ ids: [1], partial: false });
    resetBodyIndexForTests();
    holdLockAsOtherInstance();
    expect(find("harbour")).toEqual({ ids: [1], partial: false });
    expect(isBodyIndexWriter()).toBe(false);
  });

  it("a reader never rebuilds: a writer mid-migration reads as unavailable", () => {
    vi.useFakeTimers();
    startBackgroundIndexing();
    runToIdle();
    resetBodyIndexForTests();
    const db = new sqlite!.DatabaseSync(indexFile);
    db.exec("PRAGMA user_version = 99");
    db.close();
    holdLockAsOtherInstance();
    expect(find("harbour")).toEqual({ reason: expect.stringContaining("being rebuilt") });
    expect(bodyIndexStatus()).toMatchObject({
      role: "reader",
      unavailable: expect.stringContaining("being rebuilt"),
    });
    const check = new sqlite!.DatabaseSync(indexFile, { readOnly: true });
    expect(Number(check.prepare("PRAGMA user_version").get()!.user_version)).toBe(99);
    check.close();
  });

  it("a reader takes over on its next search once the writer exits", () => {
    holdLockAsOtherInstance();
    const fake = fakeWatch();
    resetBodyIndexForTests({ watch: fake.watch });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    startBackgroundIndexing();
    otherInstanceExits();
    expect(find("harbour")).not.toHaveProperty("reason");
    expect(err).toHaveBeenCalledWith(expect.stringContaining("writer: this instance"));
    err.mockRestore();
    expect(isBodyIndexWriter()).toBe(true);
    expect(isBodyIndexWatching()).toBe(true);
  });

  it("a reader takes over in the background, without a search", () => {
    vi.useFakeTimers();
    holdLockAsOtherInstance();
    const fake = fakeWatch();
    resetBodyIndexForTests({ watch: fake.watch });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    startBackgroundIndexing();
    vi.advanceTimersByTime(1_000);
    expect(isBodyIndexWriter()).toBe(false);
    otherInstanceExits();
    vi.advanceTimersByTime(WRITER_RETRY_MS);
    err.mockRestore();
    expect(isBodyIndexWriter()).toBe(true);
    expect(isBodyIndexWatching()).toBe(true);
  });

  it("gives up the writer role on shutdown so another instance can take it", () => {
    startBackgroundIndexing();
    expect(isBodyIndexWriter()).toBe(true);
    stopBodyIndexing();
    expect(() => holdLockAsOtherInstance()).not.toThrow();
  });

  it("respects a writer in another process, and takes over when it is killed", async () => {
    mkdirSync(join(root, "support"), { recursive: true });
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
         const db = new DatabaseSync(process.argv[1]);
         db.exec("PRAGMA journal_mode = MEMORY");
         db.exec("BEGIN EXCLUSIVE");
         process.stdout.write("locked\\n");
         setInterval(() => {}, 1000);`,
        bodyIndexLockPath(indexFile),
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.on("data", (d) => String(d).includes("locked") && resolve());
        child.on("exit", (code) => reject(new Error(`lock holder exited early (${code})`)));
      });
      expect(find("harbour")).toEqual({ reason: "body index not created yet" });
      expect(isBodyIndexWriter()).toBe(false);
    } finally {
      child.kill("SIGKILL");
      await new Promise((r) => child.on("exit", r));
    }
    expect(find("harbour")).not.toHaveProperty("reason");
    expect(isBodyIndexWriter()).toBe(true);
  }, 15_000);
});

describeIfSqlite("keeping the index current", () => {
  beforeEach(() => setup());
  afterEach(teardown);

  function rel(path: string): string {
    return path.slice(v10.length + 1);
  }

  function started(): ReturnType<typeof fakeWatch> {
    vi.useFakeTimers();
    const fake = fakeWatch();
    resetBodyIndexForTests({ watch: fake.watch });
    startBackgroundIndexing();
    runToIdle();
    expect(find("harbour")).toEqual({ ids: [1], partial: false });
    return fake;
  }

  it("a search never builds the index: it answers partial while the build runs", () => {
    for (let id = 2; id <= 9; id++) {
      writeEmlx(v10, "ACC", "INBOX", id, plainMessage("x", `harbour note ${id}`));
    }
    // A clock that moves 10 ms per read: the catch-up can index ~SEARCH_CATCHUP_MS/10 files.
    let t = 0;
    const clock: Clock = { now: () => Date.now(), monotonic: () => (t += 10) };
    vi.useFakeTimers();
    resetBodyIndexForTests({ clock, watch: fakeWatch().watch });
    startBackgroundIndexing();
    // Run slices until the walk has finished; indexing has barely started.
    while (!bodyIndexStatus().meta?.lastFullWalk) vi.advanceTimersByTime(PAUSE_MS + 1);
    const r = find("harbour");
    expect("ids" in r && r.partial).toBe(true);
    expect("ids" in r && r.ids.length).toBeLessThan(9);
    // The search answered without finishing the build.
    expect(bodyIndexStatus().counts!.queued).toBeGreaterThan(0);
    expect(SEARCH_CATCHUP_MS).toBeLessThanOrEqual(50);
    expect(SLICE_MS).toBeLessThanOrEqual(50);
  });

  it("a search's catch-up leaves a big new file to the build, and says it isn't indexed yet", () => {
    const fake = started();
    const big = writeEmlx(
      v10,
      "ACC",
      "INBOX",
      2,
      plainMessage("b", `harbour ${"x".repeat(SEARCH_CATCHUP_MAX_BYTES)}`)
    );
    const small = writeEmlx(v10, "ACC", "INBOX", 3, plainMessage("c", "harbour small"));
    fake.state.onEvent!("rename", rel(big));
    fake.state.onEvent!("rename", rel(small));
    expect(find("harbour")).toEqual({ ids: [3, 1], partial: true });
    runToIdle();
    expect(find("harbour")).toEqual({ ids: [3, 2, 1], partial: false });
  });

  it("makes a new message searchable from its file event, on the next search", () => {
    const fake = started();
    const added = writeEmlx(v10, "ACC", "INBOX", 2, plainMessage("b", "dentist appointment"));
    fake.state.onEvent!("rename", rel(added));
    expect(find("dentist")).toEqual({ ids: [2], partial: false });
  });

  it("indexes a batch in the background after the quiet period, with no search", () => {
    const fake = started();
    const added = writeEmlx(v10, "ACC", "INBOX", 3, plainMessage("c", "boarding pass"));
    fake.state.onEvent!("rename", rel(added));
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS - 100);
    const status = () => bodyIndexStatus().counts!;
    expect(status().indexed).toBe(1); // still inside the quiet period
    vi.advanceTimersByTime(200 + PAUSE_MS * 3);
    expect(status().indexed).toBe(2);
  });

  it("drops a deleted message from its file event", () => {
    const fake = started();
    const path = join(v10, "ACC", "INBOX.mbox", "STORE-UUID", "Data", "Messages", "1.emlx");
    unlinkSync(path);
    fake.state.onEvent!("rename", rel(path));
    expect(find("harbour")).toEqual({ ids: [], partial: false });
  });

  it("walks everything when FSEvents can't name the file", () => {
    const fake = started();
    writeEmlx(v10, "ACC", "INBOX", 4, plainMessage("d", "coalesced event"));
    fake.state.onEvent!("rename", null);
    runToIdle();
    expect(find("coalesced")).toEqual({ ids: [4], partial: false });
  });

  it("walks everything when a mailbox directory is renamed", () => {
    const fake = started();
    writeEmlx(v10, "ACC", "INBOX", 5, plainMessage("e", "kickoff notes"));
    fake.state.onEvent!("rename", "ACC/Projects.mbox");
    runToIdle();
    expect(find("kickoff")).toEqual({ ids: [5], partial: false });
  });

  it("ignores events under MailData and for non-message files", () => {
    const fake = started();
    writeEmlx(v10, "ACC", "INBOX", 6, plainMessage("f", "not announced"));
    fake.state.onEvent!("change", "MailData/Envelope Index-wal");
    fake.state.onEvent!("change", "ACC/INBOX.mbox/Info.plist");
    fake.state.onEvent!("change", "MailData/9.emlx");
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS + PAUSE_MS * 3);
    expect(find("announced")).toEqual({ ids: [], partial: false });
  });

  it("walks at once when the watcher fails, then keeps to timed walks", () => {
    const fake = started();
    writeEmlx(v10, "ACC", "INBOX", 7, plainMessage("g", "missed while broken"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.state.onError!(new Error("stream lost"));
    err.mockRestore();
    expect(isBodyIndexWatching()).toBe(false);
    expect(fake.state.closed).toBe(true);
    runToIdle();
    expect(find("missed")).toEqual({ ids: [7], partial: false });
    expect(bodyIndexStatus()).toMatchObject({
      watching: false,
      lastError: expect.stringContaining("stream lost"),
    });
  });

  it("uses timed walks when the watcher can't start", () => {
    vi.useFakeTimers();
    resetBodyIndexForTests({
      watch: () => {
        throw new Error("EMFILE");
      },
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    startBackgroundIndexing();
    err.mockRestore();
    expect(isBodyIndexWatching()).toBe(false);
    runToIdle();
    expect(find("harbour")).toEqual({ ids: [1], partial: false });
  });

  it("goes idle when caught up, and its timers never keep the process alive", () => {
    started();
    // Idle: one timer left (the next safety walk), nothing spinning.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("closes the watcher and clears its timers on shutdown", () => {
    const fake = started();
    stopBodyIndexing();
    expect(fake.state.closed).toBe(true);
    expect(isBodyIndexWatching()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports its state for doctor", () => {
    started();
    const s = bodyIndexStatus();
    expect(s).toMatchObject({
      enabled: true,
      path: indexFile,
      role: "writer",
      watching: true,
      build: { runsOn: "main thread", running: false },
      counts: { indexed: 1, queued: 0, partial: 0, tooLarge: 0, unreadable: 0 },
      meta: { lastWalkFiles: 1, lastFullWalk: expect.any(String) },
    });
  });

  // Real FSEvents, not a fake: proves the default watcher sees Mail-style writes.
  const itOnMac = process.platform === "darwin" ? it : it.skip;
  itOnMac(
    "picks up a new .emlx through real FSEvents within seconds",
    async () => {
      resetBodyIndexForTests();
      startBackgroundIndexing();
      expect(isBodyIndexWatching()).toBe(true);
      await new Promise((r) => setTimeout(r, 1_000)); // first walk + index, FSEvents start
      writeEmlx(v10, "ACC", "INBOX", 9, plainMessage("g", "real filesystem event"));
      const t0 = Date.now();
      let r = find("filesystem event");
      while (!("ids" in r && r.ids.length) && Date.now() - t0 < 8_000) {
        await new Promise((res) => setTimeout(res, 100));
        r = find("filesystem event");
      }
      expect(r).toEqual({ ids: [9], partial: false });
    },
    15_000
  );
});

/**
 * A build runner the test drives by hand: it records each start and hand-off,
 * and the test plays the build's side through the recorded events.
 */
function manualRunner(onStart?: (init: BuilderInit, events: BuildEvents) => void) {
  const starts: {
    init: BuilderInit;
    events: BuildEvents;
    posts: BuilderWork[];
    stopped: boolean;
  }[] = [];
  const runner: BuildRunner = {
    runsOn: "child process",
    start(init, events) {
      onStart?.(init, events);
      const s = { init, events, posts: [] as BuilderWork[], stopped: false };
      starts.push(s);
      return {
        post: (w) => s.posts.push(w),
        stop: async () => {
          s.stopped = true;
        },
      };
    },
  };
  return { runner, starts, last: () => starts[starts.length - 1] };
}

describeIfSqlite("the build: started when there is work, stopped when there is none", () => {
  beforeEach(() => setup());
  afterEach(teardown);

  function rel(path: string): string {
    return path.slice(v10.length + 1);
  }

  /** Start with a hand-driven runner; returns it after the first tick handed it a walk. */
  function startedManual(onStart?: Parameters<typeof manualRunner>[0], clock?: Clock) {
    vi.useFakeTimers();
    const m = manualRunner(onStart);
    const fake = fakeWatch();
    resetBodyIndexForTests({ watch: fake.watch, runner: m.runner, ...(clock ? { clock } : {}) });
    startBackgroundIndexing();
    expect(isBodyIndexBuilding()).toBe(false);
    vi.advanceTimersByTime(PAUSE_MS);
    expect(m.starts).toHaveLength(1);
    expect(m.last().posts).toEqual([{ type: "work", seq: 1, walk: true, paths: [] }]);
    expect(m.last().init).toEqual({
      versionDir: v10,
      indexPath: indexFile,
      sliceMs: SLICE_MS,
      pauseMs: PAUSE_MS,
      protocol: BUILDER_PROTOCOL,
      schemaVersion: BODY_INDEX_SCHEMA_VERSION,
    });
    return { ...m, fake };
  }

  it("starts one for the first walk and stops it once it reports idle", () => {
    vi.useFakeTimers();
    resetBodyIndexForTests({ watch: fakeWatch().watch });
    startBackgroundIndexing();
    vi.advanceTimersByTime(PAUSE_MS);
    expect(isBodyIndexBuilding()).toBe(true);
    expect(bodyIndexStatus().build).toEqual({ runsOn: "main thread", running: true });
    runToIdle();
    expect(isBodyIndexBuilding()).toBe(false);
    expect(bodyIndexStatus().counts!.indexed).toBe(1);
    expect(vi.getTimerCount()).toBe(1); // only the next timed walk
  });

  it("walks again after a build stops before it reported the file events it was handed", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const m = startedManual();
    m.last().events.report({ type: "ready", pid: 7 });
    m.last().events.report({ type: "walked" }); // walked; still indexing
    const added = writeEmlx(v10, "ACC", "INBOX", 2, plainMessage("b", "dentist"));
    m.fake.state.onEvent!("rename", rel(added));
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS + 1);
    expect(m.last().posts[1]).toEqual({ type: "work", seq: 2, walk: false, paths: [added] });
    m.last().events.exit("exit code 1"); // crashed before applying them
    vi.advanceTimersByTime(BUILD_RESTART_MS + 1);
    err.mockRestore();
    // The events are gone with it; a walk finds the file instead.
    expect(m.starts).toHaveLength(2);
    expect(m.last().posts).toEqual([{ type: "work", seq: 3, walk: true, paths: [] }]);
  });

  it("does not walk again after a build that reported everything done", () => {
    const m = startedManual();
    m.last().events.report({ type: "ready", pid: 7 });
    m.last().events.report({ type: "walked" });
    m.last().events.report({ type: "idle", seq: 1 });
    vi.advanceTimersByTime(BUILD_RESTART_MS * 4);
    expect(m.starts).toHaveLength(1);
  });

  it("under Electron's Node, builds on the main thread: a fork would start the app", () => {
    Object.defineProperty(process.versions, "electron", { value: "30.0.0", configurable: true });
    try {
      vi.useFakeTimers();
      const m = manualRunner();
      resetBodyIndexForTests({ watch: fakeWatch().watch, runner: m.runner });
      startBackgroundIndexing();
      expect(bodyIndexStatus().build).toEqual({
        runsOn: "main thread",
        running: false,
        fallback: expect.stringContaining("Electron"),
      });
      runToIdle();
      expect(m.starts).toHaveLength(0);
      expect(find("harbour")).toEqual({ ids: [1], partial: false });
    } finally {
      delete (process.versions as Record<string, string | undefined>).electron;
    }
  });

  it("hands file events to a running build instead of writing them on the main thread", () => {
    const m = startedManual();
    const added = writeEmlx(v10, "ACC", "INBOX", 2, plainMessage("b", "dentist"));
    m.fake.state.onEvent!("rename", rel(added));
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS + 1);
    // Handed over, not applied here: the main thread wrote no row for it.
    expect(m.last().posts[1]).toEqual({ type: "work", seq: 2, walk: false, paths: [added] });
    expect(bodyIndexStatus().counts).toEqual({
      indexed: 0,
      queued: 0,
      partial: 0,
      tooLarge: 0,
      unreadable: 0,
    });
    // A search during the build hands its events over too, and indexes nothing here.
    const again = writeEmlx(v10, "ACC", "INBOX", 3, plainMessage("c", "boarding"));
    m.fake.state.onEvent!("rename", rel(again));
    expect(find("boarding")).toMatchObject({ ids: [] });
    expect(m.last().posts[2]).toEqual({ type: "work", seq: 3, walk: false, paths: [again] });
    expect(bodyIndexStatus().counts!.queued).toBe(0);
  });

  it("keeps a build that reports idle for an older hand-off; stops it on the latest", () => {
    const m = startedManual();
    const added = writeEmlx(v10, "ACC", "INBOX", 2, plainMessage("b", "dentist"));
    m.fake.state.onEvent!("rename", rel(added));
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS + 1);
    m.last().events.report({ type: "idle", seq: 1 });
    expect(isBodyIndexBuilding()).toBe(true);
    expect(m.last().stopped).toBe(false);
    m.last().events.report({ type: "idle", seq: 2 });
    expect(isBodyIndexBuilding()).toBe(false);
    expect(m.last().stopped).toBe(true);
  });

  it("doesn't hand over a second walk while one is in flight", () => {
    const m = startedManual();
    m.fake.state.onEvent!("rename", rel(join(v10, "ACC", "INBOX.mbox", "x", "1.emlx")));
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS + 1);
    expect(m.last().posts[1]).toMatchObject({ seq: 2, walk: false });
    m.last().events.report({ type: "walked" });
    m.last().events.report({ type: "idle", seq: 2 });
    expect(isBodyIndexBuilding()).toBe(false);
    // Caught up and walked: nothing to start until the next timed walk.
    vi.advanceTimersByTime(RESCAN_WATCHED_MS - 1_000);
    expect(m.starts).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(m.starts).toHaveLength(2);
    expect(m.last().posts).toEqual([{ type: "work", seq: 3, walk: true, paths: [] }]);
  });

  it("a search with a walk pending leaves the walk to a build, and starts one", () => {
    const m = startedManual();
    m.last().events.report({ type: "walked" });
    m.last().events.report({ type: "idle", seq: 1 });
    m.fake.state.onEvent!("rename", null);
    expect(find("harbour")).not.toHaveProperty("reason");
    expect(m.starts).toHaveLength(1);
    vi.advanceTimersByTime(0);
    expect(m.starts).toHaveLength(2);
    expect(m.last().posts).toEqual([{ type: "work", seq: 2, walk: true, paths: [] }]);
  });

  it("a build process that can't start is noted once, and the build moves to the main thread", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const m = startedManual();
    m.last().events.exit("Cannot find module '/x/build/index.js'");
    expect(isBodyIndexBuilding()).toBe(false);
    expect(bodyIndexStatus()).toMatchObject({
      build: {
        runsOn: "main thread",
        fallback: expect.stringContaining("build process could not start (Cannot find module"),
      },
      lastError: expect.stringContaining("could not start"),
    });
    runToIdle();
    err.mockRestore();
    expect(m.starts).toHaveLength(1); // never asked again
    expect(find("harbour")).toEqual({ ids: [1], partial: false });
  });

  it("a runner that throws on start falls back the same way", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    resetBodyIndexForTests({
      watch: fakeWatch().watch,
      runner: {
        runsOn: "child process",
        start: () => {
          throw new Error("ERR_WORKER_INIT_FAILED");
        },
      },
    });
    startBackgroundIndexing();
    runToIdle();
    err.mockRestore();
    expect(bodyIndexStatus().build).toMatchObject({
      runsOn: "main thread",
      fallback: expect.stringContaining("ERR_WORKER_INIT_FAILED"),
    });
    expect(find("harbour")).toEqual({ ids: [1], partial: false });
  });

  it("a crashed build process is noted and restarted: soon, then at the walk interval while it keeps crashing", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const m = startedManual();
    m.last().events.report({ type: "ready", pid: 7 });
    m.last().events.exit("exit code 1");
    expect(isBodyIndexBuilding()).toBe(false);
    expect(bodyIndexStatus().lastError).toMatch(
      /build process stopped unexpectedly \(exit code 1\)/
    );
    // The main thread didn't wait on it, and doesn't fall back for a crash.
    expect(bodyIndexStatus().build).toEqual({ runsOn: "child process", running: false });
    vi.advanceTimersByTime(BUILD_RESTART_MS - 1);
    expect(m.starts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(m.starts).toHaveLength(2);
    // Its walk never finished, so the new one walks again.
    expect(m.last().posts).toEqual([{ type: "work", seq: 2, walk: true, paths: [] }]);
    // A crash reported by a build that was already replaced changes nothing.
    m.starts[0].events.exit("late");
    expect(isBodyIndexBuilding()).toBe(true);
    m.last().events.report({ type: "ready", pid: 8 });
    m.last().events.exit("exit code 1");
    vi.advanceTimersByTime(BUILD_RESTART_MS);
    expect(m.starts).toHaveLength(2);
    vi.advanceTimersByTime(RESCAN_WATCHED_MS);
    expect(m.starts).toHaveLength(3);
    // Once one gets through, the next crash is restarted soon again.
    m.last().events.report({ type: "ready", pid: 9 });
    m.last().events.report({ type: "walked" });
    m.last().events.report({ type: "idle", seq: 3 });
    m.fake.state.onEvent!("rename", null);
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS + 1);
    expect(m.starts).toHaveLength(4);
    m.last().events.report({ type: "ready", pid: 10 });
    m.last().events.exit("exit code 1");
    vi.advanceTimersByTime(BUILD_RESTART_MS + 1);
    err.mockRestore();
    expect(m.starts).toHaveLength(5);
  });

  it("a failed step or open is noted and retried later; nothing waits on it", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const m = startedManual();
    m.last().events.report({ type: "ready", pid: 7 });
    m.last().events.report({ type: "failed", where: "step", message: "disk I/O error" });
    expect(m.last().stopped).toBe(true);
    expect(isBodyIndexBuilding()).toBe(false);
    expect(bodyIndexStatus().lastError).toMatch(/index build failed: disk I\/O error/);
    vi.advanceTimersByTime(BUILD_RESTART_MS);
    expect(m.starts).toHaveLength(2);
    m.last().events.report({ type: "failed", where: "open", message: "database is locked" });
    err.mockRestore();
    expect(bodyIndexStatus().lastError).toMatch(/index build could not start: database is locked/);
  });

  it("a build process that can't read the Mail store hands the build to the main thread", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const m = startedManual();
    m.last().events.report({
      type: "failed",
      where: "store",
      message: "can't read the Mail store (EPERM)",
    });
    expect(m.last().stopped).toBe(true);
    expect(bodyIndexStatus().build).toMatchObject({
      runsOn: "main thread",
      fallback: "the build process can't read the Mail store (EPERM); building on the main thread",
    });
    runToIdle();
    err.mockRestore();
    expect(m.starts).toHaveLength(1);
    expect(find("harbour")).toEqual({ ids: [1], partial: false });
  });

  /** Fake timers move Date but not performance.now(); the watchdog reads the monotonic clock. */
  const fakeClock: Clock = { now: () => Date.now(), monotonic: () => Date.now() };

  it("a build process that stops responding is stopped and restarted; heartbeats keep a busy one alive", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const m = startedManual(undefined, fakeClock);
    m.last().events.report({ type: "ready", pid: 7 });
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(HEARTBEAT_MS);
      m.last().events.report({ type: "alive" });
    }
    expect(m.last().stopped).toBe(false); // 200 s of work, and alive throughout
    vi.advanceTimersByTime(BUILD_STALL_MS + BUILD_STALL_MS / 4);
    expect(m.starts[0].stopped).toBe(true);
    expect(bodyIndexStatus().lastError).toMatch(/stopped responding \(nothing for 60 s\)/);
    // Restarted like a crash, walk and all; still in a build process.
    expect(m.starts).toHaveLength(2);
    expect(m.last().posts).toEqual([{ type: "work", seq: 2, walk: true, paths: [] }]);
    expect(bodyIndexStatus().build).toEqual({ runsOn: "child process", running: true });
    stopBodyIndexing();
    err.mockRestore();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("one that never says it is ready moves the build to the main thread", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const m = startedManual(undefined, fakeClock);
    vi.advanceTimersByTime(BUILD_STALL_MS + BUILD_STALL_MS / 4);
    expect(m.starts[0].stopped).toBe(true);
    expect(bodyIndexStatus().build).toMatchObject({
      runsOn: "main thread",
      fallback: expect.stringContaining("stopped responding"),
    });
    runToIdle();
    err.mockRestore();
    expect(find("harbour")).toEqual({ ids: [1], partial: false });
  });

  it("a build process started from other files on disk moves the build to the main thread", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const m = startedManual();
    m.last().events.report({
      type: "failed",
      where: "version",
      message: "the build process runs other code than the server (…)",
    });
    expect(m.last().stopped).toBe(true);
    expect(bodyIndexStatus().build).toMatchObject({
      runsOn: "main thread",
      fallback:
        "the build process runs other code than the server (…); building on the main thread",
    });
    runToIdle();
    err.mockRestore();
    expect(find("harbour")).toEqual({ ids: [1], partial: false });
  });

  // Root lists any directory whatever its mode.
  it.skipIf(process.getuid?.() === 0)(
    "doesn't blame the build process for a store the server can't read either: noted and retried, no fallback",
    () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const m = startedManual();
      chmodSync(v10, 0o000);
      try {
        m.last().events.report({
          type: "failed",
          where: "store",
          message: "can't read the Mail store (EPERM)",
        });
      } finally {
        chmodSync(v10, 0o755);
      }
      expect(m.last().stopped).toBe(true);
      expect(bodyIndexStatus().build).toEqual({ runsOn: "child process", running: false });
      expect(bodyIndexStatus().lastError).toMatch(
        /index build could not start: can't read the Mail store \(EPERM\)/
      );
      vi.advanceTimersByTime(BUILD_RESTART_MS);
      err.mockRestore();
      expect(m.starts).toHaveLength(2);
    }
  );

  it("tries a build process again an hour after falling back to the main thread", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const m = startedManual();
    m.last().events.exit("exit code 1"); // before ready: couldn't start
    runToIdle();
    expect(m.starts).toHaveLength(1);
    expect(bodyIndexStatus().build!.runsOn).toBe("main thread");
    vi.advanceTimersByTime(FALLBACK_RETRY_MS); // timed walks run on the main thread meanwhile
    err.mockRestore();
    expect(m.starts).toHaveLength(2);
    expect(bodyIndexStatus().build).toEqual({ runsOn: "child process", running: true });
  });

  it("shutdown stops a running build", () => {
    const m = startedManual();
    expect(bodyIndexStatus().build).toEqual({ runsOn: "child process", running: true });
    stopBodyIndexing();
    expect(m.last().stopped).toBe(true);
    expect(isBodyIndexBuilding()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a reader starts no build", () => {
    mkdirSync(join(root, "support"), { recursive: true });
    const other = new sqlite!.DatabaseSync(bodyIndexLockPath(indexFile));
    other.exec("PRAGMA journal_mode = MEMORY");
    other.exec("BEGIN EXCLUSIVE");
    try {
      vi.useFakeTimers();
      const m = manualRunner();
      resetBodyIndexForTests({ watch: fakeWatch().watch, runner: m.runner });
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      startBackgroundIndexing();
      vi.advanceTimersByTime(WRITER_RETRY_MS * 2);
      err.mockRestore();
      expect(m.starts).toHaveLength(0);
      expect(bodyIndexStatus()).not.toHaveProperty("build");
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
  });
});

describe("nextTickDelay", () => {
  it("waits for the next timed walk, never less than a pause, and after a failure never less than a restart", () => {
    expect(nextTickDelay(RESCAN_WATCHED_MS, false)).toBe(RESCAN_WATCHED_MS);
    expect(nextTickDelay(RESCAN_WATCHED_MS, true)).toBe(RESCAN_WATCHED_MS);
    // A walk that is already due, but whose step keeps failing, mustn't spin.
    expect(nextTickDelay(-3, false)).toBe(PAUSE_MS);
    expect(nextTickDelay(0, true)).toBe(BUILD_RESTART_MS);
  });
});
