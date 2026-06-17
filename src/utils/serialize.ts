/**
 * Serial execution gate.
 *
 * Mail.app's AppleScript handler is effectively single-threaded: concurrent
 * `tell application "Mail"` calls queue inside Mail.app, and once enough stack
 * up the later ones blow past their timeouts while earlier ones are still
 * draining — the client sees a cascade of "Request timed out" errors and
 * Mail.app is left half-recovered for the next batch (issue #11).
 *
 * A gate chains every task through a single promise so only one runs at a time,
 * with an optional settle delay between tasks so Mail.app's dispatch queue can
 * drain. Because tasks are chained on promises, awaiting the gate also yields
 * the event loop between calls, keeping the server responsive to protocol
 * traffic (pings, health-check) during a batch.
 *
 * @module utils/serialize
 */

/** A function that serializes a task behind all previously enqueued tasks. */
export type SerialGate = <R>(task: () => R | PromiseLike<R>) => Promise<R>;

/**
 * Creates a serial execution gate.
 *
 * @param settleMs - Delay inserted after each task before the next one starts
 *   (default 50ms). Set to 0 to disable.
 * @returns A `serialize(task)` function. Tasks run strictly in enqueue order and
 *   never overlap; each call resolves/rejects with its task's own result, and a
 *   failing task never breaks serialization for later tasks.
 */
export function createSerialGate(settleMs = 50): SerialGate {
  let tail: Promise<unknown> = Promise.resolve();

  return <R>(task: () => R | PromiseLike<R>): Promise<R> => {
    const result = tail.then(task);
    // Keep the chain alive regardless of this task's outcome, with a settle
    // delay so the next task doesn't race straight back into Mail.app.
    tail = result.then(
      () => settle(settleMs),
      () => settle(settleMs)
    );
    return result;
  };
}

function settle(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
