/**
 * Body index: who keeps it current. The writer lock, the FSEvents watcher, the
 * background loop and the supervision of the build process live here; the
 * schema, queries and indexing steps are in bodyIndex.ts, the build loop
 * itself in bodyIndexBuild.ts.
 *
 *  - **Opt-in, and inert when off.** Needs `APPLE_MAIL_MCP_BODY_INDEX` *and*
 *    `APPLE_MAIL_MCP_ENVELOPE_INDEX`. With either off, nothing here creates a
 *    file, a watcher, a timer or a process. On a runtime without `node:sqlite`
 *    (Node < 22.5) or without FTS5 `contentless_delete`, it reports why and
 *    stays off.
 *  - **One writer per index file.** Hosts like the Claude desktop app run one
 *    server instance per conversation, all sharing the file. The first to take
 *    the lock is the writer — the only one that walks, watches, parses and
 *    writes; the rest attach the index read-only when they search. The lock is
 *    an exclusive SQLite transaction on a small sidecar file, held by the
 *    server itself, never by its build process; the OS drops it when the
 *    server exits or crashes, and a reader takes over on its next search or
 *    within {@link WRITER_RETRY_MS}.
 *  - **The heavy part runs in a child process.** Full walks and parsing the
 *    queued `.emlx` files run in a build process: the server's own bundle,
 *    forked with `--body-index-builder`, an empty environment and the index
 *    path and store directory sent over IPC. It is started when there is such
 *    work and stopped as soon as it reports that nothing is left, so the
 *    memory parsing takes goes back to the OS with the process. (A
 *    `worker_thread` doesn't return it: V8 keeps a terminated worker's heap
 *    pages in the process.) The server keeps the lock, the watcher and the
 *    cheap work: applying file events (a few rows) and a search's catch-up.
 *  - **One connection writes at a time.** While the build runs, it owns the
 *    writes: file events and walk requests are handed to it, and a search
 *    doesn't index. Only while none runs does the server write. Both take the
 *    write lock up front (`BEGIN IMMEDIATE`) under `busy_timeout`, so the rare
 *    overlap — an error note, a build process still exiting — waits instead
 *    of failing.
 *  - **A build that can't run doesn't stop the index.** One that fails a step,
 *    crashes or stops responding (no report for {@link BUILD_STALL_MS}) is
 *    noted, stopped and started again after {@link BUILD_RESTART_MS}, then at
 *    the walk interval while it keeps failing; nothing waits on it, a search
 *    least of all. A build that stops before it reported its work done loses
 *    the file events it was handed, so a walk is asked for; nothing is lost.
 *    One that can't start at all (fork failed, or it exited before it was
 *    ready), can't read a Mail store the server can read (no Full Disk Access
 *    in a separate process), or runs other code than the server (its bundle
 *    was replaced on disk after the server loaded it) is noted, and the same
 *    loop runs on the main thread, as before this split — for
 *    {@link FALLBACK_RETRY_MS}, then a build process is tried again. Under
 *    Electron's Node, where a fork would start the app, it always runs there.
 *    `doctor` says which.
 *  - **Watcher plus walk.** A recursive `fs.watch` (one FSEvents stream on
 *    macOS) reports new, changed, moved and deleted `.emlx` files, applied in a
 *    batch after a short quiet period. FSEvents can coalesce or drop events and
 *    Node doesn't surface those flags, so a periodic full walk is the
 *    guarantee: every {@link RESCAN_WATCHED_MS}, or {@link RESCAN_UNWATCHED_MS}
 *    without a watcher. An event without a file name, a renamed `.mbox` or a
 *    watcher error starts a walk at once.
 *  - **Small slices.** Walking and indexing run in {@link SLICE_MS} slices with
 *    {@link PAUSE_MS} between them, on timers that are `unref()`'d; the build
 *    process and its channel are `unref()`'d and the watcher is
 *    non-persistent. None of them keeps the
 *    process alive, and all stop on shutdown. A search never waits for
 *    indexing: with no build running it applies queued file events and
 *    indexes for at most {@link SEARCH_CATCHUP_MS}, then answers with whatever
 *    coverage the index has.
 *
 * @module utils/bodyIndexSync
 */

