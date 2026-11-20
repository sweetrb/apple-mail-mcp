import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  encodeImapId,
  imapTrashSavedDraft,
  imapGetMessageRfc822,
  type ImapClientLike,
  type ImapConfig,
} from "./imapClient.js";

const raw = Buffer.from(
  "From: sender@example.test\r\nTo: reader@example.test\r\nMessage-ID: <draft@example.test>\r\nContent-Type: text/plain\r\n\r\nSynthetic body"
);
const revision = { uidValidity: "12", sha256: createHash("sha256").update(raw).digest("hex") };
const path = "[Provider]/Drafts";
const id = encodeImapId("Work", path, 7);
const config: ImapConfig = {
  accountLabel: "Work",
  host: "unused.invalid",
  user: "sender@example.test",
  pass: "unused",
  port: 993,
  secure: true,
};

function fixture() {
  let present = true,
    locked = false;
  const order: string[] = [];
  const mailbox = { path, uidValidity: 12n, readOnly: false };
  const message = { uid: 7, source: raw, size: raw.length, flags: new Set(["\\Draft"]) };
  const release = vi.fn(() => {
    locked = false;
    order.push("release");
  });
  const fetchOne = vi.fn(async () => {
    expect(locked).toBe(true);
    order.push("read");
    return present ? message : false;
  });
  const move = vi.fn(async () => {
    expect(locked).toBe(true);
    order.push("move");
    present = false;
    return { path, destination: "Trash" };
  });
  const list = vi.fn(async () => [
    { path, name: "Drafts", specialUse: "\\Drafts" },
    { path: "Trash", name: "Trash", specialUse: "\\Trash" },
  ]);
  const client = {
    mailbox,
    capabilities: new Map([["MOVE", true]]),
    list,
    getMailboxLock: vi.fn(async () => {
      locked = true;
      order.push("lock");
      return { release };
    }),
    fetchOne,
    messageMove: move,
    messageDelete: vi.fn(),
    append: vi.fn(),
    logout: vi.fn(async () => {}),
    close: vi.fn(),
  } as unknown as ImapClientLike;
  return {
    client,
    mailbox,
    message,
    list,
    move,
    fetchOne,
    release,
    order,
    deps: { config, connect: vi.fn(async () => client) },
  };
}

