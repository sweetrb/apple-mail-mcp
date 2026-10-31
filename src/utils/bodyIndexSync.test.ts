/**
 * Body index sync: the writer role, the watcher and the background loop, all on
 * a synthetic mail store with an injected watcher and clock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
  watch as fsWatch,
} from "fs";
import { EventEmitter } from "events";
import { tmpdir } from "os";
import { spawn } from "child_process";
import { join } from "path";
import {
  PAUSE_MS,
  SEARCH_CATCHUP_MS,
  SLICE_MS,
  WATCH_DEBOUNCE_MS,
  WRITER_RETRY_MS,
  bodyIndexStatus,
  bodyIndexUnavailable,
  isBodyIndexEnabled,
  isBodyIndexWatching,
  isBodyIndexWriter,
  prepareBodySearch,
  resetBodyIndexForTests,
  startBackgroundIndexing,
  stopBodyIndexing,
  type WatchFn,
} from "@/utils/bodyIndexSync.js";
import { bodyIndexLockPath, type Clock } from "@/utils/bodyIndex.js";
import { FULL_DISK_ACCESS_REASON, searchEnvelopeIndex } from "@/utils/envelopeIndex.js";
import {
  buildEnvelopeIndex,
  plainMessage,
  sqlite,
  writeEmlx,
  type FixtureMessage,
} from "@/utils/envelopeIndex.testFixture.js";

// Keep the real filesystem behavior by default, including the macOS FSEvents
// integration below. One boundary test supplies the native callback explicitly.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

const describeIfSqlite = sqlite ? describe : describe.skip;

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
      counts: { indexed: 1, queued: 0, partial: 0, tooLarge: 0 },
      meta: { lastWalkFiles: 1, lastFullWalk: expect.any(String) },
    });
  });

  it("adapts native filename events and watcher errors into real index updates", () => {
    class ControlledWatcher extends EventEmitter {
      close = vi.fn();
      ref(): this {
        return this;
      }
      unref(): this {
        return this;
      }
    }
    const native = new ControlledWatcher();
    vi.mocked(fsWatch).mockClear();
    vi.mocked(fsWatch).mockImplementationOnce((...args) => {
      const listener = args.at(-1);
      if (typeof listener !== "function") throw new Error("Missing native watch callback");
      native.on("change", listener);
      return native;
    });
    vi.useFakeTimers();
    // Exercise fsEventsWatch itself, not the higher-level injected WatchFn.
    resetBodyIndexForTests();
    startBackgroundIndexing();
    runToIdle();
    expect(fsWatch).toHaveBeenCalledExactlyOnceWith(
      v10,
      { recursive: true, persistent: false },
      expect.any(Function)
    );
    expect(find("harbour")).toEqual({ ids: [1], partial: false });

    const added = writeEmlx(v10, "ACC", "INBOX", 2, plainMessage("b", "buffer filename"));
    native.emit("change", "rename", Buffer.from(rel(added)));
    expect(find("buffer filename")).toEqual({ ids: [2], partial: false });

    const changed = writeEmlx(v10, "ACC", "INBOX", 2, plainMessage("b", "string filename changed"));
    native.emit("change", "change", rel(changed));
    expect(find("string filename changed")).toEqual({ ids: [2], partial: false });
    expect(find("buffer filename")).toEqual({ ids: [], partial: false });

    writeEmlx(v10, "ACC", "INBOX", 3, plainMessage("c", "unnamed event recovery"));
    native.emit("change", "rename", null);
    runToIdle();
    expect(find("unnamed event recovery")).toEqual({ ids: [3], partial: false });

    writeEmlx(v10, "ACC", "INBOX", 4, plainMessage("d", "watcher failure recovery"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      native.emit("error", new Error("synthetic native watcher failure"));
    } finally {
      errorLog.mockRestore();
    }
    expect(native.close).toHaveBeenCalledOnce();
    expect(isBodyIndexWatching()).toBe(false);
    runToIdle();
    expect(find("watcher failure recovery")).toEqual({ ids: [4], partial: false });
    expect(bodyIndexStatus().lastError).toContain("synthetic native watcher failure");
    stopBodyIndexing();
    expect(vi.getTimerCount()).toBe(0);
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
