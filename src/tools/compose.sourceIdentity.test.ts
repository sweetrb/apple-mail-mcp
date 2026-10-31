import { describe, expect, it, vi } from "vitest";
import { runForward, runReply, type ComposeDeps } from "./compose.js";
import type { SmtpConfig, SmtpSendOptions } from "@/services/smtpMailer.js";

const raw = [
  "From: sender@example.com",
  "To: work@example.com",
  "Subject: Work correspondence",
  "Message-ID: <work-message@example.com>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Original work message.",
].join("\r\n");
const config: SmtpConfig = {
  host: "smtp.example.test",
  port: 587,
  secure: false,
  user: "apikey",
  pass: "fixture",
  from: "personal@example.com",
  allowedFrom: ["work@example.com"],
};

function fixture() {
  return {
    mail: {
      getRawSource: vi.fn(() => raw),
      getRawSourceWithLocation: vi.fn(
        (): { raw: string; account: string; mailbox: string } | null => ({
          raw,
          account: "Work",
          mailbox: "INBOX",
        })
      ),
      getMessageContent: vi.fn(() => ({
        id: "42",
        subject: "Work correspondence",
        rfcMessageId: "work-message@example.com",
        plainText: "Original work message.",
      })),
      listAccountsChecked: vi.fn(() => ({
        failed: false,
        accounts: [
          {
            name: "Work",
            email: "work@example.com",
            addresses: ["work@example.com"],
            enabled: true,
          },
        ],
      })),
      consumeLastMessageLookupError: vi.fn(() => undefined as string | undefined),
      replyToMessage: vi.fn(() => ({ success: true })),
      forwardMessage: vi.fn(() => ({ success: true })),
    },
    imapSource: vi.fn(),
    numericId: vi.fn(async () => ({ numericId: "42" })),
    smtpConfigured: () => true,
    smtpConfig: vi.fn(() => config),
    smtpSend: vi.fn(async (_options: SmtpSendOptions, _config: SmtpConfig) => ({
      success: true,
      messageId: "<sent@example.com>",
    })),
  } satisfies ComposeDeps;
}

function compose(deps: ComposeDeps, kind: "reply" | "forward") {
  return kind === "reply"
    ? runReply(deps, { id: "42", body: "Follow-up", send: true, replyAll: false })
    : runForward(deps, { id: "42", to: ["recipient@example.com"], body: "For review", send: true });
}

