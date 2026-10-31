import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>(),
  scripts: [] as string[],
  result: { success: true, output: "running\x1f2\x1f8" } as {
    success: boolean;
    output: string;
    error?: string;
  },
  imapAttachment: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registerTool(name: string, config: Record<string, unknown>, handler: never) {
      h.handlers.set(name, handler);
      return { ...config };
    }
    async connect() {}
  },
}));
vi.mock("@/services/fileConfig.js", () => ({ loadFileConfig: vi.fn() }));
vi.mock("@/tools/resourcesAndPrompts.js", () => ({ registerResourcesAndPrompts: vi.fn() }));
vi.mock("@/utils/applescript.js", async (original) => ({
  ...(await original<typeof import("@/utils/applescript.js")>()),
  executeAppleScript: (script: string) => {
    h.scripts.push(script);
    return h.result;
  },
}));
vi.mock("@/services/imapClient.js", async (original) => ({
  ...(await original<typeof import("@/services/imapClient.js")>()),
  imapFetchAttachment: h.imapAttachment,
}));

import { AppleMailManager } from "@/services/appleMailManager.js";

beforeAll(async () => {
  vi.stubEnv("APPLE_MAIL_MCP_IMAP_IDLE", "false");
  vi.stubEnv("APPLE_MAIL_MCP_BODY_INDEX", "false");
  vi.useFakeTimers();
  const processOn = vi.spyOn(process, "on").mockReturnValue(process);
  const stdinOn = vi.spyOn(process.stdin, "on").mockReturnValue(process.stdin);
  try {
    await import("./index.js");
  } finally {
    processOn.mockRestore();
    stdinOn.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});

beforeEach(() => {
  h.scripts.length = 0;
  h.result = { success: true, output: "running\x1f2\x1f8" };
  h.imapAttachment.mockReset();
});
afterEach(() => vi.restoreAllMocks());

const call = (name: string, args: Record<string, unknown> = {}) => h.handlers.get(name)!(args);
const textOf = (result: CallToolResult) =>
  result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

describe("sync status reports only observed facts", () => {
  it("does not infer active synchronization from a running app with accounts", async () => {
    const result = await call("get-sync-status");
    expect(result.structuredContent).toMatchObject({
      mailRunning: true,
      accountCount: 2,
      mailboxCount: 8,
      syncState: "unknown",
    });
    expect(result.structuredContent).not.toHaveProperty("syncDetected");
    expect(result.structuredContent).not.toHaveProperty("pendingUpload");
    expect(result.structuredContent).not.toHaveProperty("recentActivity");
    expect(result.structuredContent).not.toHaveProperty("secondsSinceLastChange");
    expect(textOf(result)).toMatch(/sync activity: unknown/i);
    expect(textOf(result)).not.toContain("Sync active: Yes");
  });

  it("reports an inaccessible status as an error, not zero pending work", async () => {
    h.result = { success: false, output: "", error: "Automation permission denied" };
    const result = await call("get-sync-status");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ syncState: "unavailable" });
    expect(result.structuredContent).not.toHaveProperty("pendingUpload");
    expect(result.structuredContent).not.toHaveProperty("mailRunning");
    expect(textOf(result)).toContain("Automation permission denied");
  });

  it("refuses malformed observations rather than turning them into zero counts", async () => {
    h.result.output = "running\x1funknown\x1f8";
    const result = await call("get-sync-status");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).not.toHaveProperty("accountCount");
    expect(result.structuredContent).not.toHaveProperty("pendingUpload");
  });

  it("reports a stopped app without launching it or inventing upload counts", async () => {
    h.result.output = "\x1dNOTRUNNING\x1d";
    const result = await call("get-sync-status");
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      mailRunning: false,
      syncState: "not-running",
      syncDetected: false,
    });
    expect(result.structuredContent).not.toHaveProperty("pendingUpload");
    const script = h.scripts.at(-1)!;
    expect(script.indexOf('if application "Mail" is running')).toBeLessThan(
      script.indexOf('tell application "Mail"')
    );
    expect(script).not.toContain('tell application "System Events"');
  });

  it("preserves observed zero counts while leaving activity unknown", async () => {
    h.result.output = "running\x1f0\x1f0";
    const result = await call("get-sync-status");
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      mailRunning: true,
      accountCount: 0,
      mailboxCount: 0,
      syncState: "unknown",
    });
  });
});

