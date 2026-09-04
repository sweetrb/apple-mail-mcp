import { describe, it, expect, vi } from "vitest";
import nodemailer from "nodemailer";
import { runReply, runForward, type ComposeDeps, type ReplyArgs } from "@/tools/compose.js";
import { encodeImapId } from "@/services/imapClient.js";
import { sendViaSmtp, type SmtpConfig, type SmtpSendOptions } from "@/services/smtpMailer.js";
import { extractTextBody } from "@/utils/mimeParse.js";

const cfg: SmtpConfig = {
  host: "smtp.example.test",
  port: 587,
  secure: false,
  user: "me@example.com",
  pass: "fixture",
  from: "me@example.com",
  allowedFrom: ["alias@example.com"],
};
const id = encodeImapId("Personal", "Archive/Inbox", 42);
const raw = [
  "From: sender@example.com",
  "Reply-To: reply@example.com",
  "To: me@example.com, alias@example.com, teammate@example.com",
  "Subject: Project update",
  "Message-ID: <parent@example.com>",
  "References: <root@example.com>",
  "\t<earlier@example.com>",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Original =E2=9C=93 body.",
].join("\r\n");
const args: ReplyArgs = {
  id,
  body: "New first line.\n\nNew second paragraph.",
  replyAll: false,
  send: true,
};

function fixture() {
  return {
    mail: {
      getRawSource: vi.fn(() => null),
      getMessageContent: vi.fn(() => null),
      replyToMessage: vi.fn(() => ({ success: true })),
      forwardMessage: vi.fn(() => ({ success: true })),
    },
    imapSource: vi.fn(async () => ({ raw, subject: "Project update", accountUser: cfg.user })),
    numericId: vi.fn(async () => ({ numericId: "84" })),
    smtpConfigured: vi.fn(() => true),
    smtpConfig: vi.fn(() => cfg),
    smtpSend: vi.fn(async (_opts: SmtpSendOptions, _cfg: SmtpConfig) => ({
      success: true,
      messageId: "<sent@example.com>",
    })),
  } satisfies ComposeDeps;
}

function expectNoApple(d: ReturnType<typeof fixture>) {
  expect(d.mail.getRawSource).not.toHaveBeenCalled();
  expect(d.mail.getMessageContent).not.toHaveBeenCalled();
  expect(d.numericId).not.toHaveBeenCalled();
  expect(d.mail.replyToMessage).not.toHaveBeenCalled();
  expect(d.mail.forwardMessage).not.toHaveBeenCalled();
}

