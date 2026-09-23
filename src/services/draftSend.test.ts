import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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
  const submit = vi.fn().mockResolvedValue({ messageId: "<draft@example.com>" });
  const appendSent = vi.fn().mockResolvedValue({ attempted: true, success: true });
  const removeDraft = vi.fn().mockResolvedValue({ success: true, info: "moved to Trash" });
  const injected: SavedDraftDeps = {
    fetch: vi.fn().mockResolvedValue({ success: true, acquisition: value }),
    smtpConfig: () => config,
    submit,
    appendSent,
    removeDraft,
  };
  return { injected, submit, appendSent, removeDraft };
}

describe("send-saved-draft", () => {
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
    expect(d.removeDraft).toHaveBeenCalledWith(draftId);
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
    d.removeDraft.mockResolvedValue({ success: false, error: "IMAP unavailable" });
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
    await expect(
      sendSavedDraft(
        { draftId, dryRun: false, approvedSha256: sha256, approvedUidValidity: "100" },
        d.injected
      )
    ).rejects.toThrow("SMTP timeout");
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
