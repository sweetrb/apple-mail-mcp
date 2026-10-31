import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodObject } from "zod";
import nodemailer from "nodemailer";
import { withSmtpFixture } from "@/services/smtpMailer.testFixture.js";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>(),
  schemas: new Map<string, ZodObject>(),
  send: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registerTool(name: string, config: { outputSchema?: ZodObject }, handler: never) {
      h.handlers.set(name, handler);
      if (config.outputSchema) h.schemas.set(name, config.outputSchema);
      return { ...config };
    }
    async connect() {}
  },
}));
vi.mock("@/services/fileConfig.js", () => ({ loadFileConfig: vi.fn() }));
vi.mock("@/tools/resourcesAndPrompts.js", () => ({ registerResourcesAndPrompts: vi.fn() }));
vi.mock("@/services/smtpMailer.js", async (original) => ({
  ...(await original<typeof import("@/services/smtpMailer.js")>()),
  sendViaSmtp: h.send,
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
beforeEach(() => h.send.mockReset());
afterEach(() => vi.unstubAllEnvs());

const call = () =>
  h.handlers.get("send-email")!({
    to: ["accepted@example.com", "rejected@example.com"],
    subject: "Fixture",
    body: "No real message is sent",
    transport: "smtp",
  });

describe("registered SMTP delivery contract", () => {
  it.each([
    {
      name: "all accepted",
      refused: [],
      expected: {
        ok: true,
        sent: true,
        accepted: ["accepted@example.com", "rejected@example.com"],
        rejected: [],
      },
      submissions: 1,
      error: false,
    },
    {
      name: "partial acceptance",
      refused: ["rejected@example.com"],
      expected: {
        ok: false,
        sent: true,
        partial: true,
        accepted: ["accepted@example.com"],
        rejected: ["rejected@example.com"],
      },
      submissions: 1,
      error: false,
    },
    {
      name: "all refused",
      refused: ["accepted@example.com", "rejected@example.com"],
      expected: {
        ok: false,
        sent: false,
        rejected: ["accepted@example.com", "rejected@example.com"],
      },
      submissions: 0,
      error: true,
    },
  ])(
    "propagates real loopback $name through send-email",
    async ({ refused, expected, submissions: count, error }) => {
      const actual = await vi.importActual<typeof import("@/services/smtpMailer.js")>(
        "@/services/smtpMailer.js"
      );
      await withSmtpFixture(refused, async (config, submissions) => {
        h.send.mockImplementation((opts) =>
          actual.sendViaSmtp(opts, config, nodemailer.createTransport, async () => ({}))
        );
        const result = await call();
        expect(!!result.isError).toBe(error);
        expect(result.structuredContent).toMatchObject(expected);
        expect(submissions).toHaveLength(count);
        expect(h.send).toHaveBeenCalledOnce();
      });
    }
  );

  it("does not claim sent or unsent after a real provider stores DATA but loses its acknowledgment", async () => {
    const actual = await vi.importActual<typeof import("@/services/smtpMailer.js")>(
      "@/services/smtpMailer.js"
    );
    await withSmtpFixture(
      [],
      async (config, submissions) => {
        h.send.mockImplementation((opts) =>
          actual.sendViaSmtp(opts, config, nodemailer.createTransport, async () => ({}))
        );
        const result = await call();
        expect(submissions).toHaveLength(1);
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ ok: false, deliveryUnknown: true });
        expect(result.structuredContent?.sent).toBeUndefined();
        expect(result.content[0]).toMatchObject({
          text: expect.stringContaining("Do not resend automatically"),
        });
        expect(h.send).toHaveBeenCalledOnce();
      },
      "close-after-data"
    );
  });

  it("reports accepted and rejected recipients without inviting a full resend", async () => {
    h.send.mockResolvedValue({
      success: true,
      partial: true,
      accepted: ["accepted@example.com"],
      rejected: ["rejected@example.com"],
      messageId: "<fixture@example.com>",
      sentCopy: true,
    });
    const result = await call();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      sent: true,
      partial: true,
      accepted: ["accepted@example.com"],
      rejected: ["rejected@example.com"],
      messageId: "<fixture@example.com>",
      sentCopy: true,
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("Do not resend to accepted recipients"),
    });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("preserves complete rejection as a failed submission", async () => {
    h.send.mockResolvedValue({
      success: false,
      error: "All recipients rejected",
      accepted: [],
      rejected: ["accepted@example.com", "rejected@example.com"],
    });
    const result = await call();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      sent: false,
      accepted: [],
      rejected: ["accepted@example.com", "rejected@example.com"],
    });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it.each(["send-email", "reply-to-message", "forward-message"])(
    "advertises delivery fields for %s",
    (name) => {
      const fields = h.schemas.get(name)!.shape;
      expect(fields.partial).toBeDefined();
      expect(fields.accepted).toBeDefined();
      expect(fields.rejected).toBeDefined();
      expect(fields.sent).toBeDefined();
      expect(fields.deliveryUnknown).toBeDefined();
    }
  );

  it("advertises separate unknown outcome counts for serial submissions", () => {
    const fields = h.schemas.get("send-serial-email")!.shape;
    expect(fields.unknown).toBeDefined();
    expect(fields.deliveryUnknown).toBeDefined();
  });
});
