import { describe, expect, it, vi } from "vitest";
import { runForward, type ComposeDeps } from "@/tools/compose.js";
import { encodeImapId } from "@/services/imapClient.js";

const imapId = encodeImapId("Fixture", "INBOX", 42);
const raw = [
  "From: author@example.test",
  "To: me@example.test",
  "Subject: Original subject",
  "Message-ID: <original@example.test>",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Original =E2=9C=93 body.",
].join("\r\n");

function fixture() {
  return {
    mail: {
      getRawSource: vi.fn((): string | null => raw),
      getMessageContent: vi.fn((): { plainText: string; rfcMessageId?: string } | null => null),
      replyToMessage: vi.fn(() => ({ success: true })),
      forwardMessage: vi.fn(() => ({ success: true })),
    },
    imapSource: vi.fn(async () => ({ raw, accountUser: "me@example.test" })),
    numericId: vi.fn(async () => ({ numericId: "42" })),
    smtpConfigured: () => false,
    smtpConfig: vi.fn(),
    smtpSend: vi.fn(),
  } satisfies ComposeDeps;
}

const additions = [
  { label: "authored text", body: "For review" },
  { label: "attachments only", attachments: [{ filename: "note.txt", contentBase64: "eA==" }] },
];
const cases = ["42", imapId].flatMap((id) =>
  [false, true].flatMap((send) => additions.map((added) => ({ id, send, ...added })))
);

describe("forward content preservation", () => {
  it.each(cases)(
    "refuses missing source for $id, send=$send, $label before composing",
    async ({ label: _label, ...args }) => {
      const deps = fixture();
      deps.mail.getRawSource.mockReturnValue(null);
      deps.imapSource.mockRejectedValue(new Error("Fixture source unavailable"));
      const result = await runForward(deps, {
        ...args,
        to: ["recipient@example.test"],
        transport: "applescript",
      });
      expect(result.isError).toBe(true);
      expect(deps.mail.forwardMessage).not.toHaveBeenCalled();
      expect(deps.smtpSend).not.toHaveBeenCalled();
    }
  );

  it.each(cases)(
    "refuses HTML-only source for $id, send=$send, $label before replacing its content",
    async ({ label: _label, ...args }) => {
      const deps = fixture();
      const htmlOnly = raw.replace("text/plain", "text/html");
      deps.mail.getRawSource.mockReturnValue(htmlOnly);
      deps.imapSource.mockResolvedValue({ raw: htmlOnly, accountUser: "me@example.test" });
      const result = await runForward(deps, {
        ...args,
        to: ["recipient@example.test"],
        transport: "applescript",
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("Forward composition was stopped");
      expect(deps.mail.forwardMessage).not.toHaveBeenCalled();
      expect(deps.smtpSend).not.toHaveBeenCalled();
    }
  );

  it("recovers numeric original text from MIME when Mail's plaintext read is unavailable", async () => {
    const deps = fixture();
    const result = await runForward(deps, {
      id: "42",
      to: ["recipient@example.test"],
      body: "For review",
      send: false,
    });
    expect(result.isError).not.toBe(true);
    expect(deps.mail.forwardMessage).toHaveBeenCalledOnce();
    expect(deps.mail.forwardMessage.mock.calls[0][2]).toContain("Original ✓ body.");
    expect(deps.mail.forwardMessage.mock.calls[0][2]).toMatch(/^For review\n\n/);
  });

  it("does not let an empty Mail body hide a readable MIME body", async () => {
    const deps = fixture();
    deps.mail.getMessageContent.mockReturnValue({ plainText: "" });
    const result = await runForward(deps, {
      id: "42",
      to: ["recipient@example.test"],
      body: "For review",
      send: false,
    });
    expect(result.isError).not.toBe(true);
    expect(deps.mail.forwardMessage.mock.calls[0][2]).toContain("Original ✓ body.");
  });

  it.each([false, true])(
    "does not mistake an empty Mail body for a readable HTML-only original (scoped=%s)",
    async (scoped) => {
      const deps = fixture();
      deps.mail.getRawSource.mockReturnValue(raw.replace("text/plain", "text/html"));
      deps.mail.getMessageContent.mockReturnValue({
        plainText: "",
        rfcMessageId: "original@example.test",
      });
      const result = await runForward(deps, {
        id: "42",
        to: ["recipient@example.test"],
        body: "For review",
        send: false,
        ...(scoped ? { account: "Fixture", mailbox: "INBOX" } : {}),
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("Forward composition was stopped");
      expect(deps.mail.forwardMessage).not.toHaveBeenCalled();
    }
  );

  it("preserves a genuine empty plaintext original", async () => {
    const deps = fixture();
    deps.imapSource.mockResolvedValue({
      raw: raw.replace("Original =E2=9C=93 body.", ""),
      accountUser: "me@example.test",
    });
    const result = await runForward(deps, {
      id: imapId,
      to: ["recipient@example.test"],
      body: "For review",
      send: false,
    });
    expect(result.isError).not.toBe(true);
    expect(deps.mail.forwardMessage.mock.calls[0][2]).toContain("Subject: Original subject");
  });

  it("does not read or replace Mail's native forward when nothing is being added", async () => {
    const deps = fixture();
    deps.mail.getRawSource.mockReturnValue(null);
    const result = await runForward(deps, {
      id: "42",
      to: ["recipient@example.test"],
      send: false,
    });
    expect(result.isError).not.toBe(true);
    expect(deps.mail.getRawSource).not.toHaveBeenCalled();
    expect(deps.mail.forwardMessage.mock.calls[0][2]).toBeUndefined();
  });

  it("leaves HTML quotations to native-editor composition without rebuilding them", async () => {
    const deps = fixture();
    deps.imapSource.mockResolvedValue({
      raw: raw.replace("text/plain", "text/html"),
      accountUser: "me@example.test",
    });
    const result = await runForward(deps, {
      id: imapId,
      to: ["recipient@example.test"],
      body: "For review",
      composition: "native-editor",
      send: false,
    });
    expect(result.isError).not.toBe(true);
    expect(deps.mail.forwardMessage).toHaveBeenCalledWith(
      "42",
      ["recipient@example.test"],
      "For review",
      false,
      undefined,
      true
    );
  });
});
