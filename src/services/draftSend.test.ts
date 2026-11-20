import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { patchSavedDraftMime, previewSavedDraftMime } from "./savedDraftMime.js";
import type { ImapRfc822Acquisition } from "./imapClient.js";
import type { SmtpConfig } from "./smtpMailer.js";
import { sendSavedDraft, type SavedDraftDeps } from "./draftSend.js";

const draftId = "imap:example";
const raw = Buffer.from(
  [
    "From: Example Sender <sender@example.com>",
    "To: Ada <ada@example.com>",
    "Cc: Review <review@example.com>",
    "Bcc: Secret <secret@example.com>",
    "Reply-To: Replies <replies@example.com>",
    "Subject: Current draft",
    "Message-ID: <draft@example.com>",
    "X-Unsent: 1",
    "X-Uniform-Type-Identifier: com.apple.mail-draft",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Edited in Mail.",
  ].join("\r\n")
);
const sha256 = createHash("sha256").update(raw).digest("hex");
const acquisition: ImapRfc822Acquisition = {
  account: "Work",
  accountUser: "sender@example.com",
  envelopeRecipients: {
    to: ["ada@example.com"],
    cc: ["review@example.com"],
    bcc: ["secret@example.com"],
  },
  mailbox: "Drafts",
  uid: 42,
  uidValidity: "100",
  flags: ["\\Draft"],
  bytes: raw,
  sha256,
  readMethod: "EXAMINE; UID FETCH BODY.PEEK[]",
  warnings: [],
};
const config: SmtpConfig = {
  host: "smtp.example.com",
  port: 587,
  secure: false,
  user: "sender@example.com",
  pass: "not-used",
  from: "sender@example.com",
};

function deps(value: ImapRfc822Acquisition = acquisition) {
  const submit = vi.fn().mockResolvedValue({
    success: true,
    messageId: "<draft@example.com>",
    accepted: ["ada@example.com", "review@example.com", "secret@example.com"],
    rejected: [],
  });
  const appendSent = vi.fn().mockResolvedValue({ attempted: true, success: true });
  const removeDraft = vi.fn().mockResolvedValue({
    success: true,
    removed: true,
    verification: { verdict: "verified", how: "Source absent after MOVE" },
  });
  const injected: SavedDraftDeps = {
    fetch: vi.fn().mockResolvedValue({ success: true, acquisition: value }),
    smtpConfig: () => config,
    submit,
    appendSent,
    removeDraft,
    attempts: new Map(),
  };
  return { injected, submit, appendSent, removeDraft };
}

