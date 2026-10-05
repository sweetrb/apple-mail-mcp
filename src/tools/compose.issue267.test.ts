/**
 * #267 — attachments on reply-to-message / forward-message, end to end through
 * the real nodemailer composer (stream transport, no network).
 *
 * Each acceptance criterion from the issue maps to a test here:
 *   1. reply-all + attachment: identical To/Cc, right name/MIME/size, threading
 *      headers, quoted original, and the Sent copy carries the file too;
 *   2. a >76-char Message-ID stays a plain token in In-Reply-To / References;
 *   3. send:false hands the attachments + quote to Mail.app's draft path;
 *   4. forward with attachments, with and without a prepended body;
 *   5. an out-of-roots path fails with send-email's exact error;
 *   6. mixed path + inline base64 in one call.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReply, runForward, type ComposeDeps, type ReplyArgs } from "@/tools/compose.js";
import { encodeImapId } from "@/services/imapClient.js";
import { sendViaSmtp, type SmtpConfig, type SmtpSendOptions } from "@/services/smtpMailer.js";
import { extractMimeAttachment, extractTextBody, parseMimeAttachments } from "@/utils/mimeParse.js";

const cfg: SmtpConfig = {
  host: "smtp.example.test",
  port: 587,
  secure: false,
  user: "me@example.com",
  pass: "fixture",
  from: "me@example.com",
};
const id = encodeImapId("Personal", "INBOX", 42);

/** An Outlook/Exchange-shaped Message-ID, well past the 76-char fold width. */
const LONG_ID =
  "<SN6PR02MB4205ABCDEF0123456789ABCDEF0123456789ABCDEF@SN6PR02MB4205.namprd02.prod.outlook.com>";

function original(messageId = "<parent@example.com>") {
  return [
    "From: Sender <sender@example.com>",
    "To: me@example.com, teammate@example.com",
    "Cc: other@example.com",
    "Subject: Quarterly numbers",
    "Date: Mon, 5 Oct 2026 09:00:00 +0000",
    `Message-ID: ${messageId}`,
    "References: <root@example.com>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Could you send the PDF?",
  ].join("\r\n");
}

let dir: string;
let pdfPath: string;
const PDF_BYTES = Buffer.from("%PDF-1.4\n% fixture for #267\n%%EOF\n");
const INLINE_TEXT = "inline attachment body\n";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "amcp-267-"));
  pdfPath = join(dir, "report.pdf");
  writeFileSync(pdfPath, PDF_BYTES);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Deps whose smtpSend is the REAL sendViaSmtp over nodemailer's stream
 * transport, capturing both the wire bytes and the Sent-folder copy.
 */
function wired(raw = original()) {
  const captured = { wire: "", sentCopy: "" };
  const createTransport = () => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const send = transport.sendMail.bind(transport);
    transport.sendMail = async (opts) => {
      const result = await send(opts);
      captured.wire = result.message.toString();
      return result;
    };
    return transport;
  };
  const deps = {
    mail: {
      getRawSource: vi.fn(() => null),
      getMessageContent: vi.fn(() => null),
      replyToMessage: vi.fn(() => ({ success: true })),
      forwardMessage: vi.fn(() => ({ success: true })),
    },
    imapSource: vi.fn(async () => ({ raw, subject: "Quarterly numbers", accountUser: cfg.user })),
    numericId: vi.fn(async () => ({ numericId: "84" })),
    smtpConfigured: vi.fn(() => true),
    smtpConfig: vi.fn(() => cfg),
    smtpSend: vi.fn((opts: SmtpSendOptions, config: SmtpConfig) =>
      sendViaSmtp(
        opts,
        config,
        createTransport as typeof nodemailer.createTransport,
        async (_user, copy) => {
          captured.sentCopy = copy.toString();
          return { sentCopy: true };
        }
      )
    ),
  } satisfies ComposeDeps;
  return { deps, captured };
}

/** Unfolded header block of a raw message. */
function headerBlock(mime: string): string {
  return mime.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, " ");
}
function header(mime: string, name: string): string | undefined {
  const re = new RegExp(`^${name}:\\s*(.*)$`, "im");
  return re.exec(headerBlock(mime))?.[1];
}

