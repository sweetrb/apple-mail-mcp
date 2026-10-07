/**
 * #276 — the per-call stop signal behind search-messages' deadline and
 * cancellation, and the gate's handling of a request cancelled while queued.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createCallStop,
  describeStop,
  raceStop,
  searchDeadlineMs,
  stoppedByDeadline,
  STOPPED,
} from "@/utils/callStop.js";
import { withErrorHandling, currentCallTiming, successResponse } from "@/tools/respond.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("searchDeadlineMs", () => {
  it("defaults to 45s, honours an override, floors at 2s, ignores junk", () => {
    expect(searchDeadlineMs({})).toBe(45_000);
    expect(searchDeadlineMs({ APPLE_MAIL_MCP_SEARCH_DEADLINE_MS: "30000" })).toBe(30_000);
    expect(searchDeadlineMs({ APPLE_MAIL_MCP_SEARCH_DEADLINE_MS: "500" })).toBe(2_000);
    expect(searchDeadlineMs({ APPLE_MAIL_MCP_SEARCH_DEADLINE_MS: "soon" })).toBe(45_000);
    expect(searchDeadlineMs({ APPLE_MAIL_MCP_SEARCH_DEADLINE_MS: " " })).toBe(45_000);
  });
});

describe("createCallStop", () => {
  afterEach(() => vi.useRealTimers());

  it("fires at the deadline measured from ARRIVAL, not from now", () => {
    vi.useFakeTimers();
    const arrivedAt = Date.now() - 4_000; // already queued 4s
    const stop = createCallStop({ arrivedAt }, 5_000);
    vi.advanceTimersByTime(999);
    expect(stop.signal.aborted).toBe(false);
    vi.advanceTimersByTime(2);
    expect(stop.signal.aborted).toBe(true);
    expect(stoppedByDeadline(stop.signal)).toBe(true);
    expect(describeStop(stop.signal)).toBe(
      "the 5s search deadline (APPLE_MAIL_MCP_SEARCH_DEADLINE_MS)"
    );
    stop.dispose();
  });

  it("follows the request's own cancel", () => {
    const req = new AbortController();
    const stop = createCallStop({ arrivedAt: Date.now(), signal: req.signal }, 60_000);
    expect(stop.signal.aborted).toBe(false);
    req.abort("client gave up");
    expect(stop.signal.aborted).toBe(true);
    expect(stoppedByDeadline(stop.signal)).toBe(false);
    expect(describeStop(stop.signal)).toBe("the request being cancelled");
    stop.dispose();
  });

  it("is already stopped when the request was cancelled before it ran", () => {
    const req = new AbortController();
    req.abort();
    const stop = createCallStop({ arrivedAt: Date.now(), signal: req.signal }, 60_000);
    expect(stop.signal.aborted).toBe(true);
    stop.dispose();
  });

  it("dispose() clears the timer", () => {
    vi.useFakeTimers();
    const stop = createCallStop(undefined, 2_000);
    stop.dispose();
    vi.advanceTimersByTime(10_000);
    expect(stop.signal.aborted).toBe(false);
  });
});

describe("raceStop", () => {
  it("returns the work's value when it wins", async () => {
    const ctrl = new AbortController();
    await expect(raceStop(Promise.resolve(3), ctrl.signal)).resolves.toBe(3);
  });

  it("resolves STOPPED when the signal wins, and swallows the late rejection", async () => {
    const ctrl = new AbortController();
    let reject!: (e: Error) => void;
    const work = new Promise<number>((_, r) => {
      reject = r;
    });
    const raced = raceStop(work, ctrl.signal);
    ctrl.abort();
    await expect(raced).resolves.toBe(STOPPED);
    reject(new Error("socket closed")); // must not surface as unhandled
    await tick(0);
  });

  it("propagates the work's own error when it loses no race", async () => {
    await expect(
      raceStop(Promise.reject(new Error("boom")), new AbortController().signal)
    ).rejects.toThrow("boom");
  });
});

describe("withErrorHandling + the request signal (#276)", () => {
  it("exposes the request's signal to the handler", async () => {
    const req = new AbortController();
    let seen: AbortSignal | undefined;
    const h = withErrorHandling(async () => {
      seen = currentCallTiming()?.signal;
      return successResponse("ok");
    }, "err");
    await h({}, { signal: req.signal });
    expect(seen).toBe(req.signal);
  });

  it("skips a call cancelled while it waited in the queue, freeing the gate", async () => {
    const ran: string[] = [];
    const slow = withErrorHandling(async () => {
      ran.push("slow");
      await tick(50);
      return successResponse("slow");
    }, "err");
    const queued = withErrorHandling(async () => {
      ran.push("queued");
      return successResponse("queued");
    }, "Error searching messages");
    const req = new AbortController();
    const p1 = slow({});
    const p2 = queued({}, { signal: req.signal });
    req.abort(); // client sends notifications/cancelled while it is queued
    const [, r2] = await Promise.all([p1, p2]);
    expect(ran).toEqual(["slow"]);
    expect(r2.isError).toBe(true);
    expect(JSON.stringify(r2)).toContain("request was cancelled before it started");
  });
});