import { readdirSync, watch as fsWatch } from "fs";
import { dirname, join } from "path";
import { fork } from "child_process";
import { fileURLToPath } from "url";
import {
  BODY_INDEX_SCHEMA_VERSION,
  BodyIndexWriter,
  bodyIndexLockPath,
  bodyIndexPath,
  ensurePrivateDir,
  ensurePrivateFile,
  fts5Unsupported,
  inspectIndexFile,
  readIndexState,
  realClock,
  stampMismatch,
  type Clock,
  type IndexCounts,
  type IndexMeta,
} from "@/utils/bodyIndex.js";
import {
  BODY_INDEX_BUILDER_ARG,
  BUILDER_PROTOCOL,
  fileIdentity,
  runBuilder,
  type BuilderInit,
  type BuilderReport,
  type BuilderWork,
} from "@/utils/bodyIndexBuild.js";
import {
  FULL_DISK_ACCESS_REASON,
  isEnvelopeIndexEnabled,
  isTruthyFlag,
  loadSqlite,
  resolveMailStore,
  type SqliteDatabase,
  type SqliteModule,
} from "@/utils/envelopeIndex.js";

/** Env switch for the body index. */
export const BODY_INDEX_ENV = "APPLE_MAIL_MCP_BODY_INDEX";

/** Full walk interval while the watcher runs (a safety net) and without it (the update path). */
export const RESCAN_WATCHED_MS = 10 * 60_000;
export const RESCAN_UNWATCHED_MS = 5 * 60_000;
/** Collect file events this long before applying them, so a sync burst is one batch. */
export const WATCH_DEBOUNCE_MS = 1_500;
/** How often a reader checks whether the writer has gone. */
export const WRITER_RETRY_MS = 30_000;
/** One slice of walking or indexing, then a pause. ~33% of a core while there is work. */
export const SLICE_MS = 50;
export const PAUSE_MS = 100;
/** Most indexing a search does before answering (queued file events only, in practice). */
export const SEARCH_CATCHUP_MS = 50;
/** A search's catch-up leaves files larger than this to the build, so it never waits on a big parse. */
export const SEARCH_CATCHUP_MAX_BYTES = 1024 * 1024;
/** After a failed or crashed build, start it again this soon; after another failure in a row, at the walk interval. */
export const BUILD_RESTART_MS = 5_000;
/** A running build that has reported nothing for this long is stuck, and is stopped. */
export const BUILD_STALL_MS = 60_000;
/** How long the build stays on the main thread after a build process couldn't run, before one is tried again. */
export const FALLBACK_RETRY_MS = 60 * 60_000;

/** Whether body search via the local index is switched on. */
export function isBodyIndexEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyFlag(env[BODY_INDEX_ENV]) && isEnvelopeIndexEnabled(env);
}

/** What feeds file changes in; swappable in tests. */
export type WatchFn = (
  dir: string,
  onEvent: (eventType: string, filename: string | null) => void,
  onError: (err: unknown) => void
) => { close(): void };

/** Node's recursive `fs.watch`: on macOS, one FSEvents stream for the whole tree. */
const fsEventsWatch: WatchFn = (dir, onEvent, onError) => {
  const w = fsWatch(dir, { recursive: true, persistent: false }, (eventType, filename) =>
    onEvent(eventType, filename === null ? null : String(filename))
  );
  w.on("error", onError);
  return w;
};

// --- where the build runs -----------------------------------------------------

/** What a running build tells the main thread. */
export interface BuildEvents {
  report(msg: BuilderReport): void;
  /** It stopped by itself: the build process exited or crashed (`why` says how). */
  exit(why: string): void;
}

/** A running build, seen from the main thread. */
export interface BuildHandle {
  post(work: BuilderWork): void;
  /** Stop it now. It delivers no events afterwards; resolves once it is gone. */
  stop(): Promise<void>;
}