describe("reply and forward transport routing", () => {
  it("replies to an IMAP id over SMTP without any Mail.app lookup", async () => {
    const d = fixture();
    const result = await runReply(d, args);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      transport: "smtp",
      id,
      messageId: "<sent@example.com>",
    });
    expect(d.imapSource).toHaveBeenCalledWith(id);
    expect(d.smtpSend).toHaveBeenCalledTimes(1);
    expect(d.smtpSend.mock.calls[0][0]).toMatchObject({
      to: ["reply@example.com"],
      subject: "Re: Project update",
      inReplyTo: "<parent@example.com>",
      references: ["<root@example.com>", "<earlier@example.com>", "<parent@example.com>"],
    });
    expect(d.smtpSend.mock.calls[0][0].body).toMatch(/^New first line\.\n\nNew second paragraph\./);
    expect(d.smtpSend.mock.calls[0][0].body).toContain("> Original ✓ body.");
    expectNoApple(d);
  });

  it("uses the decoded IMAP subject and excludes configured aliases from reply-all", async () => {
    const d = fixture();
    d.imapSource.mockResolvedValue({ raw, subject: "Résumé update", accountUser: cfg.user });
    await runReply(d, { ...args, replyAll: true });
    expect(d.smtpSend.mock.calls[0][0]).toMatchObject({
      subject: "Re: Résumé update",
      cc: ["teammate@example.com"],
    });
  });

  it("forwards an IMAP source without adding reply-thread headers", async () => {
    const d = fixture();
    const result = await runForward(d, {
      id,
      to: ["colleague@example.com"],
      body: "For review.",
      send: true,
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      transport: "smtp",
      recipients: ["colleague@example.com"],
    });
    const opts = d.smtpSend.mock.calls[0][0];
    expect(opts.subject).toBe("Fwd: Project update");
    expect(opts.body).toContain("Original ✓ body.");
    expect(opts.inReplyTo).toBeUndefined();
    expect(opts.references).toBeUndefined();
    expectNoApple(d);
  });

  it("reads numeric sources through Mail.app but still delivers over SMTP", async () => {
    const d = fixture();
    d.mail.getRawSource.mockReturnValue(raw);
    d.mail.getMessageContent.mockReturnValue({ plainText: "Numeric original." });
    const result = await runReply(d, { ...args, id: "42" });
    expect(result.structuredContent?.transport).toBe("smtp");
    expect(d.mail.getRawSource).toHaveBeenCalledWith("42");
    expect(d.imapSource).not.toHaveBeenCalled();
    expect(d.numericId).not.toHaveBeenCalled();
    expect(d.mail.replyToMessage).not.toHaveBeenCalled();
  });

  it.each(["reply", "forward"] as const)(
    "does not fall back after a %s source fetch error",
    async (kind) => {
      const d = fixture();
      d.imapSource.mockRejectedValue(new Error("IMAP connection reset"));
      const result =
        kind === "reply"
          ? await runReply(d, args)
          : await runForward(d, { id, to: ["colleague@example.com"], send: true });
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain("IMAP connection reset");
      expect(d.smtpSend).not.toHaveBeenCalled();
      expectNoApple(d);
    }
  );

  it("does not hide a missing SMTP password behind an AppleScript send", async () => {
    const d = fixture();
    d.smtpConfig.mockImplementation(() => {
      throw new Error("No SMTP password found");
    });
    expect(await runReply(d, args)).toMatchObject({ isError: true });
    expect(d.imapSource).not.toHaveBeenCalled();
    expect(d.smtpSend).not.toHaveBeenCalled();
    expectNoApple(d);
  });

  it("refuses a reply without Message-ID instead of sending an unthreaded message", async () => {
    const d = fixture();
    d.imapSource.mockResolvedValue({
      raw: raw.replace("Message-ID: <parent@example.com>\r\n", ""),
      accountUser: cfg.user,
    });
    const result = await runReply(d, args);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("Message-ID");
    expect(d.smtpSend).not.toHaveBeenCalled();
    expectNoApple(d);
  });

  it("refuses an original without a reply address", async () => {
    const d = fixture();
    d.imapSource.mockResolvedValue({
      raw: "Message-ID: <parent@example.com>\r\n\r\nBody",
      accountUser: cfg.user,
    });
    expect(await runReply(d, args)).toMatchObject({ isError: true });
    expect(d.smtpSend).not.toHaveBeenCalled();
    expectNoApple(d);
  });

  it("does not send another IMAP account's message from the SMTP default", async () => {
    const d = fixture();
    d.imapSource.mockResolvedValue({ raw, accountUser: "other@example.com" });
    expect(await runReply(d, args)).toMatchObject({ isError: true });
    expect(d.smtpSend).not.toHaveBeenCalled();
    expectNoApple(d);
  });

  it("accepts an explicitly configured identity alias", async () => {
    const d = fixture();
    d.imapSource.mockResolvedValue({ raw, accountUser: "ALIAS@example.com" });
    expect((await runReply(d, args)).structuredContent?.transport).toBe("smtp");
  });

  it.each(["returned", "thrown"])(
    "never tries a second transport after a %s SMTP error",
    async (mode) => {
      const d = fixture();
      if (mode === "returned")
        d.smtpSend.mockResolvedValue({ success: false, error: "SMTP rejected" });
      else d.smtpSend.mockRejectedValue(new Error("connection lost after DATA"));
      expect(await runReply(d, args)).toMatchObject({ isError: true });
      expect(d.smtpSend).toHaveBeenCalledTimes(1);
      expectNoApple(d);
    }
  );

  it("reports an unreadable numeric source without composing anything", async () => {
    const d = fixture();
    expect(await runReply(d, { ...args, id: "42" })).toMatchObject({ isError: true });
    expect(d.smtpSend).not.toHaveBeenCalled();
    expect(d.numericId).not.toHaveBeenCalled();
    expect(d.mail.replyToMessage).not.toHaveBeenCalled();
  });

  it.each(["reply", "forward"] as const)(
    "keeps %s drafts on AppleScript even with SMTP configured",
    async (kind) => {
      const d = fixture();
      const result =
        kind === "reply"
          ? await runReply(d, { ...args, send: false })
          : await runForward(d, { id, to: ["colleague@example.com"], send: false });
      expect(result.structuredContent).toMatchObject({ sent: false, transport: "applescript" });
      expect(d.numericId).toHaveBeenCalledWith(id);
      expect(d.smtpConfig).not.toHaveBeenCalled();
      expect(d.smtpSend).not.toHaveBeenCalled();
      expect(d.imapSource).not.toHaveBeenCalled();
      if (kind === "reply")
        expect(d.mail.replyToMessage).toHaveBeenCalledWith("84", args.body, false, false);
      else
        expect(d.mail.forwardMessage).toHaveBeenCalledWith(
          "84",
          ["colleague@example.com"],
          undefined,
          false
        );
    }
  );

  it("honors explicit AppleScript without resolving SMTP credentials", async () => {
    const d = fixture();
    expect(
      (await runReply(d, { ...args, transport: "applescript" })).structuredContent?.transport
    ).toBe("applescript");
    expect(d.smtpConfig).not.toHaveBeenCalled();
    expect(d.imapSource).not.toHaveBeenCalled();
  });

  it("keeps the unconfigured default on AppleScript", async () => {
    const d = fixture();
    d.smtpConfigured.mockReturnValue(false);
    expect((await runReply(d, args)).structuredContent?.transport).toBe("applescript");
    expect(d.smtpSend).not.toHaveBeenCalled();
  });

  it("honors explicit SMTP even when the automatic config check is false", async () => {
    const d = fixture();
    d.smtpConfigured.mockReturnValue(false);
    expect((await runReply(d, { ...args, transport: "smtp" })).structuredContent?.transport).toBe(
      "smtp"
    );
    expectNoApple(d);
  });

  it("rejects SMTP drafts before fetching or composing", async () => {
    const d = fixture();
    expect(await runReply(d, { ...args, transport: "smtp", send: false })).toMatchObject({
      isError: true,
    });
    expect(d.smtpSend).not.toHaveBeenCalled();
    expect(d.imapSource).not.toHaveBeenCalled();
    expectNoApple(d);
  });

  it("preserves the numeric resolver's error and does not compose", async () => {
    const d = fixture();
    d.numericId.mockResolvedValue({ error: "not synchronized" });
    const result = await runReply(d, { ...args, transport: "applescript" });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("not synchronized");
    expect(d.mail.replyToMessage).not.toHaveBeenCalled();
  });
});

describe("rendered SMTP reply MIME", () => {
  it("keeps new paragraphs unquoted and carries the full parent chain on the wire", async () => {
    const d = fixture();
    let mime = "";
    const createTransport = () => {
      const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
      const send = transport.sendMail.bind(transport);
      transport.sendMail = async (opts) => {
        const result = await send(opts);
        mime = result.message.toString();
        return result;
      };
      return transport;
    };
    d.smtpSend.mockImplementation((opts, config) =>
      sendViaSmtp(opts, config, createTransport as typeof nodemailer.createTransport)
    );
    const result = await runReply(d, args);
    expect(result.structuredContent?.ok).toBe(true);
    const headers = mime.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, " ");
    expect(headers).toContain("In-Reply-To: <parent@example.com>");
    expect(headers).toContain(
      "References: <root@example.com> <earlier@example.com> <parent@example.com>"
    );
    const text = extractTextBody(mime)?.replace(/\r\n/g, "\n");
    expect(text).toMatch(/^New first line\.\n\nNew second paragraph\./);
    expect(text).toContain("> Original ✓ body.");
    expect(mime).not.toMatch(/<blockquote|Apple-Mail-URLShareWrapperClass/i);
    expectNoApple(d);
  });
});
