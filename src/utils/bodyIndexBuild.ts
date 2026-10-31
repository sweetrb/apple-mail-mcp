/**
 * Body index: the build loop, the part of the writer's work that is heavy. It
 * runs in a child process — the server's own bundle, `build/index.js`, started
 * with {@link BODY_INDEX_BUILDER_ARG} — so walking the store and parsing
 * `.emlx` files never runs on the server's main thread, and the memory that
 * parsing takes goes back to the OS when the process exits. (A `worker_thread`
 * would not do that: V8 keeps a terminated worker's heap pages in the process.)
 * When no build process can run, the same loop runs on the main thread.
 *
 * Who starts and stops it lives in bodyIndexSync.ts; this module is the side
 * that does the work and the messages both sides exchange.
 *
 *  - **Its own connection.** The loop opens the index with
 *    {@link BodyIndexWriter.openExisting}: the server has already claimed the
 *    writer lock and created, stamped or rebuilt the file.
 *  - **Checks it can read the store** before it walks, and says so if it
 *    can't, so a process without the server's Full Disk Access is reported
 *    rather than mistaken for an empty store.
 *  - **Same pacing as before.** Slices of `sliceMs` with `pauseMs` between
 *    them, on `unref()`'d timers. The pauses keep the build to about a third
 *    of a core and let the server's rare writes in between slices.
 *  - **Reports, never decides.** It says when it is ready, when a full walk
 *    finished, when it has nothing left to do (`idle`, with the last work
 *    number it saw) and when something failed. The server decides whether to
 *    stop it.
 *  - **Never outlives the server.** The build process exits when its IPC
 *    channel closes or when it finds itself orphaned (`ppid` 1), whichever
 *    comes first, closing its connection on the way out.
 *  - **Says it is alive** every {@link HEARTBEAT_MS}, so the server can tell a
 *    build that stopped responding from one that is busy.
 *  - **Same code as its server, or nothing.** The server's bundle can be
 *    replaced on disk while it runs (an update). The `start` message carries
 *    the bundle file's identity as the server loaded it, and a protocol and
 *    schema number; a build process started from other files refuses to run.
 *
 * @module utils/bodyIndexBuild
 */

import { readdirSync, statSync } from "fs";
import { BODY_INDEX_SCHEMA_VERSION, BodyIndexWriter, type Clock } from "@/utils/bodyIndex.js";
import type { SqliteModule } from "@/utils/envelopeIndex.js";
import { isOrphaned } from "@/utils/orphan.js";

/** argv flag that makes `build/index.js` the build process instead of the MCP server. */
export const BODY_INDEX_BUILDER_ARG = "--body-index-builder";
/** How often the build process checks whether its parent is gone. */
export const ORPHAN_CHECK_MS = 2_000;
/** How often a running build loop reports that it is alive. */
export const HEARTBEAT_MS = 5_000;
/** Bumped whenever the messages between the server and the build loop change. */
export const BUILDER_PROTOCOL = 1;

/** What the build loop needs to open the index; the build process gets it in its `start` message. */
export interface BuilderInit {
  versionDir: string;
  indexPath: string;
  sliceMs: number;
  pauseMs: number;
  /** The server's {@link BUILDER_PROTOCOL} and index schema, which the loop must share. */
  protocol: number;
  schemaVersion: number;
}

/** What a file is on disk, to tell whether it was replaced: device, inode, size and mtime. */
export interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