describe("numeric SMTP source identity", () => {
  it.each(["reply", "forward"] as const)(
    "preserves Unicode and MIME-looking plain text in an unscoped numeric %s",
    async (kind) => {
      const deps = fixture();
      deps.smtpConfig.mockReturnValue({ ...config, from: "work@example.com" });
      const body =
        "Olá 世界 — café\r\nこんにちは 🌍\r\nFirst line boundary=abc\r\n--abc\r\nIMPORTANT SECOND HALF";
      const source = raw.replace(
        "Content-Type: text/plain; charset=utf-8\r\n\r\nOriginal work message.",
        `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}`
      );
      deps.mail.getRawSourceWithLocation.mockReturnValue({
        raw: source,
        account: "Work",
        mailbox: "INBOX",
      });

      const result = await compose(deps, kind);

      expect(result.isError).not.toBe(true);
      expect(deps.smtpSend).toHaveBeenCalledOnce();
      const sentBody = deps.smtpSend.mock.calls[0][0].body;
      for (const line of body.split("\r\n")) expect(sentBody).toContain(line);
      expect(deps.mail.getMessageContent).not.toHaveBeenCalled();
    }
  );

  it.each(["reply", "forward"] as const)(
    "preserves multipart boundary substrings and the following text in an unscoped numeric %s",
    async (kind) => {
      const deps = fixture();
      deps.smtpConfig.mockReturnValue({ ...config, from: "work@example.com" });
      const body = "  First --abc suffix.  \r\n--abc is ordinary text\r\nIMPORTANT SECOND HALF";
      const source = `${raw.slice(0, raw.indexOf("Content-Type:"))}Content-Type: multipart/alternative; boundary=abc\r\n\r\n--abc\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n--abc--`;
      deps.mail.getRawSourceWithLocation.mockReturnValue({
        raw: source,
        account: "Work",
        mailbox: "INBOX",
      });
      const result = await compose(deps, kind);
      expect(result.isError).not.toBe(true);
      expect(deps.smtpSend).toHaveBeenCalledOnce();
      for (const line of body.split("\r\n"))
        expect(deps.smtpSend.mock.calls[0][0].body).toContain(line);
      expect(deps.mail.getMessageContent).not.toHaveBeenCalled();
    }
  );

  it.each(["reply", "forward"] as const)(
    "refuses an incomplete multipart source in an unscoped numeric %s",
    async (kind) => {
      const deps = fixture();
      deps.smtpConfig.mockReturnValue({ ...config, from: "work@example.com" });
      const source = `${raw.slice(0, raw.indexOf("Content-Type:"))}Content-Type: multipart/alternative; boundary=abc\r\n\r\n--abc\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPotentially incomplete`;
      deps.mail.getRawSourceWithLocation.mockReturnValue({
        raw: source,
        account: "Work",
        mailbox: "INBOX",
      });
      const result = await compose(deps, kind);
      expect(result.isError).toBe(true);
      expect(deps.smtpSend).not.toHaveBeenCalled();
    }
  );

  it.each(["reply", "forward"] as const)(
    "refuses malformed encoded Unicode source in an unscoped numeric %s",
    async (kind) => {
      const deps = fixture();
      deps.smtpConfig.mockReturnValue({ ...config, from: "work@example.com" });
      const source = `${raw.slice(0, raw.indexOf("Content-Type:"))}Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nOlá =E4=B8=96`;
      deps.mail.getRawSourceWithLocation.mockReturnValue({
        raw: source,
        account: "Work",
        mailbox: "INBOX",
      });
      expect((await compose(deps, kind)).isError).toBe(true);
      expect(deps.smtpSend).not.toHaveBeenCalled();
    }
  );

  it.each(["reply", "forward"] as const)(
    "preserves encoded and multipart source text in an unscoped numeric %s",
    async (kind) => {
      const bodies = [
        {
          content:
            "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nOl=C3=A1 =E4=B8=96=E7=95=8C",
          expected: "Olá 世界",
        },
        {
          content: `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from("こんにちは 🌍").toString("base64")}`,
          expected: "こんにちは 🌍",
        },
        {
          content:
            "Content-Type: text/plain; charset=windows-1252\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nSe=F1or Jos=E9 =80",
          expected: "Señor José €",
        },
        {
          content:
            "Content-Type: text/plain; charset=windows-1252\r\nContent-Transfer-Encoding: 8bit\r\n\r\nSeñor José €",
          expected: "Señor José €",
        },
        {
          content:
            'Content-Type: multipart/alternative; boundary="outer"\r\n\r\n--outer\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nOlá 世界 — café\r\n--outer--',
          expected: "Olá 世界 — café",
        },
      ];
      for (const { content, expected } of bodies) {
        const deps = fixture();
        deps.smtpConfig.mockReturnValue({ ...config, from: "work@example.com" });
        const source = `${raw.slice(0, raw.indexOf("Content-Type:"))}${content}`;
        deps.mail.getRawSourceWithLocation.mockReturnValue({
          raw: source,
          account: "Work",
          mailbox: "INBOX",
        });
        const result = await compose(deps, kind);
        expect(result.isError).not.toBe(true);
        expect(deps.smtpSend).toHaveBeenCalledOnce();
        expect(deps.smtpSend.mock.calls[0][0].body).toContain(expected);
        expect(deps.mail.getMessageContent).not.toHaveBeenCalled();
      }
    }
  );

  it.each(["reply", "forward"] as const)(
    "refuses an unscoped %s from a different account even when that account is an allowed alias",
    async (kind) => {
      const deps = fixture();
      const result = await compose(deps, kind);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("does not match the configured SMTP identity");
      expect(deps.mail.getRawSourceWithLocation).toHaveBeenCalledExactlyOnceWith("42");
      expect(deps.mail.getRawSource).not.toHaveBeenCalled();
      expect(deps.smtpSend).not.toHaveBeenCalled();
      expect(deps.mail.replyToMessage).not.toHaveBeenCalled();
      expect(deps.mail.forwardMessage).not.toHaveBeenCalled();
    }
  );

  it.each(["reply", "forward"] as const)(
    "sends the %s when cfg.from belongs to the observed account, with a non-email SMTP login",
    async (kind) => {
      const deps = fixture();
      deps.smtpConfig.mockReturnValue({ ...config, from: "work@example.com" });
      const result = await compose(deps, kind);
      expect(result.isError).not.toBe(true);
      expect(deps.smtpSend).toHaveBeenCalledOnce();
      expect(deps.smtpSend.mock.calls[0][0]).toMatchObject({ from: "work@example.com" });
      expect(deps.mail.getRawSourceWithLocation).toHaveBeenCalledExactlyOnceWith("42");
      expect(deps.mail.getRawSource).not.toHaveBeenCalled();
      expect(deps.mail.getMessageContent).not.toHaveBeenCalled();
    }
  );

  it("retains a concrete lookup refusal without guessing the SMTP source account", async () => {
    const deps = fixture();
    deps.mail.getRawSourceWithLocation.mockReturnValue(null);
    deps.mail.consumeLastMessageLookupError.mockReturnValue(
      "42 is present in more than one mailbox"
    );
    const result = await compose(deps, "reply");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("42 is present in more than one mailbox");
    expect(deps.smtpSend).not.toHaveBeenCalled();
  });

  it("does not infer an account from headers for an On My Mac message", async () => {
    const deps = fixture();
    deps.smtpConfig.mockReturnValue({ ...config, from: "work@example.com" });
    deps.mail.getRawSourceWithLocation.mockReturnValue({
      raw,
      account: "On My Mac",
      mailbox: "Archive",
    });
    const result = await compose(deps, "forward");
    expect(result.isError).toBe(true);
    expect(deps.smtpSend).not.toHaveBeenCalled();
  });

  it("uses only the atomic source's MIME even when another message reuses the same Message-ID", async () => {
    const deps = fixture();
    deps.smtpConfig.mockReturnValue({ ...config, from: "work@example.com" });
    deps.mail.getMessageContent.mockReturnValue({
      id: "42",
      subject: "Different message",
      rfcMessageId: "work-message@example.com",
      plainText: "Unrelated private content.",
    });
    const result = await compose(deps, "reply");
    expect(result.isError).not.toBe(true);
    expect(deps.smtpSend.mock.calls[0][0]).toMatchObject({
      body: expect.stringContaining("Original work message."),
      inReplyTo: "<work-message@example.com>",
    });
    expect(deps.smtpSend.mock.calls[0][0].body).not.toContain("Unrelated private content");
    expect(deps.mail.getMessageContent).not.toHaveBeenCalled();
  });

  it.each(["reply", "forward"] as const)(
    "accepts one named From address for a %s",
    async (kind) => {
      const deps = fixture();
      deps.smtpConfig.mockReturnValue({ ...config, from: '"Work Person" <work@example.com>' });
      const result = await compose(deps, kind);
      expect(result.isError).not.toBe(true);
      expect(deps.smtpSend).toHaveBeenCalledOnce();
    }
  );

  it.each([
    '"Someone Else" <personal@example.com>',
    "work@example.com, personal@example.com",
    "not-an-address",
  ])("refuses a nonmatching or malformed From: %s", async (from) => {
    const deps = fixture();
    deps.smtpConfig.mockReturnValue({ ...config, from });
    const result = await compose(deps, "reply");
    expect(result.isError).toBe(true);
    expect(deps.smtpSend).not.toHaveBeenCalled();
  });
});
