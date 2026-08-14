/**
 * Tests for the SMTP transport (issue #12).
 *
 * Config resolution and the send flow are tested without touching the network
 * or the real Keychain: the transporter is injected and Keychain-free configs
 * are passed explicitly.
 */

import { describe, it, expect, vi } from "vitest";
import {
  resolveSmtpConfig,
  sendViaSmtp,
  sendSerialViaSmtp,
  applyPlaceholders,
  isSmtpConfigured,
  shouldUseSmtp,
  SMTP_ENV,
  type SmtpConfig,
  type SmtpSendOptions,
} from "./smtpMailer.js";

const baseEnv = {
  [SMTP_ENV.host]: "smtp.example.com",
  [SMTP_ENV.user]: "alice@example.com",
  [SMTP_ENV.password]: "s3cret",
} as NodeJS.ProcessEnv;

const testConfig: SmtpConfig = {
  host: "smtp.example.com",
  port: 587,
  secure: false,
  user: "alice@example.com",
  pass: "s3cret",
  from: "alice@example.com",
  allowedFrom: ["team@example.com"],
};

describe("resolveSmtpConfig", () => {
  it("resolves host/user/password from env with sensible defaults", () => {
    const cfg = resolveSmtpConfig(baseEnv);
    expect(cfg.host).toBe("smtp.example.com");
    expect(cfg.user).toBe("alice@example.com");
    expect(cfg.pass).toBe("s3cret");
    expect(cfg.port).toBe(587); // STARTTLS default
    expect(cfg.secure).toBe(false);
    expect(cfg.from).toBe("alice@example.com"); // defaults to user
  });

  it("defaults to port 465 when secure is set", () => {
    const cfg = resolveSmtpConfig({ ...baseEnv, [SMTP_ENV.secure]: "true" });
    expect(cfg.secure).toBe(true);
    expect(cfg.port).toBe(465);
  });

  it("honors an explicit port and From override", () => {
    const cfg = resolveSmtpConfig({
      ...baseEnv,
      [SMTP_ENV.port]: "2525",
      [SMTP_ENV.from]: "noreply@example.com",
    });
    expect(cfg.port).toBe(2525);
    expect(cfg.from).toBe("noreply@example.com");
  });

  it("parses an explicit comma-separated sender alias allowlist", () => {
    const cfg = resolveSmtpConfig({
      ...baseEnv,
      [SMTP_ENV.allowedFrom]: "team@example.com, billing@example.com",
    });
    expect(cfg.allowedFrom).toEqual(["team@example.com", "billing@example.com"]);
  });

  it("throws an actionable error when host/user are missing", () => {
    expect(() => resolveSmtpConfig({})).toThrow(/not configured/i);
    expect(() => resolveSmtpConfig({})).toThrow(SMTP_ENV.host);
    expect(() => resolveSmtpConfig({})).toThrow(SMTP_ENV.user);
  });

  it("throws when no password is available (env or Keychain)", () => {
    // No password env and a host/user unlikely to exist in the Keychain.
    expect(() =>
      resolveSmtpConfig({
        [SMTP_ENV.host]: "smtp.nonexistent.invalid",
        [SMTP_ENV.user]: "nobody@nonexistent.invalid",
      })
    ).toThrow(/no smtp password/i);
  });

  it("rejects an invalid port", () => {
    expect(() => resolveSmtpConfig({ ...baseEnv, [SMTP_ENV.port]: "not-a-port" })).toThrow(
      /invalid/i
    );
  });
});

describe("isSmtpConfigured", () => {
  it("is true when both host and user are set", () => {
    expect(isSmtpConfigured(baseEnv)).toBe(true);
  });

  it("is false when host is missing", () => {
    expect(isSmtpConfigured({ [SMTP_ENV.user]: "alice@example.com" })).toBe(false);
  });

  it("is false when user is missing", () => {
    expect(isSmtpConfigured({ [SMTP_ENV.host]: "smtp.example.com" })).toBe(false);
  });

  it("is false for empty/whitespace values", () => {
    expect(isSmtpConfigured({ [SMTP_ENV.host]: "  ", [SMTP_ENV.user]: "  " })).toBe(false);
    expect(isSmtpConfigured({})).toBe(false);
  });
});

