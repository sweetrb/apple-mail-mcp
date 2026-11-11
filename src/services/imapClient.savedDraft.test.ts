import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import {
  encodeImapId,
  imapUpdateSavedDraft,
  type ImapClientLike,
  type ImapConfig,
} from "@/services/imapClient.js";
import type { UpdateSavedDraftInput } from "@/types.js";

const raw = Buffer.from(
  "From: Author <author@example.test>\r\nTo: reader@example.test\r\nBcc: hidden@example.test\r\nSubject: Before\r\nMessage-ID: <draft@example.test>\r\nIn-Reply-To: <parent@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOriginal body\r\n"
);
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const path = "[Provider]/Entwürfe";
const id = encodeImapId("Work", path, 7);
const cfg: ImapConfig = {
  accountLabel: "Work",
  host: "imap.example.test",
  user: "author@example.test",
  pass: "fixture",
  port: 993,
  secure: true,
};
const input = (overrides: Partial<UpdateSavedDraftInput> = {}): UpdateSavedDraftInput => ({
  draftId: id,
  dryRun: false,
  approvedSha256: hash(raw),
  approvedUidValidity: "12",
  changes: { subject: "After" },
  ...overrides,
});

function fixture() {
  const order: string[] = [];
  const messages = new Map<number, { bytes: Buffer; flags: Set<string> }>([
    [7, { bytes: raw, flags: new Set(["\\Draft", "\\Seen", "\\Flagged", "\\Recent"]) }],
  ]);
  const fetchOne = vi.fn(async (uid: string, query: Record<string, unknown>) => {
    const m = messages.get(Number(uid));
    if (!m) return false;
    return {
      uid: Number(uid),
      source: query.source ? m.bytes : undefined,
      size: m.bytes.length,
      flags: m.flags,
    };
  });
  const append = vi.fn(async (_path: string, bytes: string | Buffer, flags?: string[]) => {
    order.push("append");
    messages.set(9, { bytes: Buffer.from(bytes), flags: new Set(flags) });
    return { destination: path, uid: 9, uidValidity: 12n };
  });
  const remove = vi.fn(async (uids: number[]) => {
    order.push("delete");
    messages.delete(uids[0]);
    return true;
  });
  const release = vi.fn();
  const client = {
    list: vi.fn(async () => [{ path, name: "Entwürfe", specialUse: "\\Drafts" }]),
    mailbox: { path, uidValidity: 12n },
    capabilities: new Map([["UIDPLUS", true]]),
    getMailboxLock: vi.fn(async () => ({ release })),
    fetchOne,
    append,
    messageDelete: remove,
    logout: vi.fn(async () => {}),
    close: vi.fn(),
  } as unknown as ImapClientLike;
  return {
    client,
    messages,
    order,
    fetchOne,
    append,
    remove,
    release,
    deps: { config: cfg, connect: vi.fn(async () => client) },
  };
}