describe("attachment responses fit the default MCP stdio buffer", () => {
  it.each(["imap:fixture", "42"])("refuses an oversized inline result for %s", async (id) => {
    const payload = {
      success: true,
      bytes: 4 * 1024 * 1024,
      base64: Buffer.alloc(4 * 1024 * 1024).toString("base64"),
    };
    h.imapAttachment.mockResolvedValue(payload);
    vi.spyOn(AppleMailManager.prototype, "getAttachmentBase64").mockReturnValue(payload);
    const result = await call("fetch-attachment", { id, attachmentName: "large.bin" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("save-attachment");
    expect(result.structuredContent?.contentBase64).toBeUndefined();
    expect(JSON.stringify(result).length).toBeLessThan(1024);
  });

  it("keeps both existing representations at the limit and parses with the actual SDK", async () => {
    const bytes = 3 * 1024 * 1024;
    const base64 = Buffer.alloc(bytes, 0x61).toString("base64");
    h.imapAttachment.mockResolvedValue({ success: true, bytes, base64 });
    const result = await call("fetch-attachment", {
      id: "imap:fixture",
      attachmentName: "fit.bin",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.contentBase64).toBe(base64);
    expect(textOf(result)).toContain(base64);
    const wire = Buffer.from(serializeMessage({ jsonrpc: "2.0", id: 1, result }));
    const reader = new ReadBuffer();
    reader.append(wire);
    expect(reader.readMessage()).toMatchObject({ id: 1, result: { structuredContent: { bytes } } });
  });

  it("accepts a successful empty attachment instead of calling it missing", async () => {
    h.imapAttachment.mockResolvedValue({ success: true, bytes: 0, base64: "" });
    const result = await call("fetch-attachment", {
      id: "imap:fixture",
      attachmentName: "empty.txt",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ bytes: 0, contentBase64: "" });
  });

  it.each(["attachmentName", "mimeType"])(
    "bounds serialized metadata even when the decoded attachment fits: %s",
    async (field) => {
      const bytes = 3 * 1024 * 1024;
      // Escaped control characters expand sixfold in JSON. The input remains
      // below the default SDK buffer, while the unguarded result would not.
      const metadata = "\u0001".repeat(400_000);
      const attachmentName = field === "attachmentName" ? metadata : "fit.bin";
      const args = { id: "imap:fixture", attachmentName };
      const inputReader = new ReadBuffer();
      inputReader.append(
        Buffer.from(
          serializeMessage({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "fetch-attachment", arguments: args },
          })
        )
      );
      expect(inputReader.readMessage()).toBeDefined();
      h.imapAttachment.mockResolvedValue({
        success: true,
        bytes,
        base64: Buffer.alloc(bytes).toString("base64"),
        ...(field === "mimeType" ? { mimeType: metadata } : {}),
      });
      const result = await call("fetch-attachment", args);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("save-attachment");
      expect(result.structuredContent?.contentBase64).toBeUndefined();
      const outputReader = new ReadBuffer();
      outputReader.append(Buffer.from(serializeMessage({ jsonrpc: "2.0", id: 1, result })));
      expect(outputReader.readMessage()).toMatchObject({ result: { isError: true } });
    }
  );

  it("bounds a backend error containing oversized attachment metadata", async () => {
    h.imapAttachment.mockResolvedValue({
      success: false,
      error: `Attachment not found. Available: ${"\u0001".repeat(2_000_000)}`,
    });
    const result = await call("fetch-attachment", {
      id: "imap:fixture",
      attachmentName: "missing",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Attachment not found");
    expect(textOf(result)).toContain("(truncated)");
    const reader = new ReadBuffer();
    reader.append(Buffer.from(serializeMessage({ jsonrpc: "2.0", id: 1, result })));
    expect(reader.readMessage()).toMatchObject({ result: { isError: true } });
  });
});