/** Starts the build somewhere; swappable in tests. */
export interface BuildRunner {
  readonly runsOn: "child process" | "main thread";
  start(init: BuilderInit, events: BuildEvents): BuildHandle;
}

/** After asking a build process to exit, kill it if it hasn't within this long. */
export const STOP_GRACE_MS = 2_000;

/**
 * Node flags the build process needs from the server's: only
 * `--experimental-sqlite` (Node 22.5–22.12 keep `node:sqlite` behind it).
 * Nothing else carries over — no `NODE_OPTIONS`, no inspector.
 */
export function builderExecArgv(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string | undefined = process.env.NODE_OPTIONS
): string[] {
  const flag = "--experimental-sqlite";
  const sqlite =
    execArgv.includes(flag) || (nodeOptions ?? "").split(/\s+/).includes(flag) ? [flag] : [];
  // Node 22–24 print an ExperimentalWarning for node:sqlite into the server's
  // stderr, once per fork; nothing else in the build process is experimental.
  return [...sqlite, "--disable-warning=ExperimentalWarning"];
}

/**
 * The build in a child process: `entry` (the server's bundle,
 * build/index.js) forked with {@link BODY_INDEX_BUILDER_ARG}. Its environment
 * is empty — it reads no config and needs none; the index path and the store
 * directory come in its `start` message. Its stdout is discarded, so nothing
 * it prints can reach the MCP stream; stderr goes to the server's log. It and
 * its channel are `unref()`'d, so they never keep the server alive.
 * `execPath` (tests only) replaces the Node binary.
 */