const reply: ReplyArgs = { id, body: "PDF attached.", replyAll: true, send: true };

describe("reply-to-message with attachments over SMTP (#267)", () => {
  it("keeps To/Cc identical to the no-attachment reply-all", async () => {
    const plain = wired();
    await runReply(plain.deps, reply);
    const withFile = wired();
    await runReply(withFile.deps, { ...reply, attachments: [pdfPath] });

    const a = plain.deps.smtpSend.mock.calls[0][0];
    const b = withFile.deps.smtpSend.mock.calls[0][0];
    expect(b.to).toEqual(a.to);
    expect(b.cc).toEqual(a.cc);
    expect(b.cc).toEqual(["teammate@example.com", "other@example.com"]);
    expect(header(withFile.captured.wire, "To")).toBe(header(plain.captured.wire, "To"));
    expect(header(withFile.captured.wire, "Cc")).toBe(header(plain.captured.wire, "Cc"));
  });

  it("carries the attachment (name, MIME, size), threading and quote — on the wire and in the Sent copy", async () => {
    const { deps, captured } = wired();
    const result = await runReply(deps, { ...reply, attachments: [pdfPath] });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      transport: "smtp",
      attachmentCount: 1,
      sentCopy: true,
    });

    for (const mime of [captured.wire, captured.sentCopy]) {
      const att = extractMimeAttachment(mime, "report.pdf");
      expect(att).not.toBeNull();
      expect(att?.mimeType).toBe("application/pdf");
      expect(att?.data.equals(PDF_BYTES)).toBe(true);
      expect(header(mime, "In-Reply-To")).toBe("<parent@example.com>");
      expect(header(mime, "References")).toBe("<root@example.com> <parent@example.com>");
      const text = extractTextBody(mime)?.replace(/\r\n/g, "\n") ?? "";
      expect(text).toMatch(/^PDF attached\./);
      expect(text).toContain("> Could you send the PDF?");
    }
  });

  it("emits a >76-char Message-ID as a plain token, never RFC 2047-encoded", async () => {
    const { deps, captured } = wired(original(LONG_ID));
    expect(LONG_ID.length).toBeGreaterThan(76);
    await runReply(deps, { ...reply, attachments: [pdfPath] });

    for (const mime of [captured.wire, captured.sentCopy]) {
      const inReplyTo = header(mime, "In-Reply-To");
      const references = header(mime, "References");
      expect(inReplyTo).toBe(LONG_ID);
      expect(references).toBe(`<root@example.com> ${LONG_ID}`);
      expect(inReplyTo).not.toContain("=?");
      expect(references).not.toContain("=?");
      // Raw (still-folded) lines too: no encoded-word anywhere in either header.
      const rawLines = mime.split(/\r?\n\r?\n/)[0];
      expect(rawLines).not.toMatch(/^(In-Reply-To|References):[^\n]*=\?/im);
    }
  });

  it("accepts a path and an inline base64 item in one call", async () => {
    const { deps, captured } = wired();
    const result = await runReply(deps, {
      ...reply,
      attachments: [
        pdfPath,
        { filename: "notes.txt", contentBase64: Buffer.from(INLINE_TEXT).toString("base64") },
      ],
    });
    expect(result.structuredContent).toMatchObject({ attachmentCount: 2 });
    const names = parseMimeAttachments(captured.wire).map((a) => a.name);
    expect(names).toEqual(["report.pdf", "notes.txt"]);
    expect(extractMimeAttachment(captured.wire, "notes.txt")?.data.toString()).toBe(INLINE_TEXT);
  });

  it("rejects an out-of-roots path with send-email's own error, before fetching the original", async () => {
    const outside = "/etc/hosts";
    const sendEmail = await sendViaSmtp(
      { to: ["x@example.com"], subject: "s", body: "b", attachments: [outside] },
      cfg,
      (() => {
        throw new Error("transport must not be created");
      }) as unknown as typeof nodemailer.createTransport
    );
    expect(sendEmail.success).toBe(false);
    expect(sendEmail.error).toMatch(/outside the allowed read roots|protected location/);

    for (const transport of [undefined, "applescript"] as const) {
      const { deps } = wired();
      const result = await runReply(deps, { ...reply, transport, attachments: [outside] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(sendEmail.error as string);
      expect(deps.imapSource).not.toHaveBeenCalled();
      expect(deps.smtpSend).not.toHaveBeenCalled();
      expect(deps.mail.replyToMessage).not.toHaveBeenCalled();
    }
    const { deps } = wired();
    const fwd = await runForward(deps, {
      id,
      to: ["x@example.com"],
      send: true,
      attachments: [outside],
    });
    expect(fwd.content[0].text).toContain(sendEmail.error as string);
    expect(deps.smtpSend).not.toHaveBeenCalled();
  });

  it("rejects an inline item without a filename the same way send-email does", async () => {
    const { deps } = wired();
    const result = await runReply(deps, {
      ...reply,
      attachments: [{ filename: "", contentBase64: "aGk=" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "Inline attachment requires both filename and contentBase64."
    );
    expect(deps.smtpSend).not.toHaveBeenCalled();
  });
});

describe("forward-message with attachments over SMTP (#267)", () => {
  it.each([
    ["with", "See the attached revision."],
    ["without", undefined],
  ])("forwards %s a prepended body", async (_label, body) => {
    const { deps, captured } = wired();
    const result = await runForward(deps, {
      id,
      to: ["colleague@example.com"],
      body,
      send: true,
      attachments: [pdfPath],
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      transport: "smtp",
      attachmentCount: 1,
      recipients: ["colleague@example.com"],
    });
    expect(header(captured.wire, "Subject")).toBe("Fwd: Quarterly numbers");
    expect(header(captured.wire, "In-Reply-To")).toBeUndefined();
    expect(extractMimeAttachment(captured.wire, "report.pdf")?.data.equals(PDF_BYTES)).toBe(true);
    expect(extractMimeAttachment(captured.sentCopy, "report.pdf")).not.toBeNull();
    const text = extractTextBody(captured.wire)?.replace(/\r\n/g, "\n") ?? "";
    expect(text).toContain("---------- Forwarded message ----------");
    expect(text).toContain("Could you send the PDF?");
    if (body) expect(text.startsWith(body)).toBe(true);
    else expect(text.startsWith("---------- Forwarded message")).toBe(true);
  });
});

describe("attachments on the AppleScript transport (#267)", () => {
  it("hands attachments and the quoted original to Mail.app's reply draft (send:false)", async () => {
    const { deps } = wired();
    const attachments = [
      pdfPath,
      { filename: "notes.txt", contentBase64: Buffer.from(INLINE_TEXT).toString("base64") },
    ];
    const result = await runReply(deps, { ...reply, send: false, attachments });
    expect(result.structuredContent).toMatchObject({
      sent: false,
      transport: "applescript",
      attachmentCount: 2,
    });
    expect(deps.smtpSend).not.toHaveBeenCalled();
    const [numericId, body, replyAll, send, passed] = deps.mail.replyToMessage.mock.calls[0];
    expect(numericId).toBe("84");
    expect(body).toMatch(/^PDF attached\./);
    expect(body).toContain("> Could you send the PDF?");
    expect(replyAll).toBe(true);
    expect(send).toBe(false);
    expect(passed).toEqual(attachments);
  });

  it("builds the forward block even without a body, so Mail has a paragraph to anchor files to", async () => {
    const { deps } = wired();
    await runForward(deps, {
      id,
      to: ["colleague@example.com"],
      send: false,
      attachments: [pdfPath],
    });
    const [, , body, send, passed] = deps.mail.forwardMessage.mock.calls[0];
    expect(body).toMatch(/^---------- Forwarded message ----------/);
    expect(body).toContain("Could you send the PDF?");
    expect(send).toBe(false);
    expect(passed).toEqual([pdfPath]);
  });

  it("leaves Mail's own forward content alone when there is neither body nor attachment", async () => {
    const { deps } = wired();
    await runForward(deps, { id, to: ["colleague@example.com"], send: false });
    expect(deps.imapSource).not.toHaveBeenCalled();
    expect(deps.mail.forwardMessage).toHaveBeenCalledWith(
      "84",
      ["colleague@example.com"],
      undefined,
      false,
      undefined
    );
  });
});
