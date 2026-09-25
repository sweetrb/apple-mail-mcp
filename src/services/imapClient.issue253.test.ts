/**
 * #253 (@j5pu) — mailbox names are matched modulo Unicode normalization.
 *
 * iCloud stored a Mac-created "Xxxxx México" decomposed (NFD: `e` + U+0301,
 * modified UTF-7 `Me&AwE-xico`). A typed name is precomposed (NFC: U+00E9,
 * `M&AOk-xico`). The resolver compared with `toLowerCase()` only, found
 * nothing, fell back to the caller's literal spelling, and the server answered
 * `NO [NONEXISTENT]` — surfaced to the caller as a bare "Command failed".
 */
import { describe, it, expect } from "vitest";
import {
  encodeImapId,
  imapBatchMove,
  imapCreateMailbox,
  imapListMessages,
  imapMoveMessageById,
  imapRenameMailbox,
  imapSearchMessages,
  imapUnreadCount,
  matchMailbox,
  type ImapClientLike,
  type ImapConfig,
} from "@/services/imapClient.js";
import { resolveAppleMailboxPath } from "@/services/appleMailManager.js";

const NFC = "Xxxxx M\u00e9xico"; // precomposed é (U+00E9)
const NFD = "Xxxxx Me\u0301xico"; // e + COMBINING ACUTE ACCENT (U+0301)

const cfg: ImapConfig = {
  host: "imap.mail.me.com",
  port: 993,
  secure: true,
  user: "j@example.org",
  pass: "secret",
  accountLabel: "iCloud",
};

type Box = { path: string; name: string; specialUse?: string };
type Rec = {
  locked: string[];
  statusPaths: string[];
  moved?: { uids: number[]; dest: string };
  created?: string;
  renamed?: { from: string; to: string };
};

function box(path: string): Box {
  return { path, name: path.split("/").at(-1)! };
}

/**
 * A server that, like iCloud, only knows the mailboxes it LISTs: SELECT/
 * EXAMINE/STATUS of any other spelling fails exactly the way imapflow reports
 * a tagged NO.
 */
function client(boxes: Box[], rec: Rec): ImapClientLike {
  const known = new Set(boxes.map((b) => b.path));
  const nonexistent = (): Error =>
    Object.assign(new Error("Command failed"), {
      responseStatus: "NO",
      serverResponseCode: "NONEXISTENT",
      responseText: "Mailbox does not exist",
    });
  return {
    connect: async () => undefined,
    getMailboxLock: async (path: string) => {
      rec.locked.push(path);
      if (!known.has(path)) throw nonexistent();
      return { release: () => undefined };
    },
    search: async () => [1],
    fetch: async function* () {
      yield { uid: 1, envelope: { subject: "hola" }, flags: new Set() } as never;
    },
    fetchOne: async () => false,
    list: async () => boxes,
    status: async (path: string) => {
      rec.statusPaths.push(path);
      if (!known.has(path)) throw nonexistent();
      return { path, messages: 1, unseen: 1, recent: 0 };
    },
    mailboxCreate: async (path: string) => {
      rec.created = path;
      return { path, created: true };
    },
    mailboxRename: async (path: string, newPath: string) => {
      rec.renamed = { from: path, to: newPath };
      return { path, newPath };
    },
    mailboxDelete: async (path: string) => ({ path }),
    messageFlagsAdd: async () => true,
    messageFlagsRemove: async () => true,
    messageMove: async (uids: number[], dest: string) => {
      rec.moved = { uids, dest };
      return { path: "INBOX", destination: dest, uidMap: new Map([[uids[0], 99]]) };
    },
    messageDelete: async () => true,
    noop: async () => undefined,
    logout: async () => undefined,
  } as unknown as ImapClientLike;
}

const fresh = (): Rec => ({ locked: [], statusPaths: [] });
const deps = (boxes: Box[], rec: Rec) => ({
  config: cfg,
  connect: async () => client(boxes, rec),
});

describe("#253 matchMailbox — NFC/NFD-insensitive, returns the server's stored path", () => {
  it("sanity: the two spellings really are different strings that NFC-fold equal", () => {
    expect(NFC).not.toBe(NFD);
    expect(NFC.toLowerCase()).not.toBe(NFD.toLowerCase());
    expect(NFC.normalize("NFC")).toBe(NFD.normalize("NFC"));
  });

  it("typed NFC finds a mailbox the server stores NFD — and yields the NFD path", () => {
    expect(matchMailbox([box("INBOX"), box(NFD)], NFC)).toEqual({ kind: "found", path: NFD });
  });

  it("typed NFD finds a mailbox the server stores NFC — and yields the NFC path", () => {
    expect(matchMailbox([box("INBOX"), box(NFC)], NFD)).toEqual({ kind: "found", path: NFC });
  });

  it("matches a nested mailbox by leaf and by full path in either form", () => {
    const nested = [box(`Archive/${NFD}`)];
    expect(matchMailbox(nested, NFC)).toEqual({ kind: "found", path: `Archive/${NFD}` });
    expect(matchMailbox(nested, `archive/${NFC}`)).toEqual({
      kind: "found",
      path: `Archive/${NFD}`,
    });
  });

  it("refuses when an NFC and an NFD mailbox both exist and the input is neither exactly", () => {
    const res = matchMailbox([box(NFC), box(NFD)], NFC.toUpperCase());
    expect(res.kind).toBe("ambiguous");
  });

  it("an exact byte-for-byte spelling still picks its own twin", () => {
    expect(matchMailbox([box(NFC), box(NFD)], NFD)).toEqual({ kind: "found", path: NFD });
    expect(matchMailbox([box(NFC), box(NFD)], NFC)).toEqual({ kind: "found", path: NFC });
  });
});

