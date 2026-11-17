import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>(),
  smtpSend: vi.fn(),
  nativeSend: vi.fn(),
}));

// Exercise the registered production handler without opening stdio, loading the
// user's configuration, or permitting either delivery backend to run.
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registerTool(name: string, config: Record<string, unknown>, handler: never) {
      mocks.handlers.set(name, handler);
      return { ...config };
    }
    async connect() {}
  },
}));
vi.mock("@/services/fileConfig.js", () => ({
  loadFileConfig: vi.fn(),
  fileConfigPath: () => "/nonexistent/apple-mail-mcp-test-config.json",
}));
vi.mock("@/tools/resourcesAndPrompts.js", () => ({ registerResourcesAndPrompts: vi.fn() }));
vi.mock("@/services/appleMailManager.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/appleMailManager.js")>()),
  AppleMailManager: class {
    sendEmail = mocks.nativeSend;
  },
}));
vi.mock("@/services/smtpMailer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/smtpMailer.js")>()),
  sendViaSmtp: mocks.smtpSend,
}));

beforeAll(async () => {
  vi.stubEnv("APPLE_MAIL_MCP_IMAP_IDLE", "false");
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
  mocks.smtpSend.mockReset().mockResolvedValue({ success: true });
  mocks.nativeSend.mockReset().mockReturnValue({ success: true, from: "work@example.test" });
  vi.stubEnv("APPLE_MAIL_MCP_SMTP_HOST", "smtp.example.test");
  vi.stubEnv("APPLE_MAIL_MCP_SMTP_USER", "sender@example.test");
});

afterEach(() => vi.unstubAllEnvs());

const args = { to: ["recipient@example.test"], subject: "Fixture", body: "Fixture body" };
const send = (extra: Record<string, unknown> = {}) =>
  mocks.handlers.get("send-email")!({ ...args, ...extra });

describe("registered send-email sender selection", () => {
  it("rejects an explicit SMTP account label without calling either backend", async () => {
    const result = await send({ transport: "smtp", account: "Work" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringMatching(/account label.*SMTP/) });
    expect(mocks.smtpSend).not.toHaveBeenCalled();
    expect(mocks.nativeSend).not.toHaveBeenCalled();
  });

  it("preserves native account-label selection when transport is omitted", async () => {
    const result = await send({ account: "Work" });
    expect(result.structuredContent).toMatchObject({ ok: true, transport: "applescript" });
    expect(mocks.nativeSend).toHaveBeenCalledWith(
      args.to,
      args.subject,
      args.body,
      undefined,
      undefined,
      "Work",
      undefined
    );
    expect(mocks.smtpSend).not.toHaveBeenCalled();
  });

  it("passes an email-form override to SMTP for sender authorization", async () => {
    const result = await send({ transport: "smtp", account: "alias@example.test" });
    expect(result.structuredContent).toMatchObject({ ok: true, transport: "smtp" });
    expect(mocks.smtpSend).toHaveBeenCalledWith(
      expect.objectContaining({ ...args, from: "alias@example.test" })
    );
    expect(mocks.nativeSend).not.toHaveBeenCalled();
  });

  it("uses configured SMTP when both account and transport are omitted", async () => {
    const result = await send();
    expect(result.structuredContent).toMatchObject({ ok: true, transport: "smtp" });
    expect(mocks.smtpSend).toHaveBeenCalledWith(expect.objectContaining({ from: undefined }));
    expect(mocks.nativeSend).not.toHaveBeenCalled();
  });

  it("keeps the native default when SMTP is not configured", async () => {
    vi.stubEnv("APPLE_MAIL_MCP_SMTP_HOST", "");
    vi.stubEnv("APPLE_MAIL_MCP_SMTP_USER", "");
    const result = await send();
    expect(result.structuredContent).toMatchObject({ ok: true, transport: "applescript" });
    expect(mocks.nativeSend).toHaveBeenCalledOnce();
    expect(mocks.smtpSend).not.toHaveBeenCalled();
  });

  it("honors explicit native transport with a named account", async () => {
    const result = await send({ transport: "applescript", account: "Work" });
    expect(result.structuredContent).toMatchObject({ ok: true, transport: "applescript" });
    expect(mocks.nativeSend).toHaveBeenCalledOnce();
    expect(mocks.smtpSend).not.toHaveBeenCalled();
  });
});
