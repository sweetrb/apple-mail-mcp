/** Real localhost SMTP recipient acceptance, without external mail or credentials. */
import { describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import { sendViaSmtp } from "@/services/smtpMailer.js";
import { withSmtpFixture } from "./smtpMailer.testFixture.js";

describe("SMTP recipient acceptance", () => {
  it.each([
    { code: "ETIMEDOUT", command: "CONN", timeoutType: "CONNECT_TIMEOUT" },
    { code: "ESOCKET", originalCode: "ETIMEDOUT", command: "CONN", syscall: "connect" },
  ])("classifies an unreachable connection timeout as unsent: %j", async (metadata) => {
    const error = Object.assign(new Error("Connection timeout"), metadata);
    const createTransport = vi.fn(() => ({
      sendMail: vi.fn().mockRejectedValue(error),
      close: vi.fn(),
    }));
    const result = await sendViaSmtp(
      { to: ["recipient@example.test"], subject: "Timeout", body: "Synthetic" },
      {
        host: "unreachable.invalid",
        port: 587,
        secure: false,
        user: "fixture",
        pass: "synthetic",
        from: "fixture@example.test",
      },
      createTransport as never,
      async () => ({})
    );
    expect(result.success).toBe(false);
    expect(result.deliveryUnknown).not.toBe(true);
    expect(result.error).toContain("SMTP send failed");
  });

  it("keeps a socket inactivity timeout unknown because DATA may already have been sent", async () => {
    const error = Object.assign(new Error("Timeout"), {
      code: "ETIMEDOUT",
      command: "CONN",
      timeoutType: "SOCKET_TIMEOUT",
    });
    const createTransport = vi.fn(() => ({
      sendMail: vi.fn().mockRejectedValue(error),
      close: vi.fn(),
    }));
    const result = await sendViaSmtp(
      { to: ["recipient@example.test"], subject: "Timeout", body: "Synthetic" },
      {
        host: "fixture.invalid",
        port: 587,
        secure: false,
        user: "fixture",
        pass: "synthetic",
        from: "fixture@example.test",
      },
      createTransport as never,
      async () => ({})
    );
    expect(result).toMatchObject({ success: false, deliveryUnknown: true });
  });

  it("reports an unknown outcome when the provider stores DATA and its acknowledgment is lost", async () => {
    await withSmtpFixture(
      [],
      async (config, submissions) => {
        const archive = vi.fn(async () => ({ sentCopy: true }));
        const result = await sendViaSmtp(
          { to: ["recipient@example.test"], subject: "Lost acknowledgment", body: "Synthetic" },
          config,
          nodemailer.createTransport,
          archive
        );
        expect(submissions).toHaveLength(1);
        expect(result).toMatchObject({ success: false, deliveryUnknown: true });
        expect(result.accepted).toBeUndefined();
        expect(result.error).toContain("outcome unknown");
        expect(archive).not.toHaveBeenCalled();
      },
      "close-after-data"
    );
  });

  it("keeps an explicit negative DATA acknowledgment a known failure", async () => {
    await withSmtpFixture(
      [],
      async (config, submissions) => {
        const archive = vi.fn(async () => ({ sentCopy: true }));
        const result = await sendViaSmtp(
          { to: ["recipient@example.test"], subject: "Rejected DATA", body: "Synthetic" },
          config,
          nodemailer.createTransport,
          archive
        );
        expect(submissions).toHaveLength(1);
        expect(result.success).toBe(false);
        expect(result.deliveryUnknown).not.toBe(true);
        expect(result.accepted).toBeUndefined();
        expect(archive).not.toHaveBeenCalled();
      },
      "reject-data"
    );
  });

  it("reports partial submission without retrying recipients or discarding its Sent copy", async () => {
    await withSmtpFixture(["refused@example.test"], async (config, submissions) => {
      const archive = vi.fn(async () => ({ sentCopy: true }));
      const result = await sendViaSmtp(
        {
          to: ["accepted@example.test"],
          cc: ["refused@example.test"],
          bcc: ["hidden@example.test"],
          subject: "Partial fixture",
          body: "Synthetic content",
        },
        config,
        nodemailer.createTransport,
        archive
      );
      expect(result).toMatchObject({
        success: true,
        partial: true,
        accepted: ["accepted@example.test", "hidden@example.test"],
        rejected: ["refused@example.test"],
        sentCopy: true,
      });
      expect(result.messageId).toBeTruthy();
      expect(submissions).toHaveLength(1);
      expect(archive).toHaveBeenCalledOnce();
      expect(submissions[0]).not.toMatch(/^Bcc:/m);
    });
  });

  it("reports the complete accepted set when every recipient is accepted", async () => {
    await withSmtpFixture([], async (config, submissions) => {
      const result = await sendViaSmtp(
        { to: ["first@example.test", "second@example.test"], subject: "All", body: "Synthetic" },
        config,
        nodemailer.createTransport,
        async () => ({})
      );
      expect(result).toMatchObject({
        success: true,
        partial: false,
        accepted: ["first@example.test", "second@example.test"],
        rejected: [],
      });
      expect(submissions).toHaveLength(1);
    });
  });

  it("preserves total-recipient rejection without claiming a submission or filing a Sent copy", async () => {
    await withSmtpFixture(["refused@example.test"], async (config, submissions) => {
      const archive = vi.fn(async () => ({ sentCopy: true }));
      const result = await sendViaSmtp(
        { to: ["refused@example.test"], subject: "None", body: "Synthetic" },
        config,
        nodemailer.createTransport,
        archive
      );
      expect(result).toMatchObject({ success: false, rejected: ["refused@example.test"] });
      expect(result.deliveryUnknown).not.toBe(true);
      expect(result.error).toContain("SMTP send failed");
      expect(submissions).toEqual([]);
      expect(archive).not.toHaveBeenCalled();
    });
  });
});
