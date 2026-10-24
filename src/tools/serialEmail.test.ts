import { describe, expect, it, vi } from "vitest";
import { createSerialEmailHandler, type SerialEmailDeps } from "./serialEmail.js";
import type { SmtpConfig } from "@/services/smtpMailer.js";

const config: SmtpConfig = {
  host: "smtp.example.test",
  port: 587,
  secure: false,
  user: "sender@example.test",
  pass: "fixture-only",
  from: "sender@example.test",
};
const recipients = [{ email: "recipient@example.test", variables: { Name: "Recipient" } }];
const args = { recipients, subject: "Hello {{Name}}", body: "Test body", delayMs: 0 };
const results = [{ email: recipients[0].email, success: true }];

function fixture() {
  return {
    smtpConfigured: vi.fn(() => true),
    smtpConfig: vi.fn(() => config),
    smtpSend: vi.fn(async () => results),
    appleScriptSend: vi.fn(() => results),
  } satisfies SerialEmailDeps;
}

describe("mail-merge transport selection", () => {
  it("returns an error without sending when selected SMTP credentials cannot be resolved", async () => {
    const deps = fixture();
    deps.smtpConfig.mockImplementation(() => {
      throw new Error("No SMTP password found");
    });

    const response = await createSerialEmailHandler(deps)(args);

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("No SMTP password found");
    expect(deps.smtpSend).not.toHaveBeenCalled();
    expect(deps.appleScriptSend).not.toHaveBeenCalled();
  });

  it("uses configured SMTP and preserves the batch result", async () => {
    const deps = fixture();

    const response = await createSerialEmailHandler(deps)(args);

    expect(deps.smtpSend).toHaveBeenCalledWith(recipients, args.subject, args.body, config, {
      delayMs: 0,
    });
    expect(deps.appleScriptSend).not.toHaveBeenCalled();
    expect(response.structuredContent).toMatchObject({
      ok: true,
      sent: 1,
      failed: 0,
      transport: "smtp",
      results,
    });
  });

  it("keeps the native route available when SMTP is not configured", async () => {
    const deps = fixture();
    deps.smtpConfigured.mockReturnValue(false);

    const response = await createSerialEmailHandler(deps)(args);

    expect(deps.appleScriptSend).toHaveBeenCalledWith(
      recipients,
      args.subject,
      args.body,
      undefined,
      0
    );
    expect(deps.smtpConfig).not.toHaveBeenCalled();
    expect(deps.smtpSend).not.toHaveBeenCalled();
    expect(response.structuredContent).toMatchObject({
      ok: true,
      sent: 1,
      transport: "applescript",
    });
  });

  it("preserves explicit Mail.app account selection", async () => {
    const deps = fixture();

    await createSerialEmailHandler(deps)({ ...args, account: "Work" });

    expect(deps.appleScriptSend).toHaveBeenCalledWith(
      recipients,
      args.subject,
      args.body,
      "Work",
      0
    );
    expect(deps.smtpConfig).not.toHaveBeenCalled();
    expect(deps.smtpSend).not.toHaveBeenCalled();
  });

  it("honors explicit AppleScript even when SMTP is configured", async () => {
    const deps = fixture();

    const response = await createSerialEmailHandler(deps)({
      ...args,
      transport: "applescript",
    });

    expect(response.structuredContent).toMatchObject({ ok: true, transport: "applescript" });
    expect(deps.appleScriptSend).toHaveBeenCalledOnce();
    expect(deps.smtpConfig).not.toHaveBeenCalled();
    expect(deps.smtpSend).not.toHaveBeenCalled();
  });

  it("resolves an explicitly selected SMTP path even when auto-detection is false", async () => {
    const deps = fixture();
    deps.smtpConfigured.mockReturnValue(false);

    const response = await createSerialEmailHandler(deps)({ ...args, transport: "smtp" });

    expect(response.structuredContent).toMatchObject({ ok: true, transport: "smtp" });
    expect(deps.smtpSend).toHaveBeenCalledOnce();
    expect(deps.appleScriptSend).not.toHaveBeenCalled();
  });

  it("does not send natively when explicit SMTP is unavailable", async () => {
    const deps = fixture();
    deps.smtpConfigured.mockReturnValue(false);
    deps.smtpConfig.mockImplementation(() => {
      throw new Error("SMTP transport is not configured");
    });

    const response = await createSerialEmailHandler(deps)({ ...args, transport: "smtp" });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("SMTP transport is not configured");
    expect(deps.smtpSend).not.toHaveBeenCalled();
    expect(deps.appleScriptSend).not.toHaveBeenCalled();
  });

  it("rejects an explicit SMTP request with a Mail.app account label before resolving credentials", async () => {
    const deps = fixture();

    const response = await createSerialEmailHandler(deps)({
      ...args,
      account: "Work",
      transport: "smtp",
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/account label.*SMTP/i);
    expect(deps.smtpConfig).not.toHaveBeenCalled();
    expect(deps.smtpSend).not.toHaveBeenCalled();
    expect(deps.appleScriptSend).not.toHaveBeenCalled();
  });

  it("preserves an allowed email-form account override without changing the SMTP configuration", async () => {
    const deps = fixture();
    const aliasConfig = Object.freeze({ ...config, allowedFrom: ["work@example.test"] });
    deps.smtpConfig.mockReturnValue(aliasConfig);

    const response = await createSerialEmailHandler(deps)({
      ...args,
      account: "work@example.test",
    });

    expect(response.structuredContent).toMatchObject({ ok: true, transport: "smtp" });
    expect(deps.smtpSend).toHaveBeenCalledWith(recipients, args.subject, args.body, aliasConfig, {
      delayMs: 0,
      from: "work@example.test",
    });
    expect(aliasConfig.from).toBe("sender@example.test");
    expect(deps.appleScriptSend).not.toHaveBeenCalled();
  });

  it("rejects an unapproved sender before starting any recipient in the batch", async () => {
    const deps = fixture();
    const batch = [...recipients, { email: "second@example.test", variables: {} }];

    const response = await createSerialEmailHandler(deps)({
      ...args,
      recipients: batch,
      account: "unapproved@example.test",
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("not a configured sender identity");
    expect(deps.smtpSend).not.toHaveBeenCalled();
    expect(deps.appleScriptSend).not.toHaveBeenCalled();
  });

  it("does not switch transports after an SMTP submission failure", async () => {
    const deps = fixture();
    deps.smtpSend.mockRejectedValue(new Error("SMTP submission failed"));

    const response = await createSerialEmailHandler(deps)(args);

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("SMTP submission failed");
    expect(deps.appleScriptSend).not.toHaveBeenCalled();
  });

  it("reports the selected transport and failures when no recipient succeeds", async () => {
    const deps = fixture();
    deps.smtpSend.mockResolvedValue([{ email: recipients[0].email, success: false }]);

    const response = await createSerialEmailHandler(deps)(args);

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      ok: false,
      sent: 0,
      failed: 1,
      transport: "smtp",
    });
    expect(deps.appleScriptSend).not.toHaveBeenCalled();
  });

  it("reports partial SMTP results without retrying failed recipients through Mail.app", async () => {
    const deps = fixture();
    const batch = [...recipients, { email: "second@example.test", variables: {} }];
    deps.smtpSend.mockResolvedValue([
      { email: batch[0].email, success: true },
      { email: batch[1].email, success: false },
    ]);

    const response = await createSerialEmailHandler(deps)({ ...args, recipients: batch });

    expect(response.structuredContent).toMatchObject({
      ok: false,
      sent: 1,
      failed: 1,
      transport: "smtp",
    });
    expect(deps.appleScriptSend).not.toHaveBeenCalled();
  });
});