describe("#253 every mailbox-taking IMAP operation addresses the stored NFD path", () => {
  const BOXES = [box("INBOX"), box(NFD)];

  it("list-messages", async () => {
    const rec = fresh();
    const res = await imapListMessages({ mailbox: NFC, limit: 5 }, deps(BOXES, rec));
    expect(rec.locked).toEqual([NFD]);
    expect(res.messages).toHaveLength(1);
  });

  it("search-messages", async () => {
    const rec = fresh();
    const res = await imapSearchMessages(
      { mailbox: NFC, query: "hola", limit: 5 },
      deps(BOXES, rec)
    );
    expect(rec.locked).toEqual([NFD]);
    expect(res.messages).toHaveLength(1);
  });

  it("unread count", async () => {
    const rec = fresh();
    expect(await imapUnreadCount(NFC, deps(BOXES, rec))).toBe(1);
    expect(rec.statusPaths).toEqual([NFD]);
  });

  it("move-message and batch-move", async () => {
    const id = encodeImapId("iCloud", "INBOX", 7);
    const rec = fresh();
    const one = await imapMoveMessageById(id, NFC, deps(BOXES, rec));
    expect(one.success).toBe(true);
    expect(rec.moved?.dest).toBe(NFD);

    const rec2 = fresh();
    await imapBatchMove([id], NFC, deps(BOXES, rec2));
    expect(rec2.moved?.dest).toBe(NFD);
  });

  it("rename resolves the NFD source", async () => {
    const rec = fresh();
    const res = await imapRenameMailbox(NFC, "Mexico", deps(BOXES, rec));
    expect(res.success).toBe(true);
    expect(rec.renamed).toEqual({ from: NFD, to: "Mexico" });
  });

  it("create does not make a visually identical NFC twin of an existing NFD mailbox", async () => {
    const rec = fresh();
    const res = await imapCreateMailbox(NFC, deps(BOXES, rec));
    expect(res.success).toBe(true);
    expect(res.info).toContain("already existed");
    expect(rec.created).toBeUndefined();
  });

  it("rename refuses to create an NFC twin of an existing NFD mailbox", async () => {
    const rec = fresh();
    const res = await imapRenameMailbox("INBOX", NFC, deps(BOXES, rec));
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already exists/);
    expect(rec.renamed).toBeUndefined();
  });
});

describe("#253 ambiguity is refused, never guessed", () => {
  const TWINS = [box("INBOX"), box(NFC), box(NFD)];

  it("list-messages names both twins and says why a full path can't help", async () => {
    const rec = fresh();
    await expect(
      imapListMessages({ mailbox: NFC.toLowerCase(), limit: 5 }, deps(TWINS, rec))
    ).rejects.toThrow(/ambiguous[\s\S]*Unicode normalization/);
    expect(rec.locked).toEqual([]);
  });

  it("move refuses rather than moving to either twin", async () => {
    const rec = fresh();
    const id = encodeImapId("iCloud", "INBOX", 7);
    const res = await imapMoveMessageById(id, NFC.toLowerCase(), deps(TWINS, rec));
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/ambiguous/);
    expect(rec.moved).toBeUndefined();
  });
});

describe("#253 a tagged NO reaches the caller with the server's own text", () => {
  it("reports NO [NONEXISTENT] Mailbox does not exist, not a bare 'Command failed'", async () => {
    const rec = fresh();
    // LIST knows nothing matching, so the literal spelling is tried and refused.
    await expect(
      imapListMessages({ mailbox: "Nowhere", limit: 5 }, deps([box("INBOX")], rec))
    ).rejects.toThrow("Nowhere (NO [NONEXISTENT] Mailbox does not exist)");
  });
});

describe("#253 AppleScript-path resolver folds NFC/NFD the same way", () => {
  it("NFC input finds the NFD stored path, and the reverse", () => {
    expect(resolveAppleMailboxPath(NFC, ["INBOX", NFD])).toBe(NFD);
    expect(resolveAppleMailboxPath(NFD, ["INBOX", NFC])).toBe(NFC);
    expect(resolveAppleMailboxPath(NFC, ["INBOX", `Archive/${NFD}`])).toBe(`Archive/${NFD}`);
  });

  it("refuses twins that differ only in normalization", () => {
    expect(() => resolveAppleMailboxPath(NFC.toLowerCase(), [NFC, NFD])).toThrow(
      /ambiguous[\s\S]*Unicode normalization/
    );
  });
});