describe("revision-bound saved-draft cleanup", () => {
  it("checks identity and MIME under its write lock and verifies source removal after one recoverable MOVE", async () => {
    const f = fixture();
    expect(await imapTrashSavedDraft(id, revision, f.deps)).toMatchObject({
      success: true,
      removed: true,
      verification: { verdict: "verified" },
    });
    expect(f.client.getMailboxLock).toHaveBeenCalledWith(path, { readOnly: false });
    expect(f.move).toHaveBeenCalledWith([7], "Trash", { uid: true });
    expect(f.order).toEqual(["lock", "read", "move", "read", "release"]);
    expect(f.client.messageDelete).not.toHaveBeenCalled();
    expect(f.client.append).not.toHaveBeenCalled();
  });

  it("refuses UIDVALIDITY rollover before reading a reused UID", async () => {
    const f = fixture();
    f.mailbox.uidValidity = 13n;
    expect(await imapTrashSavedDraft(id, revision, f.deps)).toMatchObject({
      success: false,
      removed: false,
      error: expect.stringContaining("revision changed"),
    });
    expect(f.fetchOne).not.toHaveBeenCalled();
    expect(f.move).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("rechecks UIDVALIDITY after the final MIME read", async () => {
    const f = fixture();
    f.fetchOne.mockImplementationOnce(async () => {
      f.mailbox.uidValidity = 13n;
      return f.message;
    });
    expect(await imapTrashSavedDraft(id, revision, f.deps)).toMatchObject({
      success: false,
      removed: false,
    });
    expect(f.move).not.toHaveBeenCalled();
  });

  it("does not remove a changed MIME revision even if its UID is unchanged", async () => {
    const f = fixture();
    f.message.source = Buffer.from("different draft");
    expect(await imapTrashSavedDraft(id, revision, f.deps)).toMatchObject({
      success: false,
      removed: false,
    });
    expect(f.move).not.toHaveBeenCalled();
  });

  it.each([{ flags: [] }, { flags: ["\\Draft", "\\Deleted"] }])(
    "preserves a no-longer-active draft: %j",
    async ({ flags }) => {
      const f = fixture();
      f.message.flags = new Set(flags);
      expect(await imapTrashSavedDraft(id, revision, f.deps)).toMatchObject({
        success: false,
        removed: false,
      });
      expect(f.move).not.toHaveBeenCalled();
    }
  );

  it.each(["Drafts", "Trash"])("refuses an ambiguous SPECIAL-USE %s mailbox", async (name) => {
    const f = fixture();
    f.list.mockResolvedValue([
      { path, name: "Drafts", specialUse: "\\Drafts" },
      { path: "Trash", name: "Trash", specialUse: "\\Trash" },
      { path: "Other", name, specialUse: "\\" + name },
    ]);
    expect(await imapTrashSavedDraft(id, revision, f.deps)).toMatchObject({
      success: false,
      removed: false,
    });
    expect(f.client.getMailboxLock).not.toHaveBeenCalled();
    expect(f.move).not.toHaveBeenCalled();
  });

  it("refuses a non-Drafts source rather than deleting from another mailbox", async () => {
    const f = fixture();
    expect(
      await imapTrashSavedDraft(encodeImapId("Work", "Inbox", 7), revision, f.deps)
    ).toMatchObject({ success: false, removed: false });
    expect(f.move).not.toHaveBeenCalled();
  });

  it("never falls back to COPY or EXPUNGE on servers without MOVE", async () => {
    const f = fixture();
    f.client.capabilities = new Map([["UIDPLUS", true]]);
    expect(await imapTrashSavedDraft(id, revision, f.deps)).toMatchObject({
      success: false,
      removed: false,
      error: expect.stringContaining("server-side MOVE"),
    });
    expect(f.move).not.toHaveBeenCalled();
    expect(f.client.messageDelete).not.toHaveBeenCalled();
  });

  it("does not mutate a mailbox that is read-only", async () => {
    const f = fixture();
    f.mailbox.readOnly = true;
    expect(await imapTrashSavedDraft(id, revision, f.deps)).toMatchObject({
      success: false,
      removed: false,
    });
    expect(f.move).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("tolerates small size drift while refusing a grossly incomplete source", async () => {
    const f = fixture();
    f.message.size += 10;
    expect(await imapTrashSavedDraft(id, revision, f.deps)).toMatchObject({ removed: true });
    const short = fixture();
    short.message.size += 10_000;
    expect(await imapTrashSavedDraft(id, revision, short.deps)).toMatchObject({
      success: false,
      removed: false,
    });
    expect(short.move).not.toHaveBeenCalled();
  });

  it("reports an acknowledged MOVE with a still-visible source as unverified", async () => {
    const f = fixture();
    f.move.mockResolvedValue({ path, destination: "Trash" });
    const result = await imapTrashSavedDraft(id, revision, f.deps);
    expect(result).toMatchObject({ success: true, verification: { verdict: "unverified" } });
    expect(result.removed).toBeUndefined();
    expect(f.move).toHaveBeenCalledTimes(1);
  });

  it("does not turn a post-MOVE readback failure into a confirmed removal", async () => {
    const f = fixture();
    f.fetchOne
      .mockResolvedValueOnce(f.message)
      .mockRejectedValueOnce(new Error("readback unavailable"));
    const result = await imapTrashSavedDraft(id, revision, f.deps);
    expect(result).toMatchObject({ success: true, verification: { verdict: "unverified" } });
    expect(result.removed).toBeUndefined();
    expect(f.move).toHaveBeenCalledOnce();
  });

  it("distinguishes a definite MOVE rejection from an unacknowledged MOVE", async () => {
    const rejected = fixture();
    rejected.move.mockResolvedValue(false as never);
    expect(await imapTrashSavedDraft(id, revision, rejected.deps)).toMatchObject({
      success: false,
      removed: false,
    });
    expect(rejected.order).toEqual(["lock", "read", "read", "release"]);
    const uncertain = fixture();
    uncertain.move.mockRejectedValue(new Error("MOVE timeout"));
    const result = await imapTrashSavedDraft(id, revision, uncertain.deps);
    expect(result).toMatchObject({ success: false, error: "MOVE timeout" });
    expect(result.removed).toBeUndefined();
    expect(uncertain.move).toHaveBeenCalledOnce();
  });

  // imapflow's MOVE command swallows transport errors and returns false, so a false
  // result after the command was written may still have moved the draft.
  it("treats a false MOVE with the source gone as unknown, not a definite rejection", async () => {
    const f = fixture();
    f.move.mockImplementation(async () => {
      f.order.push("move");
      f.fetchOne.mockResolvedValue(false as never);
      return false as never;
    });
    const result = await imapTrashSavedDraft(id, revision, f.deps);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("inspect") });
    expect(result.removed).toBeUndefined();
    expect(f.move).toHaveBeenCalledOnce();
    expect(f.client.messageDelete).not.toHaveBeenCalled();
  });

  it("treats a false MOVE whose readback fails as unknown", async () => {
    const f = fixture();
    f.move.mockResolvedValue(false as never);
    f.fetchOne
      .mockResolvedValueOnce(f.message)
      .mockRejectedValueOnce(new Error("connection closed"));
    const result = await imapTrashSavedDraft(id, revision, f.deps);
    expect(result.success).toBe(false);
    expect(result.removed).toBeUndefined();
    expect(f.move).toHaveBeenCalledOnce();
  });

  it("validates malformed revision tokens before connecting", async () => {
    const f = fixture();
    expect(await imapTrashSavedDraft(id, { ...revision, uidValidity: "0" }, f.deps)).toMatchObject({
      success: false,
      removed: false,
    });
    expect(f.deps.connect).not.toHaveBeenCalled();
  });
});

describe("saved-draft read acquisition", () => {
  it("uses read-only acquisition and returns actual account and envelope information", async () => {
    const f = fixture();
    const result = await imapGetMessageRfc822(id, { requireDraftMailbox: true }, f.deps);
    expect(result).toMatchObject({
      success: true,
      acquisition: { uid: 7, uidValidity: "12", sha256: revision.sha256, accountUser: config.user },
    });
    expect(f.client.getMailboxLock).toHaveBeenCalledWith(path, { readOnly: true });
    expect(f.move).not.toHaveBeenCalled();
  });

  it("refuses a stale UID or non-draft flags on the saved-draft read path", async () => {
    const wrong = fixture();
    wrong.message.uid = 8;
    expect(await imapGetMessageRfc822(id, { requireDraftMailbox: true }, wrong.deps)).toMatchObject(
      { success: false }
    );
    const nonDraft = fixture();
    nonDraft.message.flags.clear();
    expect(
      await imapGetMessageRfc822(id, { requireDraftMailbox: true }, nonDraft.deps)
    ).toMatchObject({ success: false });
  });

  it("does not guess between two Drafts mailboxes", async () => {
    const f = fixture();
    f.list.mockResolvedValue([
      { path, name: "Drafts", specialUse: "\\Drafts" },
      { path: "Other", name: "Other", specialUse: "\\Drafts" },
    ]);
    expect(await imapGetMessageRfc822(id, { requireDraftMailbox: true }, f.deps)).toMatchObject({
      success: false,
    });
    expect(f.client.getMailboxLock).not.toHaveBeenCalled();
  });

  it("refuses a UIDVALIDITY rollover during the stored MIME read", async () => {
    const f = fixture();
    f.fetchOne.mockImplementationOnce(async () => {
      f.mailbox.uidValidity = 13n;
      return f.message;
    });
    expect(await imapGetMessageRfc822(id, { requireDraftMailbox: true }, f.deps)).toMatchObject({
      success: false,
    });
    expect(f.move).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });
});