describe("shouldUseSmtp (send-email transport decision)", () => {
  it("always uses SMTP when explicitly requested, even if unconfigured", () => {
    expect(shouldUseSmtp("smtp", undefined, false)).toBe(true);
    expect(shouldUseSmtp("smtp", "Work", true)).toBe(true);
  });

  it("never uses SMTP when applescript is explicitly requested", () => {
    expect(shouldUseSmtp("applescript", undefined, true)).toBe(false);
    expect(shouldUseSmtp("applescript", "me@example.com", true)).toBe(false);
  });

  it("auto-prefers SMTP when configured and no transport/account is given", () => {
    expect(shouldUseSmtp(undefined, undefined, true)).toBe(true);
  });

  it("stays on AppleScript when SMTP is not configured", () => {
    expect(shouldUseSmtp(undefined, undefined, false)).toBe(false);
    expect(shouldUseSmtp(undefined, "me@example.com", false)).toBe(false);
  });

  it("does NOT hijack a non-email account label (Mail.app account selection)", () => {
    // Regression guard: account="Work" + configured SMTP must still use AppleScript.
    expect(shouldUseSmtp(undefined, "Work", true)).toBe(false);
  });

  it("auto-prefers SMTP when the account is an email address (From override)", () => {
    expect(shouldUseSmtp(undefined, "me@example.com", true)).toBe(true);
  });
});