describe("stored-draft editing over IMAP (#372)", () => {
  it("previews read-only, with a revision compatible with #241 and no SMTP", async () => {
    const f = fixture();
    const smtp = vi.spyOn(nodemailer, "createTransport");
    try {
      const r = await imapUpdateSavedDraft({ draftId: id, dryRun: true }, f.deps);
      expect(r).toMatchObject({
        ok: true,
        status: "preview",
        preview: {
          draftId: id,
          uid: 7,
          uidValidity: "12",
          sha256: hash(raw),
          from: "author@example.test",
          bcc: ["hidden@example.test"],
        },
      });
      expect(f.client.getMailboxLock).toHaveBeenCalledWith(path, { readOnly: true });
      expect(f.append).not.toHaveBeenCalled();
      expect(f.remove).not.toHaveBeenCalled();
      expect(smtp).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledOnce();
    } finally {
      smtp.mockRestore();
    }
  });
  it("shows current and proposed versions without changing the mailbox", async () => {
    const f = fixture();
    const r = await imapUpdateSavedDraft(input({ dryRun: true }), f.deps);
    expect(r.preview?.subject).toBe("Before");
    expect(r.proposed?.subject).toBe("After");
    expect(f.append).not.toHaveBeenCalled();
  });
  it("confirms APPEND before targeted removal, returns the new UID, and preserves flags/Bcc", async () => {
    const f = fixture();
    const r = await imapUpdateSavedDraft(input(), f.deps);
    expect(r).toMatchObject({
      ok: true,
      status: "updated",
      sourceRemoved: true,
      sourceDraftId: id,
      draftId: encodeImapId("Work", path, 9),
      preview: { uid: 9, uidValidity: "12", subject: "After", bcc: ["hidden@example.test"] },
    });
    expect(r.preview?.sha256).toBe(hash(f.messages.get(9)!.bytes));
    expect(f.order).toEqual(["append", "delete"]);
    expect(f.remove).toHaveBeenCalledExactlyOnceWith([7], { uid: true });
    expect(f.append.mock.calls[0][2]).toEqual(["\\Draft", "\\Seen", "\\Flagged"]);
    expect(f.messages.has(7)).toBe(false);
  });
  it.each([{ approvedSha256: "0".repeat(64) }, { approvedUidValidity: "13" }])(
    "refuses stale revisions before APPEND: %j",
    async (extra) => {
      const f = fixture();
      await expect(imapUpdateSavedDraft(input(extra), f.deps)).rejects.toThrow(
        /changed since preview/
      );
      expect(f.append).not.toHaveBeenCalled();
      expect(f.remove).not.toHaveBeenCalled();
    }
  );
  it("requires approval and a nonempty patch before connecting", async () => {
    const f = fixture();
    await expect(
      imapUpdateSavedDraft(input({ approvedSha256: undefined }), f.deps)
    ).rejects.toThrow(/fresh preview/);
    await expect(imapUpdateSavedDraft(input({ changes: {} }), f.deps)).rejects.toThrow(
      /fresh preview/
    );
    expect(f.deps.connect).not.toHaveBeenCalled();
  });
  it("refuses numeric IDs and never falls back to AppleScript", async () => {
    const f = fixture();
    await expect(imapUpdateSavedDraft(input({ draftId: "7" }), f.deps)).rejects.toThrow(
      /no AppleScript fallback/
    );
    expect(f.deps.connect).not.toHaveBeenCalled();
  });
  it("refuses accounts without IMAP rather than guessing another account", async () => {
    vi.stubEnv("APPLE_MAIL_MCP_IMAP_USER", "");
    vi.stubEnv("APPLE_MAIL_MCP_IMAP_ACCOUNTS", "[]");
    try {
      await expect(imapUpdateSavedDraft({ draftId: id, dryRun: true })).rejects.toThrow(
        /IMAP|configured/
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("refuses a non-draft UID in Drafts", async () => {
    const f = fixture();
    f.messages.get(7)!.flags.delete("\\Draft");
    await expect(imapUpdateSavedDraft(input(), f.deps)).rejects.toThrow(/not an active draft/);
    expect(f.append).not.toHaveBeenCalled();
  });
  it("refuses ambiguous configured account selectors without resolving credentials", async () => {
    vi.stubEnv("APPLE_MAIL_MCP_IMAP_USER", "");
    vi.stubEnv(
      "APPLE_MAIL_MCP_IMAP_ACCOUNTS",
      JSON.stringify([
        { account: "Work", user: "first@example.test", password: "fixture" },
        { account: "Other", user: "Work", password: "fixture" },
      ])
    );
    try {
      const connect = vi.fn(async () => {
        throw new Error("Unexpected test connection");
      });
      await expect(
        imapUpdateSavedDraft({ draftId: id, dryRun: true }, { connect })
      ).rejects.toThrow(/account is absent or ambiguous/);
      expect(connect).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("refuses a read-only Drafts mailbox before APPEND", async () => {
    const f = fixture();
    Object.assign(f.client.mailbox!, { readOnly: true });
    await expect(imapUpdateSavedDraft(input(), f.deps)).rejects.toThrow(/read-only/);
    expect(f.append).not.toHaveBeenCalled();
  });
  it("refuses a draft-flagged message outside the special mailbox", async () => {
    const f = fixture();
    await expect(
      imapUpdateSavedDraft(input({ draftId: encodeImapId("Work", "INBOX", 7) }), f.deps)
    ).rejects.toThrow(/exact SPECIAL-USE/);
    expect(f.append).not.toHaveBeenCalled();
  });
  it("refuses ambiguous Drafts mappings before selecting either mailbox", async () => {
    const f = fixture();
    vi.mocked(f.client.list).mockResolvedValue([
      { path, name: "one", specialUse: "\\Drafts" },
      { path: "Other/Drafts", name: "two", specialUse: "\\Drafts" },
    ]);
    await expect(imapUpdateSavedDraft(input(), f.deps)).rejects.toThrow(/ambiguous/);
    expect(f.client.getMailboxLock).not.toHaveBeenCalled();
  });
  it("requires UIDPLUS rather than expunging unrelated deleted messages", async () => {
    const f = fixture();
    f.client.capabilities = new Map();
    await expect(imapUpdateSavedDraft(input(), f.deps)).rejects.toThrow(/UIDPLUS/);
    expect(f.append).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("leaves the source untouched when APPEND is rejected", async () => {
    const f = fixture();
    f.append.mockResolvedValue(false as never);
    const r = await imapUpdateSavedDraft(input(), f.deps);
    expect(r).toMatchObject({ ok: false, status: "append_failed", sourceRemoved: false });
    expect(f.messages.get(7)!.bytes).toEqual(raw);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.append).toHaveBeenCalledOnce();
  });
  it("reports an uncertain APPEND without retrying or deleting the source", async () => {
    const f = fixture();
    f.append.mockRejectedValue(new Error("socket closed after upload"));
    const r = await imapUpdateSavedDraft(input(), f.deps);
    expect(r).toMatchObject({ status: "append_unknown", sourceRemoved: false });
    expect(f.append).toHaveBeenCalledOnce();
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("distinguishes a tagged APPEND refusal from an uncertain upload", async () => {
    const f = fixture();
    f.append.mockRejectedValue(
      Object.assign(new Error("Quota exceeded"), { responseStatus: "NO" })
    );
    expect(await imapUpdateSavedDraft(input(), f.deps)).toMatchObject({
      status: "append_failed",
      sourceRemoved: false,
    });
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("does not claim the old copy survived when removal loses its acknowledgment", async () => {
    const f = fixture();
    f.remove.mockImplementation(async () => {
      f.messages.delete(7);
      throw new Error("Connection lost after removal");
    });
    const r = await imapUpdateSavedDraft(input(), f.deps);
    expect(r.status).toBe("cleanup_failed");
    expect(r.sourceRemoved).toBeUndefined();
    expect(r.draftId).toBe(encodeImapId("Work", path, 9));
    expect(f.remove).toHaveBeenCalledOnce();
  });
  it.each([
    { destination: path },
    { destination: path, uid: 9, uidValidity: 13n },
    { destination: path, uid: 7, uidValidity: 12n },
  ])("preserves the source without a trustworthy APPENDUID", async (response) => {
    const f = fixture();
    f.append.mockResolvedValue(response as never);
    const r = await imapUpdateSavedDraft(input(), f.deps);
    expect(r.status).toBe("append_unknown");
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("reports both IDs and the saved preview when old-copy removal fails", async () => {
    const f = fixture();
    f.remove.mockResolvedValue(false);
    const r = await imapUpdateSavedDraft(input(), f.deps);
    expect(r).toMatchObject({
      ok: false,
      status: "cleanup_failed",
      sourceRemoved: false,
      sourceDraftId: id,
      draftId: encodeImapId("Work", path, 9),
      preview: { subject: "After" },
    });
    expect(f.messages.size).toBe(2);
    expect(f.remove).toHaveBeenCalledOnce();
    expect(f.append).toHaveBeenCalledOnce();
  });
  it("refuses a concurrent replacement before creating anything", async () => {
    const f = fixture();
    const fetch = f.fetchOne.getMockImplementation()!;
    let calls = 0;
    f.fetchOne.mockImplementation(async (uid, q) => {
      if (++calls === 2) f.messages.delete(7);
      return fetch(uid, q);
    });
    await expect(imapUpdateSavedDraft(input(), f.deps)).rejects.toThrow(/missing or changed/);
    expect(f.append).not.toHaveBeenCalled();
  });
  it("does not delete a source that changed during APPEND", async () => {
    const f = fixture();
    const append = f.append.getMockImplementation()!;
    f.append.mockImplementation(async (...args) => {
      const r = await append(...args);
      f.messages.get(7)!.bytes = Buffer.from(raw.toString().replace("Original body", "User edit"));
      return r;
    });
    const r = await imapUpdateSavedDraft(input(), f.deps);
    expect(r.status).toBe("cleanup_failed");
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.messages.size).toBe(2);
  });
  it("refuses cleanup if the server did not store the submitted replacement bytes", async () => {
    const f = fixture();
    const append = f.append.getMockImplementation()!;
    f.append.mockImplementation(async (...args) => {
      const r = await append(...args);
      f.messages.get(9)!.bytes = raw;
      return r;
    });
    const r = await imapUpdateSavedDraft(input(), f.deps);
    expect(r.status).toBe("append_unknown");
    expect(r.draftId).toBe(encodeImapId("Work", path, 9));
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("does not APPEND an identical patch", async () => {
    const f = fixture();
    const r = await imapUpdateSavedDraft(input({ changes: { addAttachments: [] } }), f.deps);
    expect(r.status).toBe("unchanged");
    expect(f.append).not.toHaveBeenCalled();
  });
});
