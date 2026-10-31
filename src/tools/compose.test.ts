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
      getRawSourceWithLocation: vi.fn(
        (): { raw: string; account: string; mailbox: string } | null => null
      ),
      getMessageContent: vi.fn(() => null),
      listAccountsChecked: vi.fn(() => ({
        failed: false,
        accounts: [{ name: "Personal", email: cfg.from, addresses: [cfg.from], enabled: true }],
      })),
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
  expect(d.mail.getRawSourceWithLocation).not.toHaveBeenCalled();
  expect(d.mail.listAccountsChecked).not.toHaveBeenCalled();
  expect(d.mail.getMessageContent).not.toHaveBeenCalled();
  expect(d.numericId).not.toHaveBeenCalled();
  expect(d.mail.replyToMessage).not.toHaveBeenCalled();
  expect(d.mail.forwardMessage).not.toHaveBeenCalled();
}

describe("reply and forward transport routing", () => {
  it("pins native numeric replies to the source mailbox and Message-ID", async () => {
    const d = fixture();
    d.mail.getRawSource.mockReturnValue(raw);
    d.numericId.mockResolvedValue({ numericId: "42" });
    const scope = { account: "Proton", mailbox: "Sent" };
    const result = await runReply(d, {
      ...args,
      id: "42",
      ...scope,
      send: false,
      composition: "native-editor",
    });
    expect(result.isError).not.toBe(true);
    expect(d.mail.getRawSource).toHaveBeenCalledWith("42", scope, { requireScopedLocation: true });
    expect(d.mail.getMessageContent).toHaveBeenCalledWith("42", false, scope, {
      requireScopedLocation: true,
    });
    expect(d.mail.replyToMessage).toHaveBeenCalledWith(
      "42",
      args.body,
      false,
      false,
      undefined,
      true,
      { ...scope, messageId: "parent@example.com" }
    );
    expect(d.smtpSend).not.toHaveBeenCalled();
  });

  it("pins an AppleScript forward even when no body is supplied", async () => {
    const d = fixture();
    d.mail.getRawSource.mockReturnValue(raw);
    d.numericId.mockResolvedValue({ numericId: "42" });
    const scope = { account: "Proton", mailbox: "Archive/Inbox" };
    const result = await runForward(d, { id: "42", ...scope, to: ["x@example.com"], send: false });
    expect(result.isError).not.toBe(true);
    expect(d.mail.getRawSource).toHaveBeenCalledWith("42", scope, { requireScopedLocation: true });
    expect(d.mail.forwardMessage).toHaveBeenCalledWith(
      "42",
      ["x@example.com"],
      undefined,
      false,
      undefined,
      false,
      { ...scope, messageId: "parent@example.com" }
    );
  });

  it.each([
    { body: "For review" },
    { attachments: [{ filename: "note.txt", contentBase64: "eA==" }] },
  ])(
    "refuses a scoped forward with added content when the original has no readable plaintext",
    async (added) => {
      const d = fixture();
      d.mail.getRawSource.mockReturnValue(
        raw.replace("text/plain; charset=utf-8", "text/html; charset=utf-8")
      );
      d.numericId.mockResolvedValue({ numericId: "42" });
      const result = await runForward(d, {
        id: "42",
        account: "Proton",
        mailbox: "Sent",
        to: ["x@example.com"],
        send: false,
        ...added,
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("Forward composition was stopped");
      expect(d.mail.forwardMessage).not.toHaveBeenCalled();
    }
  );

  it("never quotes a different message if the numeric id changes between scoped reads", async () => {
    const d = fixture();
    d.mail.getRawSource.mockReturnValue(raw);
    d.mail.getMessageContent.mockReturnValue({
      plainText: "Wrong message body",
      rfcMessageId: "other@example.com",
    });
    d.numericId.mockResolvedValue({ numericId: "42" });
    const result = await runReply(d, {
      ...args,
      id: "42",
      account: "Proton",
      mailbox: "Sent",
      send: false,
    });
    expect(result.isError).not.toBe(true);
    const body = d.mail.replyToMessage.mock.calls[0][1];
    expect(body).toContain("Original ✓ body.");
    expect(body).not.toContain("Wrong message body");
  });

  it.each([{ account: "Proton" }, { mailbox: "Sent" }, { account: " ", mailbox: "Sent" }])(
    "rejects incomplete source scope before any Mail access: %o",
    async (scope) => {
      const d = fixture();
      const result = await runReply(d, { ...args, id: "42", ...scope });
      expect(result.isError).toBe(true);
      expectNoApple(d);
      expect(d.smtpSend).not.toHaveBeenCalled();
    }
  );

  it("refuses an explicit scope for an IMAP id instead of targeting a different mailbox", async () => {
    const d = fixture();
    const result = await runReply(d, { ...args, account: "Proton", mailbox: "Sent" });
    expect(result.isError).toBe(true);
    expect(d.imapSource).not.toHaveBeenCalled();
    expectNoApple(d);
  });

  it("does not fall back to another mailbox on an explicit scope miss", async () => {
    const d = fixture();
    const scope = { account: "Proton", mailbox: "Sent" };
    const result = await runReply(d, { ...args, id: "42", ...scope, send: false });
    expect(result.isError).toBe(true);
    expect(d.mail.getRawSource).toHaveBeenCalledOnce();
    expect(d.mail.getRawSource).toHaveBeenCalledWith("42", scope, { requireScopedLocation: true });
    expect(d.mail.replyToMessage).not.toHaveBeenCalled();
    expect(d.smtpSend).not.toHaveBeenCalled();
  });

  it("refuses scoped composition if the source has no usable Message-ID", async () => {
    const d = fixture();
    d.mail.getRawSource.mockReturnValue(raw.replace("Message-ID: <parent@example.com>\r\n", ""));
    const result = await runReply(d, {
      ...args,
      id: "42",
      account: "Proton",
      mailbox: "Sent",
      send: false,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("no usable Message-ID");
    expect(d.mail.replyToMessage).not.toHaveBeenCalled();
  });

  it("refuses a scoped SMTP reply when its sender is not in the source account", async () => {
    const d = fixture();
    d.mail.getRawSource.mockReturnValue(raw);
    const mail = {
      ...d.mail,
      listAccountsChecked: () => ({
        failed: false,
        accounts: [
          {
            name: "Proton",
            email: "other@example.com",
            addresses: ["other@example.com"],
            enabled: true,
          },
        ],
      }),
    };
    const result = await runReply(
      { ...d, mail },
      { ...args, id: "42", account: "Proton", mailbox: "Sent" }
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("does not match");
    expect(d.smtpSend).not.toHaveBeenCalled();
  });

  it("permits a scoped SMTP reply when the From matches even if the login is not an email", async () => {
    const d = fixture();
    d.mail.getRawSource.mockReturnValue(raw);
    d.smtpConfig.mockReturnValue({ ...cfg, user: "apikey" });
    const mail = {
      ...d.mail,
      listAccountsChecked: () => ({
        failed: false,
        accounts: [{ name: "Proton", email: cfg.from, addresses: [cfg.from], enabled: true }],
      }),
    };
    const result = await runReply(
      { ...d, mail },
      { ...args, id: "42", account: "Proton", mailbox: "Sent" }
    );
    expect(result.isError).not.toBe(true);
    expect(d.smtpSend).toHaveBeenCalledOnce();
  });

  it("uses the native editor with authored prose only, even when SMTP is configured", async () => {
    const d = fixture();
    const result = await runReply(d, { ...args, composition: "native-editor" });
    expect(result.isError).not.toBe(true);
    expect(d.mail.replyToMessage).toHaveBeenCalledWith(
      "84",
      args.body,
      false,
      true,
      undefined,
      true
    );
    expect(d.smtpSend).not.toHaveBeenCalled();
  });

  it("preserves native forward history instead of building a second plain-text quote", async () => {
    const d = fixture();
    await runForward(d, {
      id,
      to: ["me@example.com"],
      body: "New prose",
      send: false,
      composition: "native-editor",
    });
    expect(d.mail.forwardMessage).toHaveBeenCalledWith(
      "84",
      ["me@example.com"],
      "New prose",
      false,
      undefined,
      true
    );
    expect(d.smtpSend).not.toHaveBeenCalled();
  });

  it("rejects conflicting native-editor and SMTP choices before reading or composing", async () => {
    const d = fixture();
    const result = await runReply(d, { ...args, composition: "native-editor", transport: "smtp" });
    expect(result.isError).toBe(true);
    expect(d.imapSource).not.toHaveBeenCalled();
    expect(d.smtpSend).not.toHaveBeenCalled();
    expectNoApple(d);
  });

  it("does not compose a native reply when the original source is unreadable", async () => {
    const d = fixture();
    d.imapSource.mockRejectedValue(new Error("Source unavailable"));
    const result = await runReply(d, { ...args, composition: "native-editor" });
    expect(result.isError).toBe(true);
    expect(d.mail.replyToMessage).not.toHaveBeenCalled();
    expect(d.smtpSend).not.toHaveBeenCalled();
  });

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

  it("passes through a successful Sent-copy result (issue #220)", async () => {
    const d = fixture();
    d.smtpSend.mockResolvedValue({
      success: true,
      messageId: "<sent@example.com>",
      sentCopy: true,
    });
    const result = await runReply(d, args);
    expect(result.structuredContent).toMatchObject({ sentCopy: true });
    expect(result.structuredContent?.sentCopyError).toBeUndefined();
  });

  it.each(["reply", "forward"] as const)(
    "reports partial SMTP %s submission without retrying or claiming every recipient succeeded",
    async (kind) => {
      const d = fixture();
      d.smtpSend.mockResolvedValue({
        success: true,
        messageId: "<partial@example.com>",
        partial: true,
        accepted: ["reply@example.com"],
        rejected: ["teammate@example.com"],
      });
      const result =
        kind === "reply"
          ? await runReply(d, { ...args, replyAll: true })
          : await runForward(d, {
              id,
              to: ["reply@example.com", "teammate@example.com"],
              body: "For review",
              send: true,
            });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: false,
        sent: true,
        partial: true,
        accepted: ["reply@example.com"],
        rejected: ["teammate@example.com"],
        messageId: "<partial@example.com>",
      });
      expect(result.content[0].text).toContain("Partial SMTP submission");
      expect(result.content[0].text).toContain("Do not resend to accepted recipients");
      expect(d.smtpSend).toHaveBeenCalledOnce();
      expectNoApple(d);
    }
  );

  it("preserves rejected recipients in a failed SMTP reply result", async () => {
    const d = fixture();
    d.smtpSend.mockResolvedValue({
      success: false,
      error: "SMTP refused all recipients",
      rejected: ["reply@example.com"],
    });
    const result = await runReply(d, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      sent: false,
      rejected: ["reply@example.com"],
    });
    expect(d.smtpSend).toHaveBeenCalledOnce();
    expectNoApple(d);
  });

  it.each(["reply", "forward"] as const)(
    "reports unknown SMTP %s submission without a sent claim, retry or AppleScript fallback",
    async (kind) => {
      const d = fixture();
      d.smtpSend.mockResolvedValue({
        success: false,
        deliveryUnknown: true,
        error: "Connection closed",
      });
      const result =
        kind === "reply"
          ? await runReply(d, args)
          : await runForward(d, { id, to: ["reply@example.com"], body: "For review", send: true });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: false, deliveryUnknown: true });
      expect(result.structuredContent?.sent).toBeUndefined();
      expect(result.content[0].text).toContain("Do not resend automatically");
      expect(d.smtpSend).toHaveBeenCalledOnce();
      expectNoApple(d);
    }
  );

  it("passes through a failed Sent-copy result without failing the reply (issue #220)", async () => {
    const d = fixture();
    d.smtpSend.mockResolvedValue({
      success: true,
      messageId: "<sent@example.com>",
      sentCopy: false,
      sentCopyError: "IMAP APPEND failed: NO",
    });
    const result = await runReply(d, args);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      sentCopy: false,
      sentCopyError: "IMAP APPEND failed: NO",
    });
  });

  it("passes through sentCopyAlreadyFiled when the server already filed the copy", async () => {
    const d = fixture();
    d.smtpSend.mockResolvedValue({
      success: true,
      messageId: "<sent@example.com>",
      sentCopy: true,
      sentCopyAlreadyFiled: true,
    });
    const result = await runReply(d, args);
    expect(result.structuredContent).toMatchObject({ sentCopy: true, sentCopyAlreadyFiled: true });
  });

  it("omits sentCopy fields entirely when no Sent-copy was attempted", async () => {
    const d = fixture();
    const result = await runReply(d, args);
    expect(result.structuredContent?.sentCopy).toBeUndefined();
    expect(result.structuredContent?.sentCopyError).toBeUndefined();
    expect(result.structuredContent?.sentCopyAlreadyFiled).toBeUndefined();
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
    d.mail.getRawSourceWithLocation.mockReturnValue({ raw, account: "Personal", mailbox: "INBOX" });
    const result = await runReply(d, { ...args, id: "42" });
    expect(result.structuredContent?.transport).toBe("smtp");
    expect(d.mail.getRawSourceWithLocation).toHaveBeenCalledWith("42");
    expect(d.mail.getMessageContent).not.toHaveBeenCalled();
    expect(d.imapSource).not.toHaveBeenCalled();
    expect(d.numericId).not.toHaveBeenCalled();
    expect(d.mail.replyToMessage).not.toHaveBeenCalled();
  });

  it("says why a numeric original could not be read (#270)", async () => {
    const d = fixture();
    const why =
      "Message 42 not found in the mailboxes scanned. Not scanned — too large for a cross-mailbox id scan (over 50000 messages; APPLE_MAIL_MAX_BYID_SCAN_MAILBOX): iCloud / Archive (793630).";
    const mail = { ...d.mail, consumeLastMessageLookupError: vi.fn(() => why) };
    const result = await runReply({ ...d, mail }, { ...args, id: "42" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(`Cannot read the original message source (${why})`);
    expect(d.smtpSend).not.toHaveBeenCalled();
  });

  it("refuses an HTML-only IMAP forward instead of silently omitting its body", async () => {
    const d = fixture();
    d.imapSource.mockResolvedValue({
      raw: raw.replace("text/plain", "text/html"),
      subject: "Project update",
      accountUser: cfg.user,
    });
    const result = await runForward(d, {
      id,
      to: ["colleague@example.com"],
      body: "For review.",
      send: true,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("no readable plain-text body");
    expect(d.smtpSend).not.toHaveBeenCalled();
    expectNoApple(d);
  });

  it("refuses a numeric forward when Mail.app cannot return its body", async () => {
    const d = fixture();
    d.mail.getRawSource.mockReturnValue(raw);
    const result = await runForward(d, {
      id: "42",
      to: ["colleague@example.com"],
      send: true,
    });
    expect(result.isError).toBe(true);
    expect(d.smtpSend).not.toHaveBeenCalled();
    expect(d.mail.forwardMessage).not.toHaveBeenCalled();
  });

  it("allows a genuinely empty plain-text forward", async () => {
    const d = fixture();
    d.imapSource.mockResolvedValue({
      raw: raw.replace("Original =E2=9C=93 body.", ""),
      subject: "Project update",
      accountUser: cfg.user,
    });
    const result = await runForward(d, {
      id,
      to: ["colleague@example.com"],
      send: true,
    });
    expect(result.isError).not.toBe(true);
    expect(d.smtpSend).toHaveBeenCalledTimes(1);
    expectNoApple(d);
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
      const result = await runReply(d, args);
      if (mode === "returned") expect(result.isError).toBe(true);
      else {
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent?.deliveryUnknown).toBe(true);
        expect(result.structuredContent?.sent).toBeUndefined();
      }
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

  it("quotes the original on an AppleScript reply draft (issue #249)", async () => {
    const d = fixture();
    const result = await runReply(d, { ...args, send: false });
    expect(result.structuredContent).toMatchObject({ sent: false, transport: "applescript" });
    expect(d.numericId).toHaveBeenCalledWith(id);
    expect(d.smtpConfig).not.toHaveBeenCalled();
    expect(d.smtpSend).not.toHaveBeenCalled();
    expect(d.imapSource).toHaveBeenCalledWith(id);
    const [, composedBody, replyAll, sent] = d.mail.replyToMessage.mock.calls[0];
    expect(composedBody).toMatch(/^New first line\.\n\nNew second paragraph\./);
    expect(composedBody).toContain("> Original ✓ body.");
    expect(replyAll).toBe(false);
    expect(sent).toBe(false);
  });

  it("does not fetch or quote a forward draft with no body to prepend", async () => {
    const d = fixture();
    const result = await runForward(d, { id, to: ["colleague@example.com"], send: false });
    expect(result.structuredContent).toMatchObject({ sent: false, transport: "applescript" });
    expect(d.numericId).toHaveBeenCalledWith(id);
    expect(d.smtpConfig).not.toHaveBeenCalled();
    expect(d.smtpSend).not.toHaveBeenCalled();
    expect(d.imapSource).not.toHaveBeenCalled();
    expect(d.mail.forwardMessage).toHaveBeenCalledWith(
      "84",
      ["colleague@example.com"],
      undefined,
      false,
      undefined
    );
  });

  it("quotes the original on an AppleScript forward draft with a prepended body", async () => {
    const d = fixture();
    const result = await runForward(d, {
      id,
      to: ["colleague@example.com"],
      body: "For review.",
      send: false,
    });
    expect(result.structuredContent).toMatchObject({ sent: false, transport: "applescript" });
    expect(d.imapSource).toHaveBeenCalledWith(id);
    const [, , composedBody] = d.mail.forwardMessage.mock.calls[0];
    expect(composedBody).toMatch(/^For review\.\n\n---------- Forwarded message ----------/);
    expect(composedBody).toContain("Original ✓ body.");
  });

  it.each([false, true])("refuses an AppleScript reply when IMAP fails (send=%s)", async (send) => {
    const d = fixture();
    d.imapSource.mockRejectedValue(new Error("IMAP connection reset"));
    const result = await runReply(d, { ...args, send, transport: "applescript" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("IMAP connection reset");
    expect(d.mail.replyToMessage).not.toHaveBeenCalled();
    expect(d.smtpSend).not.toHaveBeenCalled();
  });

  it("preserves native source lookup diagnostics without composing a reply", async () => {
    const d = fixture();
    const mail = { ...d.mail, consumeLastMessageLookupError: () => "bounded scan skipped Archive" };
    const result = await runReply({ ...d, mail }, { ...args, id: "42", send: false });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("bounded scan skipped Archive");
    expect(d.mail.replyToMessage).not.toHaveBeenCalled();
    expect(d.smtpSend).not.toHaveBeenCalled();
  });

  it("returns native source exceptions as tool errors", async () => {
    const d = fixture();
    d.mail.getRawSource.mockImplementation(() => {
      throw new Error("Mail lookup timed out");
    });
    const result = await runReply(d, { ...args, id: "42", send: false });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Mail lookup timed out");
    expect(d.mail.replyToMessage).not.toHaveBeenCalled();
  });

  it.each(["smtp", "applescript"] as const)(
    "recovers a numeric reply quote from MIME over %s",
    async (transport) => {
      const d = fixture();
      d.mail.getRawSource.mockReturnValue(raw);
      d.mail.getRawSourceWithLocation.mockReturnValue({
        raw,
        account: "Personal",
        mailbox: "INBOX",
      });
      const result = await runReply(d, { ...args, id: "42", transport });
      expect(result.isError).not.toBe(true);
      const body =
        transport === "smtp"
          ? d.smtpSend.mock.calls[0][0].body
          : d.mail.replyToMessage.mock.calls[0][1];
      expect(body).toContain("> Original ✓ body.");
    }
  );

  it.each(["smtp", "applescript"] as const)(
    "rejects unreadable reply text over %s for both ID types",
    async (transport) => {
      for (const sourceId of [id, "42"]) {
        const d = fixture();
        const html = raw.replace("text/plain", "text/html");
        d.imapSource.mockResolvedValue({ raw: html, accountUser: cfg.user });
        d.mail.getRawSource.mockReturnValue(html);
        d.mail.getRawSourceWithLocation.mockReturnValue({
          raw: html,
          account: "Personal",
          mailbox: "INBOX",
        });
        const result = await runReply(d, { ...args, id: sourceId, transport });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("no readable plain-text body");
        expect(d.smtpSend).not.toHaveBeenCalled();
        expect(d.mail.replyToMessage).not.toHaveBeenCalled();
      }
    }
  );

  it.each(["smtp", "applescript"] as const)(
    "allows a genuinely empty reply body over %s",
    async (transport) => {
      const d = fixture();
      d.imapSource.mockResolvedValue({
        raw: raw.replace("Original =E2=9C=93 body.", ""),
        accountUser: cfg.user,
      });
      expect((await runReply(d, { ...args, transport })).isError).not.toBe(true);
    }
  );

  it("honors explicit AppleScript without resolving SMTP credentials, quoting via IMAP", async () => {
    const d = fixture();
    expect(
      (await runReply(d, { ...args, transport: "applescript" })).structuredContent?.transport
    ).toBe("applescript");
    expect(d.smtpConfig).not.toHaveBeenCalled();
    expect(d.imapSource).toHaveBeenCalledWith(id);
    expect(d.mail.replyToMessage.mock.calls[0][1]).toContain("> Original ✓ body.");
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
  it.each(['"last,first"@example.com', '"a@b"@example.com', '"a\\\\b"@example.com'])(
    "preserves the supported quoted recipient %s in the delivery envelope",
    async (recipient) => {
      const d = fixture();
      d.imapSource.mockResolvedValue({
        raw: raw.replace("Reply-To: reply@example.com", `Reply-To: Person <${recipient}>`),
        accountUser: cfg.user,
      });
      let envelope: string[] | undefined;
      const createTransport = () => {
        const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
        const send = transport.sendMail.bind(transport);
        transport.sendMail = async (options) => {
          const info = await send(options);
          envelope = info.envelope.to;
          return info;
        };
        return transport;
      };
      d.smtpSend.mockImplementation((options, config) =>
        sendViaSmtp(
          options,
          config,
          createTransport as typeof nodemailer.createTransport,
          async () => ({})
        )
      );

      const result = await runReply(d, args);

      expect(result.structuredContent?.ok).toBe(true);
      expect(envelope).toEqual([recipient]);
      expectNoApple(d);
    }
  );

  it("does not reject an unsupported quoted mailbox used only as forward attribution", async () => {
    const d = fixture();
    d.imapSource.mockResolvedValue({
      raw: raw.replace("From: sender@example.com", 'From: Person <"a>b"@example.com>'),
      accountUser: cfg.user,
    });

    const result = await runForward(d, {
      id,
      to: ["recipient@example.com"],
      body: "For review",
      send: true,
    });

    expect(result.structuredContent?.ok).toBe(true);
    expect(d.smtpSend.mock.calls[0][0].to).toEqual(["recipient@example.com"]);
    expectNoApple(d);
  });

  it("does not reject an unsupported quoted Cc mailbox when reply-all is off", async () => {
    const d = fixture();
    d.imapSource.mockResolvedValue({
      raw: raw.replace(
        "Subject: Project update",
        'Cc: Person <"a>b"@example.com>\r\nSubject: Project update'
      ),
      accountUser: cfg.user,
    });

    const result = await runReply(d, { ...args, replyAll: false });

    expect(result.structuredContent?.ok).toBe(true);
    expect(d.smtpSend.mock.calls[0][0].to).toEqual(["reply@example.com"]);
    expect(d.smtpSend.mock.calls[0][0].cc).toBeUndefined();
    expectNoApple(d);
  });

  it.each([
    { header: "From", value: 'Alice <"a>b"@example.com>', replyAll: false },
    { header: "Reply-To", value: 'Alice <"a<b"@example.com>', replyAll: false },
    {
      header: "To",
      value: 'me@example.com, Alice <"a>b"@example.com>',
      replyAll: true,
    },
    { header: "Cc", value: 'Alice <"a<b"@example.com>', replyAll: true },
  ])(
    "refuses a $header reply recipient that the SMTP composer would rewrite",
    async ({ header, value, replyAll }) => {
      const originalHeaders = {
        From: "author@example.com",
        To: "me@example.com",
        Subject: "Recipient identity",
        "Message-ID": "<parent@example.com>",
        "Content-Type": "text/plain; charset=utf-8",
        [header]: value,
      };
      const original =
        Object.entries(originalHeaders)
          .map(([name, content]) => `${name}: ${content}`)
          .join("\r\n") + "\r\n\r\nOriginal body.";
      const d = fixture();
      d.imapSource.mockResolvedValue({ raw: original, accountUser: cfg.user });

      const result = await runReply(d, { ...args, replyAll });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("cannot preserve");
      expect(d.smtpSend).not.toHaveBeenCalled();
      expectNoApple(d);
    }
  );

  it.each([
    {
      header: "From",
      value: '"other@example.net, Sales team" <author@example.com>',
      replyAll: false,
      expectedTo: ["author@example.com"],
      expectedCc: undefined,
    },
    {
      header: "Reply-To",
      value: '"other@example.net, Sales team" <reply@example.com>',
      replyAll: false,
      expectedTo: ["reply@example.com"],
      expectedCc: undefined,
    },
    {
      header: "To",
      value: 'me@example.com, "other@example.net, Sales team" <teammate@example.com>',
      replyAll: true,
      expectedTo: ["author@example.com"],
      expectedCc: ["teammate@example.com"],
    },
    {
      header: "Cc",
      value: '"other@example.net, Sales team" <teammate@example.com>',
      replyAll: true,
      expectedTo: ["author@example.com"],
      expectedCc: ["teammate@example.com"],
    },
  ])(
    "keeps addresses in a quoted $header display name out of the delivery envelope",
    async ({ header, value, replyAll, expectedTo, expectedCc }) => {
      const originalHeaders = {
        From: "author@example.com",
        To: "me@example.com",
        Subject: "Recipient boundary",
        "Message-ID": "<parent@example.com>",
        "Content-Type": "text/plain; charset=utf-8",
        [header]: value,
      };
      const original =
        Object.entries(originalHeaders)
          .map(([name, content]) => `${name}: ${content}`)
          .join("\r\n") + "\r\n\r\nOriginal body.";
      const d = fixture();
      d.imapSource.mockResolvedValue({ raw: original, accountUser: cfg.user });
      let envelope: string[] = [];
      let mime = "";
      const createTransport = () => {
        const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
        const send = transport.sendMail.bind(transport);
        transport.sendMail = async (options) => {
          const info = await send(options);
          envelope = info.envelope.to;
          mime = info.message.toString();
          return info;
        };
        return transport;
      };
      d.smtpSend.mockImplementation((options, config) =>
        sendViaSmtp(
          options,
          config,
          createTransport as typeof nodemailer.createTransport,
          async () => ({})
        )
      );

      const result = await runReply(d, { ...args, replyAll });

      expect(result.structuredContent?.ok).toBe(true);
      expect(envelope).toEqual([...expectedTo, ...(expectedCc ?? [])]);
      const headers = mime.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, " ");
      expect(headers).toContain(`To: ${expectedTo.join(", ")}`);
      if (expectedCc) expect(headers).toContain(`Cc: ${expectedCc.join(", ")}`);
      expect(headers).not.toContain("other@example.net");
      expect(headers).toContain("In-Reply-To: <parent@example.com>");
      expect(extractTextBody(mime)).toContain("> Original body.");
      expectNoApple(d);
    }
  );

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