describe("sendViaSmtp", () => {
  it("rejects a From override outside the configured SMTP identities", async () => {
    const createTransport = vi.fn();
    const result = await sendViaSmtp(
      {
        to: ["bob@example.com"],
        subject: "Hi",
        body: "Body",
        from: "spoofed@example.net",
      },
      testConfig,
      createTransport as never
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a configured sender identity/);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("sends clean MIME via the injected transporter and reports success", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<abc@example.com>" });
    const close = vi.fn();
    const createTransport = vi.fn().mockReturnValue({ sendMail, close });

    const result = await sendViaSmtp(
      { to: ["bob@example.com"], subject: "Hi", body: "Plain body, no blockquote." },
      testConfig,
      createTransport as never
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("<abc@example.com>");

    // Transporter built from the config
    expect(createTransport).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: "alice@example.com", pass: "s3cret" },
    });

    // Body delivered as plain text (no HTML => no blockquote wrapping path)
    const payload = sendMail.mock.calls[0][0];
    expect(payload.text).toBe("Plain body, no blockquote.");
    expect(payload.html).toBeUndefined();
    expect(payload.from).toBe("alice@example.com");
    expect(payload.to).toEqual(["bob@example.com"]);
    expect(close).toHaveBeenCalled();
  });

  it("sends multipart/alternative when an htmlBody is provided", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<h>" });
    const createTransport = vi.fn().mockReturnValue({ sendMail, close: vi.fn() });

    await sendViaSmtp(
      {
        to: ["bob@example.com"],
        subject: "s",
        body: "plain fallback",
        htmlBody: "<p>rich</p>",
      },
      testConfig,
      createTransport as never
    );

    const payload = sendMail.mock.calls[0][0];
    expect(payload.text).toBe("plain fallback"); // text/plain part preserved
    expect(payload.html).toBe("<p>rich</p>"); // text/html alternative added
  });

  it("omits the html part when htmlBody is empty/whitespace", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<h>" });
    const createTransport = vi.fn().mockReturnValue({ sendMail, close: vi.fn() });

    await sendViaSmtp(
      { to: ["bob@example.com"], subject: "s", body: "b", htmlBody: "   " },
      testConfig,
      createTransport as never
    );

    expect(sendMail.mock.calls[0][0].html).toBeUndefined();
  });

  it("attaches inline base64 content as a Buffer and validates file paths (B4)", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<x>" });
    const createTransport = vi.fn().mockReturnValue({ sendMail, close: vi.fn() });

    await sendViaSmtp(
      {
        to: ["bob@example.com"],
        subject: "s",
        body: "b",
        attachments: [
          { filename: "hello.txt", contentBase64: Buffer.from("hi there").toString("base64") },
        ],
      },
      testConfig,
      createTransport as never
    );

    const atts = sendMail.mock.calls[0][0].attachments;
    expect(atts).toHaveLength(1);
    expect(atts[0].filename).toBe("hello.txt");
    expect(Buffer.isBuffer(atts[0].content)).toBe(true);
    expect(atts[0].content.toString()).toBe("hi there");
  });

  it("rejects a non-absolute attachment path", async () => {
    const createTransport = vi.fn().mockReturnValue({ sendMail: vi.fn(), close: vi.fn() });
    const r = await sendViaSmtp(
      { to: ["b@example.com"], subject: "s", body: "b", attachments: ["relative/path.pdf"] },
      testConfig,
      createTransport as never
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/must be absolute/);
  });

  it("uses the per-call from override when provided", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<x>" });
    const createTransport = vi.fn().mockReturnValue({ sendMail, close: vi.fn() });

    await sendViaSmtp(
      { to: ["bob@example.com"], subject: "s", body: "b", from: "team@example.com" },
      testConfig,
      createTransport as never
    );

    expect(sendMail.mock.calls[0][0].from).toBe("team@example.com");
  });

  it("returns a clean error (not a throw) when the transport fails", async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const close = vi.fn();
    const createTransport = vi.fn().mockReturnValue({ sendMail, close });

    const result = await sendViaSmtp(
      { to: ["bob@example.com"], subject: "s", body: "b" },
      testConfig,
      createTransport as never
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SMTP send failed: ECONNREFUSED/);
    expect(close).toHaveBeenCalled(); // transporter closed even on failure
  });

  it("rejects a non-absolute attachment path before connecting", async () => {
    const createTransport = vi.fn();
    const result = await sendViaSmtp(
      { to: ["bob@example.com"], subject: "s", body: "b", attachments: ["relative/path.pdf"] },
      testConfig,
      createTransport as never
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/must be absolute/);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("surfaces a config error as a result rather than throwing", async () => {
    // No config injected and empty env => resolveSmtpConfig throws, caught into result.
    const result = await sendViaSmtp(
      { to: ["bob@example.com"], subject: "s", body: "b" },
      undefined,
      vi.fn() as never
    );
    // In this environment env is unset for SMTP, so config resolution fails.
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("sendViaSmtp threading headers (2.5.0)", () => {
  it("passes inReplyTo and references through to nodemailer", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<new@host>" });
    const createTransport = vi.fn(() => ({ sendMail, close: vi.fn() })) as never;
    const result = await sendViaSmtp(
      {
        to: ["a@b.com"],
        subject: "Re: hi",
        body: "hello",
        inReplyTo: "<orig@host>",
        references: ["<root@host>", "<orig@host>"],
      },
      testConfig,
      createTransport
    );
    expect(result.success).toBe(true);
    const arg = sendMail.mock.calls[0][0];
    expect(arg.inReplyTo).toBe("<orig@host>");
    expect(arg.references).toEqual(["<root@host>", "<orig@host>"]);
  });

  it("omits empty threading headers", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<x>" });
    const createTransport = vi.fn(() => ({ sendMail, close: vi.fn() })) as never;
    await sendViaSmtp({ to: ["a@b.com"], subject: "hi", body: "x" }, testConfig, createTransport);
    const arg = sendMail.mock.calls[0][0];
    expect(arg.inReplyTo).toBeUndefined();
    expect(arg.references).toBeUndefined();
  });
});

describe("applyPlaceholders", () => {
  it("replaces {{Key}} tokens, escapes regex-special keys, leaves unknowns intact", () => {
    expect(applyPlaceholders("Hi {{Name}}", { Name: "Alice" })).toBe("Hi Alice");
    expect(applyPlaceholders("{{a.b}}", { "a.b": "X" })).toBe("X");
    expect(applyPlaceholders("{{Missing}}", { Other: "y" })).toBe("{{Missing}}");
  });
});

describe("sendSerialViaSmtp", () => {
  it("personalizes per recipient, reports each result, and a single failure never aborts", async () => {
    const calls: SmtpSendOptions[] = [];
    const send = vi.fn(async (opts: SmtpSendOptions) => {
      calls.push(opts);
      return opts.to[0] === "bob@x.com"
        ? { success: false, error: "bounced" }
        : { success: true, messageId: "<ok>" };
    });
    const sleep = vi.fn(async () => {});
    const results = await sendSerialViaSmtp(
      [
        { email: "alice@x.com", variables: { Name: "Alice" } },
        { email: "bob@x.com", variables: { Name: "Bob" } },
      ],
      "Hi {{Name}}",
      "Dear {{Name}},",
      testConfig,
      { delayMs: 250, send: send as never, sleep }
    );
    expect(calls[0].subject).toBe("Hi Alice");
    expect(calls[0].body).toBe("Dear Alice,");
    expect(calls[0].to).toEqual(["alice@x.com"]);
    expect(results).toEqual([
      { email: "alice@x.com", success: true, error: undefined },
      { email: "bob@x.com", success: false, error: "bounced" },
    ]);
    // one inter-send delay between two recipients, none trailing the last
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("skips sleeping entirely when delayMs is 0", async () => {
    const sleep = vi.fn(async () => {});
    const send = vi.fn(async () => ({ success: true, messageId: "<ok>" }));
    await sendSerialViaSmtp(
      [
        { email: "a@x.com", variables: {} },
        { email: "b@x.com", variables: {} },
      ],
      "s",
      "b",
      testConfig,
      { delayMs: 0, send: send as never, sleep }
    );
    expect(sleep).not.toHaveBeenCalled();
  });
});