export function childProcessRunner(entry: string, opts: { execPath?: string } = {}): BuildRunner {
  // The bundle as this server loaded it (the default runner is made at startup).
  const loaded = fileIdentity(entry);
  return {
    runsOn: "child process",
    start(init, events) {
      const child = fork(entry, [BODY_INDEX_BUILDER_ARG], {
        execPath: opts.execPath ?? process.execPath,
        execArgv: builderExecArgv(),
        env: {},
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      child.unref();
      child.channel?.unref();
      let stopped = false;
      let error: unknown = null;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.on("message", (msg: BuilderReport) => {
        if (!stopped) events.report(msg);
      });
      child.on("error", (err) => {
        error = err;
        // A process that never started emits no "exit".
        if (child.pid === undefined && !stopped) {
          stopped = true;
          events.exit(errText(err));
        }
      });
      child.on("exit", (code, signal) => {
        if (stopped) return;
        stopped = true;
        events.exit(
          error !== null ? errText(error) : signal ? `killed by ${signal}` : `exit code ${code}`
        );
      });
      const send = (msg: unknown) => {
        if (child.connected) child.send(msg as BuilderWork, () => {}); // a closed channel shows as "exit"
      };
      send({ type: "start", init, entry: loaded });
      return {
        post: (work) => send(work),
        stop: async () => {
          if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
            stopped = true;
            return;
          }
          stopped = true;
          // It exits by itself when its channel closes; kill it if it doesn't.
          if (child.connected) child.disconnect();
          const kill = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
          kill.unref?.();
          await exited;
          clearTimeout(kill);
        },
      };
    },
  };
}

/**
 * The same build loop on the main thread, with its own connection: the
 * fallback when no build process can run. Messages are delivered on a later
 * turn of the event loop, as a child's are.
 */
export const mainThreadRunner: BuildRunner = {
  runsOn: "main thread",
  start(init, events) {
    let stopped = false;
    let listener: ((work: BuilderWork) => void) | null = null;
    const later = (fn: () => void) => {
      const t = setTimeout(() => {
        if (!stopped) fn();
      }, 0);
      t.unref?.();
    };
    const loop = runBuilder(
      {
        postMessage: (msg) => later(() => events.report(msg)),
        on: (_event, fn) => {
          listener = fn;
        },
      },
      init,
      { sqlite: sqliteModule(), clock }
    );
    return {
      post: (work) => later(() => listener?.(work)),
      stop: async () => {
        stopped = true;
        loop.stop();
      },
    };
  },
};

// --- module state (one per process) ---------------------------------------

let watchImpl: WatchFn = fsEventsWatch;
let clock: Clock = realClock;
let sqliteOverride: SqliteModule | null | undefined;
// The server's own bundle: bodyIndexSync.ts is bundled into build/index.js.
const childRunner = childProcessRunner(fileURLToPath(import.meta.url));
let runner: BuildRunner = childRunner;

let writer: BodyIndexWriter | null = null;
let writerLock: SqliteDatabase | null = null;
let watcher: { close(): void } | null = null;
let backgroundTimer: ReturnType<typeof setTimeout> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
const changedPaths = new Set<string>();
let walkRequested = false;
let lastError: string | null = null;

/** The running build, if any; it owns the index's writes while it runs. */
let build: BuildHandle | null = null;
/** Whether it said it opened the index (an exit before that means it couldn't start). */
let buildReady = false;
/** Number of the last hand-off, to match the build's `idle` report. */
let buildSeq = 0;
/** Number of the last hand-off the build reported done (`idle`). */
let buildDoneSeq = 0;
/** Failed or crashed builds in a row, for the restart delay. */
let buildFailures = 0;
/** Why, and since when, the build runs on the main thread, once a build process couldn't run. */
let buildFallback: { why: string; since: number } | null = null;
/** Monotonic time of the running build's last report (or of its start). */
let lastBuildReport = 0;
/** Checks the running build for {@link BUILD_STALL_MS} of silence. */
let watchdog: ReturnType<typeof setInterval> | null = null;
/** Resolves when the last stopped build is gone. */
let buildStopped: Promise<void> = Promise.resolve();
/** Wall time the last full walk finished (0: none yet in this process). */
let lastWalkDone = 0;
/** A walk was handed to the build and hasn't reported finishing. */
let walkInFlight = false;

function sqliteModule(): SqliteModule | null {
  return sqliteOverride === undefined ? loadSqlite() : sqliteOverride;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function noteError(where: string, err: unknown): void {
  lastError = `${new Date(clock.now()).toISOString()} ${where}: ${errText(err)}`;
  console.error(`[bodyIndex] ${where}: ${errText(err)}`);
  try {
    writer?.setMeta("lastError", lastError);
  } catch {
    /* the index itself may be the problem */
  }
}

/**
 * Why the body index can't run on this server, or null when it can. Checked in
 * an order that touches nothing: the flags, the runtime, SQLite's FTS5, then
 * whether the Mail store is readable.
 */
export function bodyIndexUnavailable(): string | null {
  if (!isBodyIndexEnabled()) return "body index disabled";
  const sqlite = sqliteModule();
  if (!sqlite) return "node:sqlite unavailable (requires Node >= 22.5)";
  const fts = fts5Unsupported(sqlite);
  if (fts) return fts;
  if (!resolveMailStore()) return FULL_DISK_ACCESS_REASON;
  return null;
}

// --- writer role --------------------------------------------------------------

function tryAcquireWriterLock(sqlite: SqliteModule, indexPath: string): boolean {
  if (writerLock) return true;
  let db: SqliteDatabase | null = null;
  try {
    const lockPath = bodyIndexLockPath(indexPath);
    ensurePrivateDir(dirname(lockPath));
    ensurePrivateFile(lockPath);
    db = new sqlite.DatabaseSync(lockPath);
    db.exec("PRAGMA busy_timeout = 0");
    // An in-memory journal: holding the lock must not leave a `-journal` file
    // (with the umask's mode) next to it.
    db.exec("PRAGMA journal_mode = MEMORY");
    db.exec("BEGIN EXCLUSIVE");
    writerLock = db;
    return true;
  } catch {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    return false;
  }
}

function releaseWriterLock(): void {
  if (!writerLock) return;
  try {
    writerLock.exec("ROLLBACK");
  } catch {
    /* ignore */
  }
  try {
    writerLock.close();
  } catch {
    /* ignore */
  }
  writerLock = null;
}

/**
 * Become the writer if no other instance is: take the lock, open the index
 * read-write (creating or rebuilding it), and start watching when the
 * background loop runs. Returns the writer, or null when another instance
 * holds the role (or the index can't be opened, which is noted).
 */
function claimWriter(): BodyIndexWriter | null {
  if (writer) return writer;
  const sqlite = sqliteModule();
  const store = resolveMailStore();
  if (!sqlite || !store) return null;
  const path = bodyIndexPath();
  if (!tryAcquireWriterLock(sqlite, path)) return null;
  const opened = BodyIndexWriter.open(store.versionDir, path, sqlite, clock);
  if ("reason" in opened) {
    releaseWriterLock();
    noteError("open", opened.reason);
    return null;
  }
  writer = opened;
  if (opened.rebuilt) console.error(`[bodyIndex] rebuilt the index: ${opened.rebuilt}`);
  console.error("[bodyIndex] writer: this instance keeps the index current");
  if (running) startWatching(opened);
  return writer;
}

/** Whether this instance is the one keeping the index current. */
export function isBodyIndexWriter(): boolean {
  return writer !== null;
}

/** Whether the FSEvents watcher is feeding changes in. */
export function isBodyIndexWatching(): boolean {
  return watcher !== null;
}

// --- watcher -------------------------------------------------------------------

function startWatching(w: BodyIndexWriter): void {
  if (watcher) return;
  try {
    watcher = watchImpl(
      w.versionDir,
      (eventType, filename) => {
        if (filename === null) {
          walkRequested = true; // FSEvents coalesced or dropped events
        } else if (filename.endsWith(".emlx")) {
          if (filename.split("/")[0] === "MailData") return;
          changedPaths.add(join(w.versionDir, filename));
        } else if (eventType === "rename" && filename.endsWith(".mbox")) {
          walkRequested = true; // a mailbox was moved, renamed or deleted
        } else {
          return;
        }
        scheduleBatch();
      },
      (err) => {
        noteError("file watcher stopped, using timed walks", err);
        stopWatching();
        walkRequested = true;
        wake(0);
      }
    );
  } catch (err) {
    noteError("file watcher unavailable, using timed walks", err);
    watcher = null;
  }
}

function stopWatching(): void {
  try {
    watcher?.close();
  } catch {
    /* ignore */
  }
  watcher = null;
}

function scheduleBatch(): void {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    wake(0);
  }, WATCH_DEBOUNCE_MS);
  debounceTimer.unref?.();
}

