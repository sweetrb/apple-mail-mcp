import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ReadBuffer,
  serializeMessage,
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { MAX_FETCH_ATTACHMENT_BYTES } from "@/utils/attachmentLimits.js";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>(),
  imapFetch: vi.fn(),
  nativeFetch: vi.fn(),
  nativeSave: vi.fn(),
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
vi.mock("@/services/appleMailManager.js", async (original) => ({
  ...(await original<typeof import("@/services/appleMailManager.js")>()),
  AppleMailManager: class {
    getAttachmentBase64 = h.nativeFetch;
    saveAttachment = h.nativeSave;
  },
}));
vi.mock("@/services/imapClient.js", async (original) => ({
  ...(await original<typeof import("@/services/imapClient.js")>()),
  imapFetchAttachment: h.imapFetch,
}));

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
  h.imapFetch.mockReset();
  h.nativeFetch.mockReset();
  h.nativeSave.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

const call = (tool: string, args: Record<string, unknown>) => h.handlers.get(tool)!(args);
const text = (r: CallToolResult) => (r.content[0].type === "text" ? r.content[0].text : "");

describe("registered attachment tools", () => {
  it.each(["imap:fixture", "42"])("returns the complete 3 MiB result through %s", async (id) => {
    const bytes = MAX_FETCH_ATTACHMENT_BYTES;
    const base64 = Buffer.alloc(bytes, 0x61).toString("base64");
    h.imapFetch.mockResolvedValue({ success: true, bytes, base64 });
    h.nativeFetch.mockReturnValue({ success: true, bytes, base64 });
    const result = await call("fetch-attachment", { id, attachmentName: "fit.bin" });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ bytes, contentBase64: base64 });
    expect(text(result)).toContain(base64);
    if (id.startsWith("imap:")) {
      expect(h.imapFetch).toHaveBeenCalledWith(id, "fit.bin", {}, "inline");
    }
    const wire = Buffer.from(serializeMessage({ jsonrpc: "2.0", id: 1, result }));
    expect(STDIO_DEFAULT_MAX_BUFFER_SIZE).toBe(10 * 1024 * 1024);
    expect(wire.length).toBeLessThan(STDIO_DEFAULT_MAX_BUFFER_SIZE);
    const reader = new ReadBuffer();
    reader.append(wire);
    expect(reader.readMessage()).toMatchObject({ result: { structuredContent: { bytes } } });
  });

  it.each(["imap:fixture", "42"])("refuses both 3 MiB + 1 and 4 MiB inline for %s", async (id) => {
    for (const bytes of [MAX_FETCH_ATTACHMENT_BYTES + 1, 4 * 1024 * 1024]) {
      const payload = { success: true, bytes, base64: Buffer.alloc(bytes).toString("base64") };
      h.imapFetch.mockResolvedValue(payload);
      h.nativeFetch.mockReturnValue(payload);
      const result = await call("fetch-attachment", { id, attachmentName: "large.bin" });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("3 MiB");
      expect(text(result)).toContain("save-attachment");
      expect(result.structuredContent?.contentBase64).toBeUndefined();
    }
  });

  it.each(["imap:fixture", "42"])("accepts an empty inline attachment for %s", async (id) => {
    const payload = { success: true, bytes: 0, base64: "" };
    h.imapFetch.mockResolvedValue(payload);
    h.nativeFetch.mockReturnValue(payload);
    const result = await call("fetch-attachment", { id, attachmentName: "empty.bin" });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ bytes: 0, contentBase64: "" });
  });

  it("saves a 4 MiB IMAP attachment through the separate save path", async () => {
    const directory = mkdtempSync("/private/tmp/amcp-save-test-");
    try {
      const payload = Buffer.alloc(4 * 1024 * 1024, 0x42);
      h.imapFetch.mockResolvedValue({
        success: true,
        bytes: payload.length,
        base64: payload.toString("base64"),
      });
      const result = await call("save-attachment", {
        id: "imap:fixture",
        attachmentName: "saved.bin",
        savePath: directory,
      });
      expect(result.isError).not.toBe(true);
      expect(readFileSync(join(directory, "saved.bin")).equals(payload)).toBe(true);
      expect(h.imapFetch).toHaveBeenCalledWith("imap:fixture", "saved.bin");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("saves a zero-byte IMAP attachment", async () => {
    const directory = mkdtempSync("/private/tmp/amcp-save-test-");
    try {
      h.imapFetch.mockResolvedValue({ success: true, bytes: 0, base64: "" });
      const result = await call("save-attachment", {
        id: "imap:fixture",
        attachmentName: "empty.bin",
        savePath: directory,
      });
      expect(result.isError).not.toBe(true);
      expect(readFileSync(join(directory, "empty.bin")).length).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["attachmentName", "mimeType"])("bounds escaped %s metadata", async (field) => {
    const metadata = "\u0001".repeat(400_000);
    const name = field === "attachmentName" ? metadata : "fit.bin";
    h.imapFetch.mockResolvedValue({
      success: true,
      bytes: MAX_FETCH_ATTACHMENT_BYTES,
      base64: Buffer.alloc(MAX_FETCH_ATTACHMENT_BYTES).toString("base64"),
      ...(field === "mimeType" ? { mimeType: metadata } : {}),
    });
    const result = await call("fetch-attachment", { id: "imap:fixture", attachmentName: name });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("save-attachment");
    const reader = new ReadBuffer();
    reader.append(Buffer.from(serializeMessage({ jsonrpc: "2.0", id: 1, result })));
    expect(reader.readMessage()).toMatchObject({ result: { isError: true } });
  });

  it("bounds an error containing oversized metadata", async () => {
    h.imapFetch.mockResolvedValue({
      success: false,
      error: `Missing: ${"\u0001".repeat(2_000_000)}`,
    });
    const result = await call("fetch-attachment", {
      id: "imap:fixture",
      attachmentName: "missing",
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("(truncated)");
    const reader = new ReadBuffer();
    reader.append(Buffer.from(serializeMessage({ jsonrpc: "2.0", id: 1, result })));
    expect(reader.readMessage()).toMatchObject({ result: { isError: true } });
  });
});
