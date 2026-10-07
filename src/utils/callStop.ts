/**
 * One "stop now" signal per tool call: the MCP request's own abort signal
 * (`notifications/cancelled`, transport close) OR a wall-clock deadline
 * anchored at the request's ARRIVAL — whichever fires first (#276).
 *
 * Why both: every tool call is serialized through one gate (#11), so a search
 * that runs for minutes holds every later call behind it. @j5pu measured an
 * unscoped iCloud body search at 134-141s; `list-accounts` sent 3s later came
 * back after 126s, and cancelling the search changed nothing. Honouring the
 * cancel lets a client that gives up release the queue; the deadline does it
 * for clients that never send a cancel, and returns what was found so far
 * instead of a timeout. Anchoring at arrival (as get-mail-stats does, #135)
 * makes the deadline bound the call the CLIENT experiences, queue wait included.
 *
 * @module utils/callStop
 */

/** Why a call was told to stop — carried as the AbortSignal's `reason`. */
export type StopReason =
  { kind: "deadline"; deadlineMs: number; envVar: string } | { kind: "cancelled" };

export interface CallStop {
  /** Aborts on cancel or deadline; `signal.reason` is a {@link StopReason}. */
  signal: AbortSignal;
  /** Clear the timer and detach from the request signal. Call in `finally`. */
  dispose(): void;
}

/** Default per-call deadline for `search-messages` (ms) — well under a 60s client timeout. */
export const DEFAULT_SEARCH_DEADLINE_MS = 45_000;
/** Lowest accepted override: below this nothing useful fits. */
export const MIN_SEARCH_DEADLINE_MS = 2_000;
export const SEARCH_DEADLINE_ENV = "APPLE_MAIL_MCP_SEARCH_DEADLINE_MS";

/**
 * `APPLE_MAIL_MCP_SEARCH_DEADLINE_MS`, defaulting to 45s and floored at 2s —
 * the same shape as `APPLE_MAIL_MCP_STATS_DEADLINE_MS`. Keep it below the MCP
 * client's own request timeout.
 */
export function searchDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SEARCH_DEADLINE_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_SEARCH_DEADLINE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SEARCH_DEADLINE_MS;
  return Math.max(MIN_SEARCH_DEADLINE_MS, Math.floor(n));
}

/**
 * Combine the request's signal with a deadline measured from `arrivedAt`.
 * Either input may be absent (direct unit calls have no request context).
 */
export function createCallStop(
  timing: { arrivedAt: number; signal?: AbortSignal } | undefined,
  deadlineMs: number,
  envVar = SEARCH_DEADLINE_ENV
): CallStop {
  const controller = new AbortController();
  const upstream = timing?.signal;
  const onCancel = () => {
    if (!controller.signal.aborted) controller.abort({ kind: "cancelled" } satisfies StopReason);
  };
  if (upstream?.aborted) onCancel();
  else upstream?.addEventListener("abort", onCancel, { once: true });

  const startedAt = timing?.arrivedAt ?? Date.now();
  const remaining = Math.max(0, deadlineMs - (Date.now() - startedAt));
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort({ kind: "deadline", deadlineMs, envVar } satisfies StopReason);
    }
  }, remaining);
  timer.unref?.();

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      upstream?.removeEventListener("abort", onCancel);
    },
  };
}

/** Human-readable cause for an aborted signal, for partial-result notes. */
export function describeStop(signal: AbortSignal | undefined): string {
  const reason = signal?.reason as StopReason | undefined;
  if (reason && typeof reason === "object" && reason.kind === "deadline") {
    return `the ${Math.round(reason.deadlineMs / 1000)}s search deadline (${reason.envVar})`;
  }
  return "the request being cancelled";
}

/** Whether the signal stopped the call by deadline (vs. a client cancel). */
export function stoppedByDeadline(signal: AbortSignal | undefined): boolean {
  const reason = signal?.reason as StopReason | undefined;
  return !!reason && typeof reason === "object" && reason.kind === "deadline";
}

/** Sentinel resolved by {@link raceStop} when the signal fires first. */
export const STOPPED: unique symbol = Symbol("stopped");

/**
 * Await `work`, or resolve {@link STOPPED} as soon as `signal` aborts. A
 * rejection `work` produces after losing the race is swallowed — the caller
 * has already moved on (and typically closed the connection under it).
 */
export function raceStop<T>(work: Promise<T>, signal?: AbortSignal): Promise<T | typeof STOPPED> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.resolve(STOPPED);
  }
  return new Promise<T | typeof STOPPED>((resolve, reject) => {
    const onAbort = () => {
      work.catch(() => undefined);
      resolve(STOPPED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