/** Take the queued watcher events (the debounce is over: someone is acting on them). */
function takeChanges(): { walk: boolean; paths: string[] } {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  const walk = walkRequested;
  walkRequested = false;
  // A walk sees every file, so the paths add nothing to it.
  const paths = walk ? [] : [...changedPaths];
  changedPaths.clear();
  return { walk, paths };
}

// --- the build ---------------------------------------------------------------------

function rescanInterval(): number {
  return watcher ? RESCAN_WATCHED_MS : RESCAN_UNWATCHED_MS;
}

/** A timed walk is due: none yet in this process, or the interval has passed since the last. */
function walkDue(): boolean {
  return !walkInFlight && (lastWalkDone === 0 || clock.now() - lastWalkDone >= rescanInterval());
}

/** Hand work to the build, starting one if none is running. */
function handToBuild(w: BodyIndexWriter, walk: boolean, paths: string[]): void {
  const b = build ?? startBuild(w);
  if (walk) walkInFlight = true;
  b.post({ type: "work", seq: ++buildSeq, walk, paths });
}

/**
 * Why no build process can be forked here at all, or null. Under Electron the
 * binary is the app unless `ELECTRON_RUN_AS_NODE` is set, and a build process
 * gets an empty environment, so a fork would start the app instead of Node.
 */
function forkUnavailable(): string | null {
  return process.versions.electron !== undefined
    ? "the server runs on Electron's Node, where a forked process would start the app instead of Node; building on the main thread"
    : null;
}

