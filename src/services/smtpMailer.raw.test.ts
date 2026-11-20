import { describe, expect, it, vi } from "vitest";
import { submitRawViaSmtp, type SmtpConfig } from "./smtpMailer.js";

const config: SmtpConfig = {
  host: "unused.invalid",
  port: 587,
  secure: false,
  user: "sender@example.test",
  pass: "unused",
  from: "sender@example.test",
};
const raw = Buffer.from(
  "From: sender@example.test\r\nTo: a@example.test, b@example.test\r\n\r\nSynthetic"
);
const envelope = { from: config.from, to: ["a@example.test", "b@example.test"] };

describe("approved raw SMTP submission", () => {
  it("preserves raw bytes and partial acceptance without a second submission or archive step", async () => {
    const sendMail = vi.fn().mockResolvedValue({
      messageId: "<synthetic@example.test>",
      accepted: [{ address: "a@example.test" }],
      rejected: ["b@example.test"],
    });
    const close = vi.fn(),
      factory = vi.fn(() => ({ sendMail, close }));
    expect(await submitRawViaSmtp(raw, envelope, config, factory as never)).toMatchObject({
      success: true,
      partial: true,
      accepted: ["a@example.test"],
      rejected: ["b@example.test"],
    });
    expect(sendMail).toHaveBeenCalledExactlyOnceWith({ raw, envelope });
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ requireTLS: true, auth: { user: config.user, pass: config.pass } })
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    { metadata: { code: "EAUTH", command: "AUTH PLAIN" }, unknown: false },
    {
      metadata: { code: "ETIMEDOUT", command: "CONN", timeoutType: "CONNECT_TIMEOUT" },
      unknown: false,
    },
    { metadata: { code: "ESOCKET", command: "DATA", responseCode: 550 }, unknown: false },
    {
      metadata: { code: "ETIMEDOUT", command: "CONN", timeoutType: "SOCKET_TIMEOUT" },
      unknown: true,
    },
    { metadata: { code: "ESOCKET", command: "CONN" }, unknown: true },
  ])(
    "keeps definite rejection distinct from lost acknowledgment: %j",
    async ({ metadata, unknown }) => {
      const sendMail = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("Synthetic failure"), metadata));
      const close = vi.fn(),
        factory = vi.fn(() => ({ sendMail, close }));
      const result = await submitRawViaSmtp(raw, envelope, config, factory as never);
      expect(result.success).toBe(false);
      expect(result.deliveryUnknown === true).toBe(unknown);
      expect(sendMail).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    }
  );

  it("refuses a mismatched From before creating a transport", async () => {
    const factory = vi.fn();
    const result = await submitRawViaSmtp(
      raw,
      { ...envelope, from: "other@example.test" },
      config,
      factory as never
    );
    expect(result).toMatchObject({ success: false });
    expect(result.deliveryUnknown).not.toBe(true);
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not invent acceptance metadata for transports that provide none", async () => {
    const factory = vi.fn(() => ({
      sendMail: vi.fn().mockResolvedValue({ messageId: "<id@example.test>" }),
      close: vi.fn(),
    }));
    const result = await submitRawViaSmtp(raw, envelope, config, factory as never);
    expect(result.success).toBe(true);
    expect(result.accepted).toBeUndefined();
    expect(result.rejected).toBeUndefined();
  });
});
