import { describe, it, expect } from "vitest";
import { isImapId, routeMessage } from "@/services/messageRouter.js";
import { encodeImapId } from "@/services/imapClient.js";

describe("isImapId", () => {
  it("recognizes imap tokens and rejects numeric ids", () => {
    expect(isImapId(encodeImapId("iCloud", "INBOX", 5))).toBe(true);
    expect(isImapId("57820")).toBe(false);
    expect(isImapId("imap:garbage")).toBe(false);
  });
});

describe("routeMessage", () => {
  const imapId = encodeImapId("iCloud", "INBOX", 5);

  it("routes imap ids to the imap branch and maps info → success text", async () => {
    let appleCalled = false;
    const res = await routeMessage(imapId, {
      imap: async () => ({ success: true, info: "Did the IMAP thing" }),
      apple: () => {
        appleCalled = true;
        return { content: [{ type: "text", text: "apple" }] };
      },
      ok: "ok",
      fail: "fail",
    });
    expect(appleCalled).toBe(false);
    expect(res.content[0].text).toBe("Did the IMAP thing");
    expect("isError" in res).toBe(false);
  });

  it("maps an imap failure to an error response with the error text", async () => {
    const res = await routeMessage(imapId, {
      imap: async () => ({ success: false, error: "boom" }),
      apple: () => ({ content: [{ type: "text", text: "apple" }] }),
      ok: "ok",
      fail: "fail",
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(res.content[0].text).toBe("boom");
  });

  // #181: the verdict has to reach structuredContent, or a caller can only tell
  // "confirmed" from "nobody looked" by parsing prose.
  it("merges an IMAP verification verdict into structuredContent", async () => {
    const res = await routeMessage(imapId, {
      imap: async () => ({
        success: true,
        info: "moved",
        verification: { verdict: "unverified" as const, why: "no UIDPLUS" },
      }),
      apple: () => ({ content: [{ type: "text", text: "apple" }] }),
      ok: "ok",
      fail: "fail",
      structured: { ok: true, id: imapId, mailbox: "Archive" },
    });
    expect(res.structuredContent).toEqual({
      ok: true,
      id: imapId,
      mailbox: "Archive",
      verification: { verdict: "unverified", why: "no UIDPLUS" },
    });
  });

  it("leaves structuredContent alone when the op reports no verification", async () => {
    const res = await routeMessage(imapId, {
      imap: async () => ({ success: true, info: "flagged" }),
      apple: () => ({ content: [{ type: "text", text: "apple" }] }),
      ok: "ok",
      fail: "fail",
      structured: { ok: true, id: imapId },
    });
    expect(res.structuredContent).toEqual({ ok: true, id: imapId });
  });

  it("falls through to the AppleScript branch for numeric ids", async () => {
    let imapCalled = false;
    const res = await routeMessage("57820", {
      imap: async () => {
        imapCalled = true;
        return { success: true };
      },
      apple: () => ({ content: [{ type: "text", text: "apple result" }] }),
      ok: "ok",
      fail: "fail",
    });
    expect(imapCalled).toBe(false);
    expect(res.content[0].text).toBe("apple result");
  });
});