/** Whether the build runs on the main thread now (a build process can't, or couldn't recently). */
function onMainThread(): boolean {
  return (
    forkUnavailable() !== null ||
    (buildFallback !== null && clock.now() - buildFallback.since < FALLBACK_RETRY_MS)
  );
}

function startBuild(w: BodyIndexWriter): BuildHandle {
  const init: BuilderInit = {
    versionDir: w.versionDir,
    indexPath: w.path,
    sliceMs: SLICE_MS,
    pauseMs: PAUSE_MS,
    protocol: BUILDER_PROTOCOL,
    schemaVersion: BODY_INDEX_SCHEMA_VERSION,
  };
  let handle: BuildHandle | null = null;
  // Events from a build that was since stopped or replaced are dropped.
  const events: BuildEvents = {
    report: (msg) => {
      if (handle === null || handle !== build) return;
      lastBuildReport = clock.monotonic();
      onBuildReport(msg);
    },
    exit: (why) => {
      if (handle !== null && handle === build) onBuildExit(why);
    },
  };
  try {
    handle = (onMainThread() ? mainThreadRunner : runner).start(init, events);
  } catch (err) {
    fallBackToMainThread(`build process could not start (${errText(err)})`);
    handle = mainThreadRunner.start(init, events);
  }
  build = handle;
  buildReady = false;
  lastBuildReport = clock.monotonic();
  watchdog ??= setInterval(() => {
    if (build && clock.monotonic() - lastBuildReport >= BUILD_STALL_MS) onBuildStalled();
  }, BUILD_STALL_MS / 4);
  watchdog.unref?.();
  return handle;
}

function stopBuild(): void {
  const b = build;
  build = null;
  buildReady = false;
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
  // A walk it didn't finish, and file events it was handed but never reported
  // done, are gone with it: a walk sees them all, so ask for one.
  if (walkInFlight || (b !== null && buildDoneSeq !== buildSeq)) walkRequested = true;
  walkInFlight = false;
  if (b) buildStopped = b.stop();
}

function onBuildReport(msg: BuilderReport): void {
  switch (msg.type) {
    case "ready":
      buildReady = true;
      return;
    case "walked":
      walkInFlight = false;
      lastWalkDone = clock.now();
      return;
    case "idle":
      if (msg.seq !== buildSeq) return; // more work is on its way to it
      buildDoneSeq = msg.seq;
      buildFailures = 0;
      stopBuild();
      wake(0); // anything that arrived meanwhile; else sleep until the next walk
      return;
    case "alive":
      return;
    case "failed":
      // Only a build process can lack what the server has: the server's Full
      // Disk Access, or the server's version of the code.
      if (
        !onMainThread() &&
        (msg.where === "version" || (msg.where === "store" && serverCanReadStore()))
      ) {
        stopBuild();
        fallBackToMainThread(
          msg.where === "store" ? `the build process ${msg.message}` : msg.message
        );
        wake(0);
        return;
      }
      buildFailed(
        msg.where === "step"
          ? `index build failed: ${msg.message}`
          : `index build could not start: ${msg.message}`
      );
  }
}

function onBuildExit(why: string): void {
  const started = buildReady;
  stopBuild();
  if (!started && !onMainThread()) {
    fallBackToMainThread(`build process could not start (${why})`);
    wake(0);
    return;
  }
  buildFailed(`build process stopped unexpectedly (${why})`);
}

/** The running build has said nothing for {@link BUILD_STALL_MS}: stop it, as if it had crashed. */
function onBuildStalled(): void {
  const started = buildReady;
  stopBuild();
  const why = `the build process stopped responding (nothing for ${BUILD_STALL_MS / 1000} s), so it was stopped`;
  if (!started && !onMainThread()) {
    fallBackToMainThread(why);
    wake(0);
    return;
  }
  buildFailed(why);
}

/** Whether this process can list the Mail store, which a build process reports it can't. */
function serverCanReadStore(): boolean {
  try {
    readdirSync(writer!.versionDir);
    return true;
  } catch {
    return false;
  }
}