describe("send-saved-draft", () => {
  const approved = { draftId, dryRun: false, approvedSha256: sha256, approvedUidValidity: "100" };

  it("reports partial SMTP acceptance through the real raw-submit adapter and retains the draft", async () => {
    const d = deps();
    d.injected.submit = undefined;
    const sendMail = vi.fn().mockResolvedValue({
      messageId: "<draft@example.com>",
      accepted: ["ada@example.com", "review@example.com"],
      rejected: ["secret@example.com"],
    });
    const factory = vi
      .spyOn(nodemailer, "createTransport")
      .mockReturnValue({ sendMail, close: vi.fn() } as never);
    try {
      expect(await sendSavedDraft(approved, d.injected)).toMatchObject({
        status: "partial",
        partial: true,
        accepted: ["ada@example.com", "review@example.com"],
        rejected: ["secret@example.com"],
        draftRemoved: false,
        draftCleanupStatus: "not_attempted",
      });
      expect(d.removeDraft).not.toHaveBeenCalled();
      expect(await sendSavedDraft(approved, d.injected)).toMatchObject({
        status: "partial",
        alreadyAttempted: true,
      });
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(factory).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: true }));
    } finally {
      factory.mockRestore();
    }
  });

  it("does not claim verified removal when cleanup readback is unverified", async () => {
    const d = deps();
    d.removeDraft.mockResolvedValue({
      success: true,
      verification: { verdict: "unverified", why: "No source readback" },
    });
    expect(await sendSavedDraft(approved, d.injected)).toMatchObject({
      status: "submitted",
      draftRemoved: undefined,
      draftCleanupStatus: "unverified",
      draftRemovalVerification: { verdict: "unverified", why: "No source readback" },
    });
    expect(await sendSavedDraft(approved, d.injected)).toMatchObject({
      status: "submitted",
      alreadyAttempted: true,
    });
    expect(d.submit).toHaveBeenCalledTimes(1);
    expect(d.removeDraft).toHaveBeenCalledTimes(1);
  });

  it.each([
    { success: true, messageId: "<draft@example.com>" },
    { success: true, accepted: ["ada@example.com"], rejected: [] },
    { success: false, deliveryUnknown: true, error: "Lost DATA acknowledgment" },
  ])(
    "retains the draft without filing Sent when full acceptance is unknown: %j",
    async (outcome) => {
      const d = deps();
      d.submit.mockResolvedValue(outcome);
      expect(await sendSavedDraft(approved, d.injected)).toMatchObject({
        status: "submission_unknown",
        deliveryUnknown: true,
        draftRemoved: false,
      });
      expect(await sendSavedDraft(approved, d.injected)).toMatchObject({ alreadyAttempted: true });
      expect(d.submit).toHaveBeenCalledTimes(1);
      expect(d.appendSent).not.toHaveBeenCalled();
      expect(d.removeDraft).not.toHaveBeenCalled();
    }
  );

  it("prevents simultaneous submissions of the same approved revision", async () => {
    const d = deps();
    let finish!: (value: unknown) => void;
    d.submit.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const first = sendSavedDraft(approved, d.injected);
    await vi.waitFor(() => expect(d.submit).toHaveBeenCalledOnce());
    await expect(sendSavedDraft(approved, d.injected)).rejects.toThrow("already in progress");
    finish({
      success: true,
      accepted: ["ada@example.com", "review@example.com", "secret@example.com"],
      rejected: [],
    });
    await first;
    expect(d.submit).toHaveBeenCalledTimes(1);
  });

  it("keeps SMTP acknowledgment after a transport-close exception", async () => {
    const d = deps();
    d.injected.submit = undefined;
    const factory = vi.spyOn(nodemailer, "createTransport").mockReturnValue({
      sendMail: vi.fn().mockResolvedValue({
        messageId: "<draft@example.com>",
        accepted: ["ada@example.com", "review@example.com", "secret@example.com"],
        rejected: [],
      }),
      close: () => {
        throw new Error("close failed");
      },
    } as never);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await sendSavedDraft(approved, d.injected)).toMatchObject({
        status: "submitted",
        draftRemoved: true,
      });
    } finally {
      factory.mockRestore();
      log.mockRestore();
    }
  });

  it("reports Sent-copy failure separately and never resends to repair it", async () => {
    const d = deps();
    d.appendSent.mockRejectedValue(new Error("Sent unavailable"));
    expect(await sendSavedDraft(approved, d.injected)).toMatchObject({
      status: "submitted",
      sentCopy: false,
      sentCopyError: "Sent unavailable",
      draftRemoved: true,
    });
    await sendSavedDraft(approved, d.injected);
    expect(d.submit).toHaveBeenCalledTimes(1);
  });

  it("preserves Gmail Sent deduplication and passes the chosen SMTP host", async () => {
    const d = deps();
    d.appendSent.mockResolvedValue({ attempted: true, success: true, alreadyFiled: true });
    expect(await sendSavedDraft(approved, d.injected)).toMatchObject({
      sentCopy: true,
      sentCopyAlreadyFiled: true,
    });
    expect(d.appendSent).toHaveBeenCalledWith(config.user, expect.any(Buffer), config.host);
  });

  it("reports an uncertain cleanup without claiming the draft remained or retrying", async () => {
    const d = deps();
    d.removeDraft.mockRejectedValue(new Error("MOVE acknowledgment lost"));
    expect(await sendSavedDraft(approved, d.injected)).toMatchObject({
      status: "submitted",
      draftRemoved: undefined,
      draftCleanupStatus: "unknown",
      draftRemovalError: "MOVE acknowledgment lost",
    });
    await sendSavedDraft(approved, d.injected);
    expect(d.submit).toHaveBeenCalledTimes(1);
  });

  it.each([{ flags: [] }, { flags: ["\\Draft", "\\Deleted"] }])(
    "refuses non-active draft flags %j",
    async ({ flags }) => {
      const d = deps({ ...acquisition, flags });
      await expect(sendSavedDraft(approved, d.injected)).rejects.toThrow("active draft");
      expect(d.submit).not.toHaveBeenCalled();
    }
  );

  it("tolerates the maintainer's Gmail size drift and refuses a grossly short fetch", async () => {
    expect(
      await sendSavedDraft(
        { draftId, dryRun: true },
        deps({ ...acquisition, size: raw.length + 10 }).injected
      )
    ).toMatchObject({ status: "preview" });
    const d = deps({ ...acquisition, size: raw.length + 10_000 });
    await expect(sendSavedDraft(approved, d.injected)).rejects.toThrow("incomplete");
    expect(d.submit).not.toHaveBeenCalled();
  });

  it("resolves the current From identity before choosing credentials and refuses fallback", async () => {
    const d = deps();
    const resolve = vi.fn(() => config);
    d.injected.smtpConfig = resolve;
    await sendSavedDraft(approved, d.injected);
    expect(resolve).toHaveBeenCalledWith("sender@example.com");
    const mismatched = deps();
    mismatched.injected.smtpConfig = () => ({
      ...config,
      user: "other@example.com",
      from: "other@example.com",
      allowedFrom: [],
    });
    await expect(sendSavedDraft(approved, mismatched.injected)).rejects.toThrow(
      "not a configured sender"
    );
    expect(mismatched.submit).not.toHaveBeenCalled();
  });

  it("submits the new revision after body/recipient/attachment edits, preserving HTML and threading bytes", async () => {
    const composer = new MailComposer({
      from: "sender@example.com",
      to: "ada@example.com",
      bcc: "secret@example.com",
      subject: "Before",
      text: "Before",
      html: "<p>Before — native signature</p>",
      inReplyTo: "<parent@example.com>",
      references: ["<root@example.com>", "<parent@example.com>"],
      messageId: "<edited@example.com>",
      attachments: [
        { filename: "remove.txt", content: "old" },
        { filename: "keep.txt", content: "keep" },
      ],
    }).compile();
    composer.keepBcc = true;
    const original = await composer.build();
    const removal = previewSavedDraftMime(original).attachments.find(
      (a) => a.name === "remove.txt"
    )!.partId;
    const edited = await patchSavedDraftMime(original, {
      subject: "After",
      body: "Grüße after",
      htmlBody: "<p>Grüße after — native signature</p>",
      to: ["new@example.com"],
      cc: [],
      bcc: ["hidden@example.com"],
      removeAttachments: [removal],
      addAttachments: [
        { filename: "added.txt", contentBase64: Buffer.from("added").toString("base64") },
      ],
    });
    const hash = createHash("sha256").update(edited).digest("hex");
    const d = deps({
      ...acquisition,
      uid: 43,
      bytes: edited,
      sha256: hash,
      envelopeRecipients: { to: ["new@example.com"], cc: [], bcc: ["hidden@example.com"] },
    });
    d.submit.mockResolvedValue({
      success: true,
      accepted: ["new@example.com", "hidden@example.com"],
      rejected: [],
    });
    await expect(sendSavedDraft(approved, d.injected)).rejects.toThrow("Draft changed");
    const preview = await sendSavedDraft({ draftId, dryRun: true }, d.injected);
    expect(preview).toMatchObject({
      uid: 43,
      sha256: hash,
      body: "Grüße after",
      htmlBody: "<p>Grüße after — native signature</p>",
      attachments: expect.arrayContaining([
        expect.objectContaining({ name: "keep.txt" }),
        expect.objectContaining({ name: "added.txt" }),
      ]),
    });
    await sendSavedDraft({ ...approved, approvedSha256: hash }, d.injected);
    const wire = d.submit.mock.calls[0][0] as Buffer;
    expect(wire.subarray(wire.indexOf("\r\n\r\n") + 4)).toEqual(
      edited.subarray(edited.indexOf("\r\n\r\n") + 4)
    );
    expect(wire.toString()).toContain("In-Reply-To: <parent@example.com>");
    expect(wire.toString()).not.toMatch(/^Bcc:/m);
    expect(d.removeDraft).toHaveBeenCalledWith(draftId, { uidValidity: "100", sha256: hash });
  });
  it("shows the current stored content in Codex without submitting or removing it", async () => {
    const d = deps();
    const preview = await sendSavedDraft({ draftId, dryRun: true }, d.injected);
    expect(preview).toMatchObject({
      status: "preview",
      sha256,
      uidValidity: "100",
      from: "sender@example.com",
      to: ["ada@example.com"],
      cc: ["review@example.com"],
      bcc: ["secret@example.com"],
      replyTo: ["replies@example.com"],
      subject: "Current draft",
      body: "Edited in Mail.",
    });
    expect(d.submit).not.toHaveBeenCalled();
    expect(d.removeDraft).not.toHaveBeenCalled();
  });

  it("sends only the approved bytes, strips Bcc from wire MIME, and removes the draft after submission", async () => {
    const d = deps();
    const result = await sendSavedDraft(
      { draftId, dryRun: false, approvedSha256: sha256, approvedUidValidity: "100" },
      d.injected
    );
    expect(result).toMatchObject({
      status: "submitted",
      messageId: "<draft@example.com>",
      sentCopy: true,
      draftRemoved: true,
    });
    const [wire, envelope] = d.submit.mock.calls[0];
    expect(wire.toString()).toContain("Edited in Mail.");
    expect(wire.toString()).not.toMatch(/^(Bcc|X-Unsent|X-Uniform-Type-Identifier):/m);
    expect(envelope).toEqual({
      from: "sender@example.com",
      to: ["ada@example.com", "review@example.com", "secret@example.com"],
    });
    expect(d.appendSent.mock.calls[0][1].toString()).toContain("Bcc: Secret");
    expect(d.removeDraft).toHaveBeenCalledWith(draftId, { sha256, uidValidity: "100" });
  });

  it("reports the stored Message-ID, not nodemailer's generated raw-send id", async () => {
    const d = deps();
    d.submit.mockResolvedValueOnce({
      success: true,
      messageId: "<generated-by-nodemailer@example.com>",
      accepted: ["ada@example.com", "review@example.com", "secret@example.com"],
      rejected: [],
    });
    const result = await sendSavedDraft(
      { draftId, dryRun: false, approvedSha256: sha256, approvedUidValidity: "100" },
      d.injected
    );
    expect(result).toMatchObject({ status: "submitted", messageId: "<draft@example.com>" });
  });

  it("refuses changes, missing approval, and a mismatched SMTP identity before submission", async () => {
    const d = deps();
    await expect(sendSavedDraft({ draftId, dryRun: false }, d.injected)).rejects.toThrow(
      "fresh preview"
    );
    await expect(
      sendSavedDraft(
        { draftId, dryRun: false, approvedSha256: "a".repeat(64), approvedUidValidity: "100" },
        d.injected
      )
    ).rejects.toThrow("Draft changed");
    await expect(
      sendSavedDraft(
        { draftId, dryRun: false, approvedSha256: sha256, approvedUidValidity: "101" },
        d.injected
      )
    ).rejects.toThrow("Draft changed");
    d.injected.smtpConfig = () => ({ ...config, user: "different@example.com" });
    await expect(
      sendSavedDraft(
        { draftId, dryRun: false, approvedSha256: sha256, approvedUidValidity: "100" },
        d.injected
      )
    ).rejects.toThrow("does not match");
    expect(d.submit).not.toHaveBeenCalled();
  });

  it("reports post-send cleanup failure without retrying the submission", async () => {
    const d = deps();
    d.removeDraft.mockResolvedValue({ success: false, removed: false, error: "IMAP unavailable" });
    const result = await sendSavedDraft(
      { draftId, dryRun: false, approvedSha256: sha256, approvedUidValidity: "100" },
      d.injected
    );
    expect(result).toMatchObject({
      status: "submitted",
      draftRemoved: false,
      draftRemovalError: "IMAP unavailable",
    });
    expect(d.submit).toHaveBeenCalledTimes(1);
  });

  it("leaves the draft untouched when SMTP submission is uncertain", async () => {
    const d = deps();
    d.submit.mockRejectedValue(new Error("SMTP timeout"));
    const result = await sendSavedDraft(
      { draftId, dryRun: false, approvedSha256: sha256, approvedUidValidity: "100" },
      d.injected
    );
    expect(result).toMatchObject({
      status: "submission_unknown",
      deliveryUnknown: true,
      draftRemoved: false,
      error: expect.stringContaining("SMTP timeout"),
    });
    expect(d.submit).toHaveBeenCalledTimes(1);
    expect(d.appendSent).not.toHaveBeenCalled();
    expect(d.removeDraft).not.toHaveBeenCalled();
  });

  it("refuses a hidden recipient that the MIME preview cannot show", async () => {
    const d = deps({
      ...acquisition,
      envelopeRecipients: {
        to: ["ada@example.com"],
        cc: ["review@example.com"],
        bcc: ["secret@example.com", "hidden@example.com"],
      },
    });
    await expect(sendSavedDraft({ draftId, dryRun: true }, d.injected)).rejects.toThrow(
      "IMAP envelope"
    );
    expect(d.submit).not.toHaveBeenCalled();
  });

  it("refuses a draft when the IMAP recipient envelope is unavailable", async () => {
    const d = deps({ ...acquisition, envelopeRecipients: undefined });
    await expect(sendSavedDraft({ draftId, dryRun: true }, d.injected)).rejects.toThrow(
      "did not report draft envelope recipients"
    );
  });
});
