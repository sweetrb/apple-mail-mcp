/**
 * Tests for arrival-anchored call timing (#135, second follow-up).
 *
 * Every tool call is serialized through the AppleScript gate (#11), so a call can
 * sit queued for as long as the calls ahead of it take. A handler that stamps
 * `Date.now()` on its own first line therefore measures only its own execution
 * and cannot bound what the client experiences — that is how a call with the
 * deadline set to 6s came back at 15.9s reporting `partial: false`.
 *
 * These tests pin the two properties that fix depends on: arrival is stamped
 * before the gate, and the wait is attributed to the call that actually waited.
 */

import { describe, it, expect } from "vitest";
import { withErrorHandling, currentCallTiming, successResponse } from "./respond.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("currentCallTiming", () => {
  it("is undefined outside a wrapped handler", () => {
    expect(currentCallTiming()).toBeUndefined();
  });

  it("stamps arrival BEFORE the serial gate, so queue wait is visible", async () => {
    const seen: { queueWaitMs: number; sinceArrival: number }[] = [];
    // A slow first call and a fast second one, enqueued in the same tick: the
    // second cannot run until the first finishes, and must be able to see it.
    const slow = withErrorHandling(async () => {
      await tick(120);
      return successResponse("slow");
    }, "err");
    const fast = withErrorHandling(async () => {
      const t = currentCallTiming();
      seen.push({
        queueWaitMs: t?.queueWaitMs ?? -1,
        sinceArrival: Date.now() - (t?.arrivedAt ?? Date.now()),
      });
      return successResponse("fast");
    }, "err");

    await Promise.all([slow({}), fast({})]);

    expect(seen).toHaveLength(1);
    // Anchored at handler entry this would be ~0; anchored at arrival it must
    // include the whole wait behind the slow call.
    expect(seen[0].queueWaitMs).toBeGreaterThanOrEqual(100);
    expect(seen[0].sinceArrival).toBeGreaterThanOrEqual(100);
  });

  it("reports ~no wait for a call that queued behind nothing", async () => {
    const waits: number[] = [];
    const handler = withErrorHandling(async () => {
      waits.push(currentCallTiming()?.queueWaitMs ?? -1);
      return successResponse("ok");
    }, "err");

    await handler({});

    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(0);
    expect(waits[0]).toBeLessThan(100);
  });

  it("gives each concurrent call its own timing, not a shared one", async () => {
    const waits: number[] = [];
    const handler = withErrorHandling(async () => {
      waits.push(currentCallTiming()?.queueWaitMs ?? -1);
      await tick(60);
      return successResponse("ok");
    }, "err");

    await Promise.all([handler({}), handler({}), handler({})]);

    expect(waits).toHaveLength(3);
    // The staircase: each call waits for every call ahead of it. Exact values are
    // timing-dependent, but the ORDERING is the guarantee — a shared or
    // handler-anchored stamp would flatten this to ~0,0,0.
    expect(waits[0]).toBeLessThan(waits[1]);
    expect(waits[1]).toBeLessThan(waits[2]);
    expect(waits[2]).toBeGreaterThanOrEqual(100);
  });

  it("keeps timing available across awaits inside the handler", async () => {
    let before = -1;
    let after = -1;
    const handler = withErrorHandling(async () => {
      before = currentCallTiming()?.arrivedAt ?? -1;
      await tick(20);
      // AsyncLocalStorage has to survive the await, or a handler could only read
      // its deadline before doing any work — useless for bounding the work.
      after = currentCallTiming()?.arrivedAt ?? -1;
      return successResponse("ok");
    }, "err");

    await handler({});

    expect(before).toBeGreaterThan(0);
    expect(after).toBe(before);
  });

  it("does not leak timing to a call that runs after an erroring one", async () => {
    const seen: (number | undefined)[] = [];
    const boom = withErrorHandling(async () => {
      throw new Error("boom");
    }, "err");
    const ok = withErrorHandling(async () => {
      seen.push(currentCallTiming()?.arrivedAt);
      return successResponse("ok");
    }, "err");

    const [first, second] = await Promise.all([boom({}), ok({})]);

    expect(first.isError).toBe(true);
    expect(second.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(0);
  });
});