/** Note a failed or crashed build and try again later; the queue is on disk, nothing is lost. */
function buildFailed(why: string): void {
  stopBuild();
  noteError("index build", why);
  buildFailures++;
  wake(buildFailures === 1 ? BUILD_RESTART_MS : rescanInterval());
}

function fallBackToMainThread(why: string): void {
  buildFallback = { why: `${why}; building on the main thread`, since: clock.now() };
  noteError("index build", buildFallback.why);
}

// --- background loop -------------------------------------------------------------

function wake(delay: number): void {
  if (!running) return;
  if (backgroundTimer) clearTimeout(backgroundTimer);
  backgroundTimer = setTimeout(tick, delay);
  backgroundTimer.unref?.();
}

/**
 * Route pending work. With a build running, file events and a due walk go to
 * it — it owns the writes. Without one, file events are applied here (a few
 * rows), and a build is started when a walk is due or anything is queued.
 * Returns whether a build is running afterwards; it reports back when done.
 */
function dispatch(w: BodyIndexWriter): boolean {
  const { walk: requested, paths } = takeChanges();
  const walk = requested || walkDue();
  if (build) {
    if (walk || paths.length > 0) handToBuild(w, walk, paths);
    return true;
  }
  if (!walk && paths.length > 0) w.applyChanges(paths);
  if (walk || w.hasQueued()) {
    handToBuild(w, walk, []);
    return true;
  }
  return false;
}

/**
 * The background loop. A reader only checks whether it can take over. The
 * writer routes pending work to the build, and otherwise sleeps until the next
 * walk is due; a running build wakes it again when it is done.
 */
function tick(): void {
  backgroundTimer = null;
  const w = claimWriter();
  if (!w) {
    wake(WRITER_RETRY_MS);
    return;
  }
  let failed = false;
  try {
    if (dispatch(w)) return;
  } catch (err) {
    noteError("indexing step failed", err);
    failed = true;
  }
  wake(
    nextTickDelay(
      lastWalkDone === 0 ? rescanInterval() : lastWalkDone + rescanInterval() - clock.now(),
      failed
    )
  );
}

/**
 * How long the loop sleeps when no build is running: until the next timed
 * walk, but never less than a pause, and after a failed step never less than
 * a restart — a due walk that keeps failing to start would otherwise retry
 * every millisecond.
 */
export function nextTickDelay(untilWalk: number, failed: boolean): number {
  return Math.max(failed ? BUILD_RESTART_MS : PAUSE_MS, untilWalk);
}

/**
 * Start keeping the index current in the background. No-op (and no file, timer
 * or watcher) when the index is disabled; logs why when it is enabled but
 * can't run.
 */
export function startBackgroundIndexing(): void {
  if (running) return;
  const unavailable = bodyIndexUnavailable();
  if (unavailable) {
    if (isBodyIndexEnabled()) {
      lastError = unavailable;
      console.error(`[bodyIndex] not started: ${unavailable}`);
    }
    return;
  }
  running = true;
  const w = claimWriter();
  if (w) startWatching(w);
  else console.error("[bodyIndex] reader: another server instance keeps the index current");
  wake(PAUSE_MS);
}

/** Stop background work, the build and the watcher, give up the writer role, close the index. */
export function stopBodyIndexing(): void {
  running = false;
  if (backgroundTimer) clearTimeout(backgroundTimer);
  backgroundTimer = null;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  stopWatching();
  stopBuild();
  changedPaths.clear();
  walkRequested = false;
  walkInFlight = false;
  buildSeq = 0;
  buildDoneSeq = 0;
  buildFailures = 0;
  lastWalkDone = 0;
  writer?.close();
  writer = null;
  releaseWriterLock();
}

/** Whether a build (walk or indexing) is running now, in its process or on the main thread. */
export function isBodyIndexBuilding(): boolean {
  return build !== null;
}

// --- search & status ----------------------------------------------------------

/**
 * Get ready for a body search: returns the index file to attach, or why body
 * search can't run. Nobody waits for the build. With a build running, the
 * queued file events are handed to it. Without one, the writer applies them
 * and indexes for at most {@link SEARCH_CATCHUP_MS}, so a message that just
 * arrived is usually found, and leaves anything more to a build. Whether the
 * file can be searched (ours, current schema) is checked at attach time.
 */
