import { describe, expect, it } from "vitest";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { patchSavedDraftMime, previewSavedDraftMime } from "@/services/savedDraftMime.js";
import { extractMimeAttachment } from "@/utils/mimeParse.js";

async function fixture(attachments = true, html = false) {
  const c = new MailComposer({
    from: "Author <author@example.test>",
    to: "before@example.test",
    cc: "copy@example.test",
    bcc: "hidden@example.test",
    subject: "Before",
    text: "Original text\nSignature",
    ...(html ? { html: '<p>Original HTML</p><img src="cid:logo@example.test">' } : {}),
    messageId: "<draft@example.test>",
    inReplyTo: "<parent@example.test>",
    references: ["<root@example.test>", "<parent@example.test>"],
    ...(attachments
      ? {
          attachments: [
            { filename: "same.txt", content: Buffer.from("file one") },
            { filename: "same.txt", content: Buffer.from("file two") },
            ...(html
              ? [
                  {
                    filename: "logo.png",
                    content: Buffer.from([0, 1, 2, 255]),
                    cid: "logo@example.test",
                  },
                ]
              : []),
          ],
        }
      : {}),
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  c.keepBcc = true;
  return c.build();
}

describe("byte-preserving stored draft MIME edits", () => {
  it("changes selected headers while retaining the encoded body, native signature, Bcc and threading", async () => {
    const raw = await fixture();
    const next = await patchSavedDraftMime(raw, {
      subject: "Prüfung geändert",
      cc: [],
      to: ['"Reader, New" <new@example.test>'],
    });
    const p = previewSavedDraftMime(next);
    expect(p).toMatchObject({
      subject: "Prüfung geändert",
      to: ["new@example.test"],
      cc: [],
      bcc: ["hidden@example.test"],
    });
    const split = (b: Buffer) => b.toString("latin1").split("\r\n\r\n").slice(1).join("\r\n\r\n");
    expect(split(next)).toBe(split(raw));
    for (const h of [
      "From: Author <author@example.test>",
      "Message-ID: <draft@example.test>",
      "In-Reply-To: <parent@example.test>",
      "References: <root@example.test> <parent@example.test>",
    ])
      expect(next.toString()).toContain(h);
  });
  it("changes a plain body while retaining the original attachment bytes and duplicate names", async () => {
    const raw = await fixture();
    const next = await patchSavedDraftMime(raw, { body: "Neu mit Umlauten: schön\nNeue Signatur" });
    expect(previewSavedDraftMime(next).body).toContain("Neu mit Umlauten: schön");
    expect(previewSavedDraftMime(next).attachments).toHaveLength(2);
    expect(extractMimeAttachment(next.toString(), "same.txt")?.content).toEqual(
      extractMimeAttachment(raw.toString(), "same.txt")?.content
    );
    for (const b64 of [
      Buffer.from("file one").toString("base64"),
      Buffer.from("file two").toString("base64"),
    ])
      expect(next.toString()).toContain(b64);
  });
  it("requires both existing MIME alternatives when changing the body", async () => {
    const raw = await fixture(true, true);
    await expect(patchSavedDraftMime(raw, { body: "Only plain changed" })).rejects.toThrow(
      /both body and htmlBody/
    );
    const next = await patchSavedDraftMime(raw, {
      body: "New plain",
      htmlBody: '<p>New HTML</p><img src="cid:logo@example.test">',
    });
    expect(previewSavedDraftMime(next)).toMatchObject({
      body: expect.stringContaining("New plain"),
      htmlBody: expect.stringContaining("New HTML"),
    });
    expect(next.toString()).toContain(Buffer.from([0, 1, 2, 255]).toString("base64"));
  });
  it("preserves HTML-only drafts during header edits and requires an explicit HTML body patch", async () => {
    const raw = await new MailComposer({
      from: "a@example.test",
      to: "b@example.test",
      html: "<p>Only HTML</p>",
    })
      .compile()
      .build();
    expect(previewSavedDraftMime(await patchSavedDraftMime(raw, { subject: "Hi" }))).toMatchObject({
      isHtml: true,
      body: expect.stringContaining("Only HTML"),
    });
    await expect(patchSavedDraftMime(raw, { body: "Wrong representation" })).rejects.toThrow(
      /missing MIME alternative/
    );
  });
  it("removes one exact part despite duplicate filenames and preserves the other", async () => {
    const raw = await fixture();
    const p = previewSavedDraftMime(raw);
    const next = await patchSavedDraftMime(raw, { removeAttachments: [p.attachments[1].partId] });
    expect(previewSavedDraftMime(next).attachments).toHaveLength(1);
    expect(next.toString()).toContain(Buffer.from("file one").toString("base64"));
    expect(next.toString()).not.toContain(Buffer.from("file two").toString("base64"));
  });
  it("cannot remove an embedded CID image or a nonexistent part", async () => {
    const raw = await fixture(true, true);
    const image = previewSavedDraftMime(raw).attachments.find((a) => a.name === "logo.png")!;
    expect(image.removable).toBe(false);
    await expect(patchSavedDraftMime(raw, { removeAttachments: [image.partId] })).rejects.toThrow(
      /cannot be removed safely/
    );
    await expect(patchSavedDraftMime(raw, { removeAttachments: ["99"] })).rejects.toThrow(
      /missing/
    );
  });
  it.each([false, true])(
    "adds a file without losing the existing MIME tree (already multipart=%s)",
    async (mixed) => {
      const raw = await fixture(mixed);
      const next = await patchSavedDraftMime(raw, {
        addAttachments: [
          { filename: "Prüfung.txt", contentBase64: Buffer.from("new file").toString("base64") },
        ],
      });
      expect(previewSavedDraftMime(next).body).toContain("Original text");
      expect(previewSavedDraftMime(next).bcc).toEqual(["hidden@example.test"]);
      expect(previewSavedDraftMime(next).attachments).toHaveLength(mixed ? 3 : 1);
      expect(next.toString()).toContain(Buffer.from("new file").toString("base64"));
    }
  );
  it.each([
    { subject: "Injected\r\nBcc: attacker@example.test" },
    { cc: ["reader@example.test\nSubject: injected"] },
    { to: ["two@example.test, other@example.test"] },
  ])("refuses ambiguous or injected headers: %j", async (changes) => {
    await expect(patchSavedDraftMime(await fixture(), changes)).rejects.toThrow(
      /line breaks|one valid mailbox/
    );
  });
  it("applies the existing outbound attachment path policy", async () => {
    await expect(
      patchSavedDraftMime(await fixture(), { addAttachments: ["/etc/passwd"] })
    ).rejects.toThrow();
  });
  it("refuses duplicate sender headers, malformed multipart and signed content", async () => {
    const raw = await fixture();
    expect(() =>
      previewSavedDraftMime(Buffer.concat([Buffer.from("From: other@example.test\r\n"), raw]))
    ).toThrow(/duplicate from/);
    expect(() =>
      previewSavedDraftMime(
        Buffer.from(
          'From: a@example.test\r\nContent-Type: multipart/mixed; boundary="broken"\r\n\r\n--broken\r\nIncomplete'
        )
      )
    ).toThrow(/Incomplete/);
    expect(() =>
      previewSavedDraftMime(
        Buffer.from(
          'From: a@example.test\r\nContent-Type: multipart/signed; boundary="x"\r\n\r\nbody'
        )
      )
    ).toThrow(/Signed/);
  });
});