/** The identity of the file at `path`, or null when it can't be read. */
export function fileIdentity(path: string): FileIdentity | null {
  try {
    const st = statSync(path);
    return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function sameFile(a: FileIdentity, b: FileIdentity | null): boolean {
  return (
    b !== null && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
  );
}

/** Server → build process, first message: what to open. */
export interface BuilderStart {
  type: "start";
  init: BuilderInit;
  /** The bundle as the server loaded it; the build process checks its own entry against it. */
  entry?: FileIdentity | null;
}

/**
 * Server → build loop. `seq` numbers each hand-off, so an `idle` report
 * can be matched to the last one. A walk makes `paths` redundant (the walk
 * sees those files too).
 */
export interface BuilderWork {
  type: "work";
  seq: number;
  walk: boolean;
  paths: string[];
}

/** Build loop → server. */
export type BuilderReport =
  /** Opened the index and can read the store; `pid` is the process the loop runs in. */
  | { type: "ready"; pid: number }
  | { type: "walked" }
  | { type: "idle"; seq: number }
  /** Sent every {@link HEARTBEAT_MS} while the loop runs. */
  | { type: "alive" }
  /**
   * `store`: it can't read the Mail store (no Full Disk Access in this
   * process). `version`: it isn't the server's version of the code.
   */
  | { type: "failed"; where: "open" | "store" | "step" | "version"; message: string };

/** The loop's side of the channel: the build process's IPC, or a stand-in on the main thread. */
export interface BuilderPort {
  postMessage(msg: BuilderReport): void;
  on(event: "message", listener: (msg: BuilderWork) => void): unknown;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Open the index and serve work from `port` until stopped: on each hand-off,
 * apply the reported file changes or start a walk, then run slices — the walk
 * first, then indexing — until nothing is queued, and report `idle`. After a
 * failed step it reports `failed` and does nothing more.
 */
export function runBuilder(
  port: BuilderPort,
  init: BuilderInit,
  deps: { sqlite: SqliteModule | null; clock: Clock }
): { stop(): void } {
  if (init.protocol !== BUILDER_PROTOCOL || init.schemaVersion !== BODY_INDEX_SCHEMA_VERSION) {
    port.postMessage({
      type: "failed",
      where: "version",
      message:
        `the build process runs other code than the server (its files changed on disk since the server started): ` +
        `protocol ${BUILDER_PROTOCOL} and index schema v${BODY_INDEX_SCHEMA_VERSION} here, ` +
        `protocol ${String(init.protocol)} and schema v${String(init.schemaVersion)} in the server`,
    });
    return { stop() {} };
  }
  const opened = deps.sqlite
    ? BodyIndexWriter.openExisting(init.versionDir, init.indexPath, deps.sqlite, deps.clock)
    : { reason: "node:sqlite unavailable in the build process" };
  if ("reason" in opened) {
    port.postMessage({ type: "failed", where: "open", message: opened.reason });
    return { stop() {} };
  }
  const w = opened;
  try {
    readdirSync(init.versionDir);
  } catch (err) {
    w.close();
    port.postMessage({
      type: "failed",
      where: "store",
      message: `can't read the Mail store (${(err as NodeJS.ErrnoException).code ?? errText(err)})`,
    });
    return { stop() {} };
  }
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // A stuck slice blocks this timer too, which is how the server notices.
  const heartbeat = setInterval(() => port.postMessage({ type: "alive" }), HEARTBEAT_MS);
  heartbeat.unref?.();

  const halt = () => {
    stopped = true;
    clearInterval(heartbeat);
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const fail = (err: unknown) => {
    halt();
    const message = errText(err);
    try {
      w.setMeta("lastError", `${new Date(deps.clock.now()).toISOString()} index build: ${message}`);
    } catch {
      /* the index itself may be the problem */
    }
    port.postMessage({ type: "failed", where: "step", message });
  };
  const schedule = (delay: number) => {
    timer = setTimeout(step, delay);
    timer.unref?.();
  };
  function step(): void {
    timer = null;
    try {
      if (w.walking) {
        if (w.walkStep(init.sliceMs)) port.postMessage({ type: "walked" });
        schedule(init.pauseMs);
        return;
      }
      if (w.hasQueued()) {
        w.indexStep(init.sliceMs);
        schedule(init.pauseMs);
        return;
      }
    } catch (err) {
      fail(err);
      return;
    }
    port.postMessage({ type: "idle", seq });
  }

  port.on("message", (msg) => {
    if (stopped) return;
    seq = msg.seq;
    try {
      if (msg.walk) w.startWalk();
      else if (msg.paths.length > 0) w.applyChanges(msg.paths);
    } catch (err) {
      fail(err);
      return;
    }
    // Between slices a timer is always pending; without one the loop is idle.
    if (!timer) schedule(0);
  });
  port.postMessage({ type: "ready", pid: process.pid });

  return {
    stop() {
      halt();
      w.close();
    },
  };
}

/** The build process's side of `process`: its IPC channel, its parent, and exit. */
export interface BuilderProcess {
  send(msg: BuilderReport): void;
  onMessage(fn: (msg: BuilderStart | BuilderWork) => void): void;
  onDisconnect(fn: () => void): void;
  /** The live parent pid (1 once the parent has died). */
  ppid(): number;
  /** The identity of the bundle this process was started from, now. */
  entry(): FileIdentity | null;
  exit(code: number): void;
}

/**
 * Be the build process: wait for `start`, then serve work from the IPC
 * channel until it closes or the parent is gone, and exit — closing the index
 * connection first. A report that can't be sent (the channel just closed)
 * ends it too.
 */
export function runBuilderProcess(
  proc: BuilderProcess,
  deps: { sqlite: SqliteModule | null; clock: Clock; orphanCheckMs?: number }
): void {
  let loop: { stop(): void } | null = null;
  let listener: ((w: BuilderWork) => void) | null = null;
  let done = false;
  const quit = () => {
    if (done) return;
    done = true;
    clearInterval(orphanCheck);
    loop?.stop();
    proc.exit(0);
  };
  // The IPC channel keeps the process alive; this check must not.
  const orphanCheck = setInterval(() => {
    if (isOrphaned(proc.ppid())) quit();
  }, deps.orphanCheckMs ?? ORPHAN_CHECK_MS);
  orphanCheck.unref?.();
  proc.onDisconnect(quit);
  proc.onMessage((msg) => {
    if (done) return;
    if (msg.type === "start") {
      if (loop) return;
      // An update replaced the bundle after the server loaded it: this process
      // runs other code than the server, which builds with its own instead.
      if (msg.entry && !sameFile(msg.entry, proc.entry())) {
        try {
          proc.send({
            type: "failed",
            where: "version",
            message:
              "the server's files were replaced on disk after it started (an update), so a build process would run other code than the server",
          });
        } catch {
          quit();
        }
        return;
      }
      loop = runBuilder(
        {
          postMessage: (m) => {
            try {
              proc.send(m);
            } catch {
              quit();
            }
          },
          on: (_event, fn) => {
            listener = fn;
          },
        },
        msg.init,
        deps
      );
      return;
    }
    listener?.(msg);
  });
}
