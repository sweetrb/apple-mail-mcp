/**
 * #276 end-to-end through the real MCP SDK (in-memory transport, no Mail.app):
 * a client's `notifications/cancelled` must reach a `withErrorHandling` handler
 * as an aborted signal, so a long call stops and the NEXT call is not stuck
 * behind it in the serial gate. @j5pu's repro: `list-accounts` sent after a
 * cancelled 134s search still took 133s.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { withErrorHandling, currentCallTiming, successResponse } from "@/tools/respond.js";

describe("#276 — cancellation reaches the handler through the SDK", () => {
  it("a cancelled slow call stops early and frees the gate for the next call", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    let slowStoppedAfterMs = -1;
    server.registerTool(
      "slow",
      { inputSchema: { n: z.number().optional() } },
      withErrorHandling(async () => {
        const started = Date.now();
        const signal = currentCallTiming()?.signal;
        // Stand-in for the per-mailbox IMAP loop: up to 5s of work, checking
        // the signal between steps.
        for (let i = 0; i < 100 && !signal?.aborted; i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
        slowStoppedAfterMs = Date.now() - started;
        return successResponse("slow done");
      }, "err")
    );
    server.registerTool(
      "fast",
      { inputSchema: {} },
      withErrorHandling(async () => successResponse("fast"), "err")
    );

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const ac = new AbortController();
    const slow = client.callTool({ name: "slow", arguments: {} }, undefined, { signal: ac.signal });
    slow.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 150));
    const t0 = Date.now();
    ac.abort("user gave up"); // the SDK sends notifications/cancelled
    const fast = await client.callTool({ name: "fast", arguments: {} });
    const fastLatency = Date.now() - t0;

    expect((fast.content as Array<{ text: string }>)[0].text).toBe("fast");
    expect(slowStoppedAfterMs).toBeGreaterThanOrEqual(0);
    expect(slowStoppedAfterMs).toBeLessThan(1000); // not the full 5s
    expect(fastLatency).toBeLessThan(1000);
    await client.close();
    await server.close();
  });
});