export function prepareBodySearch(): { ok: true; file: string } | { ok: false; reason: string } {
  const unavailable = bodyIndexUnavailable();
  if (unavailable) return { ok: false, reason: unavailable };
  const path = bodyIndexPath();
  const w = claimWriter();
  if (w) {
    try {
      if (!build) catchUp(w);
      else dispatch(w);
    } catch (err) {
      noteError("search catch-up failed", err);
    }
  } else if (inspectIndexFile(path) === "missing") {
    return { ok: false, reason: "body index not created yet" };
  }
  return { ok: true, file: path };
}

/** A search's catch-up on the main thread, with no build running. */
function catchUp(w: BodyIndexWriter): void {
  const { walk, paths } = takeChanges();
  if (walk) {
    walkRequested = true; // a build will walk; nothing here is worth indexing first
  } else {
    if (paths.length > 0) w.applyChanges(paths);
    if (w.hasQueued()) w.indexStep(SEARCH_CATCHUP_MS, { maxBytes: SEARCH_CATCHUP_MAX_BYTES });
  }
  if (walkRequested || w.hasQueued()) wake(0);
}

/** The body index's state, for `doctor`. */
export interface BodyIndexStatus {
  enabled: boolean;
  /** Why it isn't running, when enabled but unavailable. */
  unavailable?: string;
  path?: string;
  role?: "writer" | "reader";
  watching?: boolean;
  /** Writer only: where walks and parsing run, and whether they are running now. */
  build?: {
    runsOn: "child process" | "main thread";
    running: boolean;
    /** Why it runs on the main thread, when a build process couldn't run. */
    fallback?: string;
  };
  counts?: IndexCounts;
  meta?: IndexMeta;
  /** Last error this process saw (the writer also records it in the index). */
  lastError?: string;
}

/** Report the index's state without changing anything. */
export function bodyIndexStatus(): BodyIndexStatus {
  if (!isBodyIndexEnabled()) return { enabled: false };
  const unavailable = bodyIndexUnavailable();
  if (unavailable) return { enabled: true, unavailable, ...(lastError ? { lastError } : {}) };
  const path = bodyIndexPath();
  const status: BodyIndexStatus = {
    enabled: true,
    path,
    role: writer ? "writer" : "reader",
    watching: watcher !== null,
    ...(writer
      ? {
          build: {
            runsOn: onMainThread() ? "main thread" : runner.runsOn,
            running: build !== null,
            ...(onMainThread() ? { fallback: forkUnavailable() ?? buildFallback!.why } : {}),
          },
        }
      : {}),
    ...(lastError ? { lastError } : {}),
  };
  try {
    if (writer) {
      Object.assign(status, writer.state());
    } else if (inspectIndexFile(path) === "ours") {
      const db = new (sqliteModule()!.DatabaseSync)(path, { readOnly: true });
      try {
        const mismatch = stampMismatch(db);
        if (mismatch) status.unavailable = mismatch;
        else Object.assign(status, readIndexState(db));
      } finally {
        db.close();
      }
    } else {
      status.unavailable = "index file not created yet";
    }
  } catch (err) {
    status.unavailable = `index unreadable: ${errText(err)}`;
  }
  return status;
}

/**
 * Test hook: stop everything and swap the watcher, clock, SQLite module or
 * where the build runs (default: a child process). Resolves once a stopped
 * build process has exited.
 */
export function resetBodyIndexForTests(
  opts: { watch?: WatchFn; clock?: Clock; sqlite?: SqliteModule | null; runner?: BuildRunner } = {}
): Promise<void> {
  stopBodyIndexing();
  watchImpl = opts.watch ?? fsEventsWatch;
  clock = opts.clock ?? realClock;
  sqliteOverride = "sqlite" in opts ? opts.sqlite : undefined;
  runner = opts.runner ?? childRunner;
  buildFallback = null;
  lastError = null;
  return buildStopped;
}
