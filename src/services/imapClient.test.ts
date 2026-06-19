import { describe, it, expect, afterEach } from "vitest";
import {
  IMAP_ENV,
  isImapAccount,
  resolveImapConfig,
  resolveMailboxPath,
  imapSearchMessages,
  imapListMessages,
  imapCreateMailbox,
  imapDeleteMailbox,
  imapRenameMailbox,
  encodeImapId,
  decodeImapId,
  imapGetMessage,
  imapMarkRead,
  imapMarkUnread,
  imapFlagMessage,
  imapUnflagMessage,
  imapMoveMessageById,
  imapDeleteMessageById,
  imapUnreadCount,
  imapListMailboxes,
  imapMailStats,
  imapListAttachments,
  imapFetchAttachment,
  listImapAccountLabels,
  __setPoolConnect,
  __resetPool,
  type ImapClientLike,
  type ImapConfig,
} from "@/services/imapClient.js";

const cfg: ImapConfig = {
  host: "imap.gmail.com",
  port: 993,
  secure: true,
  user: "rob@example.com",
  pass: "secret",
  accountLabel: "rob@example.com",
};

interface Rec {
  path?: string;
  criteria?: Record<string, unknown>;
  range?: string;
}

function makeClient(uids: number[], rec: Rec): ImapClientLike {
  return {
    connect: async () => undefined,
    getMailboxLock: async (path: string) => {
      rec.path = path;
      return { release: () => undefined };
    },
    search: async (q: Record<string, unknown>) => {
      rec.criteria = q;
      return uids;
    },
    fetch: async function* (range: string) {
      rec.range = range;
      for (const u of range.split(",").map(Number)) {
        yield {
          uid: u,
          envelope: {
            subject: `Subject ${u}`,
            date: new Date("2026-06-01T00:00:00Z"),
            from: [{ name: `Person ${u}`, address: `p${u}@example.com` }],
          },
          flags: new Set<string>(u % 2 === 0 ? ["\\Seen"] : []),
        };
      }
    },
    fetchOne: async () => false,
    list: async () => [],
    status: async (path: string) => ({ path, messages: 0, unseen: 0, recent: 0 }),
    download: async () => ({
      meta: { filename: "file.bin" },
      content: (async function* () {
        yield Buffer.from("attachment-bytes");
      })(),
    }),
    mailboxCreate: async (path: string) => ({ path, created: true }),
    mailboxRename: async (path: string, newPath: string) => ({ path, newPath }),
    mailboxDelete: async (path: string) => ({ path }),
    messageFlagsAdd: async () => true,
    messageFlagsRemove: async () => true,
    messageMove: async () => ({}),
    messageDelete: async () => true,
    noop: async () => undefined,
    logout: async () => undefined,
  };
}

describe("isImapAccount", () => {
  it("is false when IMAP is not configured", () => {
    expect(isImapAccount("rob@example.com", {})).toBe(false);
  });
  it("is false when the call has no explicit account", () => {
    expect(isImapAccount(undefined, { [IMAP_ENV.user]: "rob@example.com" })).toBe(false);
  });
  it("matches the configured user or account label", () => {
    const env = { [IMAP_ENV.user]: "rob@example.com", [IMAP_ENV.account]: "Work" };
    expect(isImapAccount("Work", env)).toBe(true);
    expect(isImapAccount("rob@example.com", env)).toBe(true);
    expect(isImapAccount("other@example.com", env)).toBe(false);
  });
});

describe("resolveImapConfig", () => {
  it("throws when user is missing", () => {
    expect(() => resolveImapConfig({})).toThrow(/IMAP not configured/);
  });
  it("applies defaults and reads password from env", () => {
    const c = resolveImapConfig({
      [IMAP_ENV.user]: "rob@example.com",
      [IMAP_ENV.password]: "pw",
    });
    expect(c.host).toBe("imap.gmail.com");
    expect(c.port).toBe(993);
    expect(c.secure).toBe(true);
    expect(c.pass).toBe("pw");
  });
  it("throws an actionable error when no password is available", () => {
    expect(() => resolveImapConfig({ [IMAP_ENV.user]: "rob@example.com" })).toThrow(
      /No IMAP password/
    );
  });
});

describe("multi-account IMAP (C2)", () => {
  const multiEnv: NodeJS.ProcessEnv = {
    [IMAP_ENV.user]: "primary@gmail.com",
    [IMAP_ENV.password]: "pw1",
    [IMAP_ENV.account]: "Personal",
    [IMAP_ENV.accounts]: JSON.stringify([
      { account: "Work", user: "me@work.com", host: "imap.work.com", password: "pw2" },
    ]),
  };

  it("lists all configured account labels (legacy + JSON array)", () => {
    expect(listImapAccountLabels(multiEnv)).toEqual(["Personal", "Work"]);
  });

  it("isImapAccount matches any configured account by label or user", () => {
    expect(isImapAccount("Personal", multiEnv)).toBe(true);
    expect(isImapAccount("me@work.com", multiEnv)).toBe(true);
    expect(isImapAccount("Work", multiEnv)).toBe(true);
    expect(isImapAccount("nobody@x.com", multiEnv)).toBe(false);
  });

  it("resolveImapConfig selects by account and defaults to the first", () => {
    expect(resolveImapConfig(multiEnv).accountLabel).toBe("Personal");
    const work = resolveImapConfig(multiEnv, "Work");
    expect(work.host).toBe("imap.work.com");
    expect(work.user).toBe("me@work.com");
    expect(work.pass).toBe("pw2");
  });

  it("throws for an unknown account and lists the configured ones", () => {
    expect(() => resolveImapConfig(multiEnv, "Ghost")).toThrow(/Personal, Work/);
  });

  it("ignores malformed ACCOUNTS json and keeps the legacy account", () => {
    const env: NodeJS.ProcessEnv = {
      [IMAP_ENV.user]: "a@b.com",
      [IMAP_ENV.password]: "p",
      [IMAP_ENV.accounts]: "{not json",
    };
    expect(listImapAccountLabels(env)).toEqual(["a@b.com"]);
  });
});

describe("resolveMailboxPath", () => {
  it("defaults to All Mail for search, INBOX for list", () => {
    expect(resolveMailboxPath(undefined, "search")).toBe("[Gmail]/All Mail");
    expect(resolveMailboxPath(undefined, "list")).toBe("INBOX");
  });
  it("maps common Gmail folder names", () => {
    expect(resolveMailboxPath("All Mail", "search")).toBe("[Gmail]/All Mail");
    expect(resolveMailboxPath("Sent Mail", "list")).toBe("[Gmail]/Sent Mail");
    expect(resolveMailboxPath("INBOX", "list")).toBe("INBOX");
    expect(resolveMailboxPath("MyCustomLabel", "list")).toBe("MyCustomLabel");
  });
});

describe("imapSearchMessages", () => {
  it("server-side searches, formats UID rows, newest-first, with limit", async () => {
    const rec: Rec = {};
    const out = await imapSearchMessages(
      { query: "the", limit: 2 },
      { config: cfg, connect: async () => makeClient([1, 2, 3, 4, 5], rec) }
    );
    expect(rec.path).toBe("[Gmail]/All Mail");
    expect(rec.criteria).toEqual({ or: [{ subject: "the" }, { from: "the" }] });
    expect(rec.range).toBe("5,4"); // newest two, newest first
    expect(out).toContain("via IMAP");
    // Rows now carry composite imap: ids; decode them back to UIDs.
    const uids = [...out.matchAll(/imap:[A-Za-z0-9_-]+/g)].map((m) => decodeImapId(m[0])?.uid);
    expect(uids).toEqual([5, 4]); // newest two, newest first
    expect(uids).not.toContain(3);
    // The emitted ids encode the mailbox path so mutations can route back.
    const first = decodeImapId([...out.matchAll(/imap:[A-Za-z0-9_-]+/g)][0][0]);
    expect(first?.path).toBe("[Gmail]/All Mail");
    expect(out).toContain("5 total matched");
    expect(out).toMatch(/work with get-message/);
  });

  it("returns a clear empty message when nothing matches", async () => {
    const out = await imapSearchMessages(
      { query: "zzz" },
      { config: cfg, connect: async () => makeClient([], {}) }
    );
    expect(out).toMatch(/No messages found via IMAP/);
  });
});

describe("imapListMessages", () => {
  it("defaults to INBOX and maps unreadOnly to an unseen search", async () => {
    const rec: Rec = {};
    const out = await imapListMessages(
      { unreadOnly: true, limit: 10 },
      { config: cfg, connect: async () => makeClient([7, 8], rec) }
    );
    expect(rec.path).toBe("INBOX");
    expect(rec.criteria).toEqual({ unseen: true });
    const uids = [...out.matchAll(/imap:[A-Za-z0-9_-]+/g)].map((m) => decodeImapId(m[0])?.uid);
    expect(uids).toEqual([8, 7]); // newest-first
    expect(out).toContain("2 total listed");
  });
});

// --- Phase 2: folder operations -------------------------------------------

interface FolderRec {
  created?: string;
  deleted?: string;
  renamed?: [string, string];
}

function makeFolderClient(
  existing: { path: string; name: string }[],
  rec: FolderRec
): ImapClientLike {
  const base = makeClient([], {});
  return {
    ...base,
    list: async () => existing,
    mailboxCreate: async (path: string) => {
      rec.created = path;
      return { path, created: true };
    },
    mailboxRename: async (path: string, newPath: string) => {
      rec.renamed = [path, newPath];
      return { path, newPath };
    },
    mailboxDelete: async (path: string) => {
      rec.deleted = path;
      return { path };
    },
  };
}

describe("imapCreateMailbox", () => {
  it("creates a mailbox server-side", async () => {
    const rec: FolderRec = {};
    const r = await imapCreateMailbox("Projects", {
      config: cfg,
      connect: async () => makeFolderClient([], rec),
    });
    expect(r.success).toBe(true);
    expect(rec.created).toBe("Projects");
  });
});

describe("imapDeleteMailbox", () => {
  it("resolves the path (by leaf name) and deletes it", async () => {
    const rec: FolderRec = {};
    const r = await imapDeleteMailbox("Old Stuff", {
      config: cfg,
      connect: async () =>
        makeFolderClient([{ path: "Archive/Old Stuff", name: "Old Stuff" }], rec),
    });
    expect(r.success).toBe(true);
    expect(rec.deleted).toBe("Archive/Old Stuff");
  });

  it("returns a not-found error (and does not delete) when the mailbox is absent", async () => {
    const rec: FolderRec = {};
    const r = await imapDeleteMailbox("Nope", {
      config: cfg,
      connect: async () => makeFolderClient([{ path: "INBOX", name: "INBOX" }], rec),
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/i);
    expect(rec.deleted).toBeUndefined();
  });
});

describe("imapRenameMailbox", () => {
  it("renames an existing mailbox to the new path", async () => {
    const rec: FolderRec = {};
    const r = await imapRenameMailbox("Temp", "Permanent", {
      config: cfg,
      connect: async () => makeFolderClient([{ path: "Temp", name: "Temp" }], rec),
    });
    expect(r.success).toBe(true);
    expect(rec.renamed).toEqual(["Temp", "Permanent"]);
  });

  it("fails clearly when the source mailbox doesn't exist", async () => {
    const rec: FolderRec = {};
    const r = await imapRenameMailbox("Ghost", "Real", {
      config: cfg,
      connect: async () => makeFolderClient([], rec),
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/i);
    expect(rec.renamed).toBeUndefined();
  });
});

// --- Phase 3: composite id + message-level mutations -----------------------

describe("encodeImapId / decodeImapId (#43 Phase 3)", () => {
  it("round-trips account, path, and uid", () => {
    const id = encodeImapId("iCloud", "[Gmail]/All Mail", 12345);
    expect(id.startsWith("imap:")).toBe(true);
    expect(decodeImapId(id)).toEqual({ account: "iCloud", path: "[Gmail]/All Mail", uid: 12345 });
  });
  it("returns null for a bare numeric (AppleScript) id and garbage", () => {
    expect(decodeImapId("57820")).toBeNull();
    expect(decodeImapId("imap:not-valid-base64-json")).toBeNull();
  });
});

interface MsgRec {
  opened?: string;
  flagsAdded?: string[];
  flagsRemoved?: string[];
  moved?: [number[], string];
  deleted?: number[];
}

function makeMsgClient(rec: MsgRec, source?: string): ImapClientLike {
  const base = makeClient([], {});
  return {
    ...base,
    getMailboxLock: async (path: string) => {
      rec.opened = path;
      return { release: () => undefined };
    },
    fetchOne: async () =>
      source ? { uid: 1, envelope: { subject: "Hello" }, source: Buffer.from(source) } : false,
    messageFlagsAdd: async (_r: number[], flags: string[]) => {
      rec.flagsAdded = flags;
      return true;
    },
    messageFlagsRemove: async (_r: number[], flags: string[]) => {
      rec.flagsRemoved = flags;
      return true;
    },
    messageMove: async (r: number[], dest: string) => {
      rec.moved = [r, dest];
      return {};
    },
    messageDelete: async (r: number[]) => {
      rec.deleted = r;
      return true;
    },
  };
}

const MID = encodeImapId("iCloud", "INBOX", 1);

describe("IMAP message mutations (#43 Phase 3)", () => {
  it("mark read / unread set and clear \\Seen on the right mailbox+uid", async () => {
    const rec: MsgRec = {};
    await imapMarkRead(MID, { config: cfg, connect: async () => makeMsgClient(rec) });
    expect(rec.opened).toBe("INBOX");
    expect(rec.flagsAdded).toEqual(["\\Seen"]);
    const rec2: MsgRec = {};
    await imapMarkUnread(MID, { config: cfg, connect: async () => makeMsgClient(rec2) });
    expect(rec2.flagsRemoved).toEqual(["\\Seen"]);
  });

  it("flag / unflag toggle \\Flagged", async () => {
    const recF: MsgRec = {};
    await imapFlagMessage(MID, { config: cfg, connect: async () => makeMsgClient(recF) });
    expect(recF.flagsAdded).toEqual(["\\Flagged"]);
    const recU: MsgRec = {};
    await imapUnflagMessage(MID, { config: cfg, connect: async () => makeMsgClient(recU) });
    expect(recU.flagsRemoved).toEqual(["\\Flagged"]);
  });

  it("move routes the uid to the resolved destination", async () => {
    const rec: MsgRec = {};
    const r = await imapMoveMessageById(MID, "Archive", {
      config: cfg,
      connect: async () => makeMsgClient(rec),
    });
    expect(r.success).toBe(true);
    expect(rec.moved).toEqual([[1], "Archive"]);
  });

  it("delete expunges the uid", async () => {
    const rec: MsgRec = {};
    const r = await imapDeleteMessageById(MID, {
      config: cfg,
      connect: async () => makeMsgClient(rec),
    });
    expect(r.success).toBe(true);
    expect(rec.deleted).toEqual([1]);
  });

  it("get-message returns subject + decoded body", async () => {
    const src = "Content-Type: text/plain\r\n\r\nHello body line";
    const r = await imapGetMessage(MID, false, {
      config: cfg,
      connect: async () => makeMsgClient({}, src),
    });
    expect(r.success).toBe(true);
    expect(r.info).toContain("Subject: Hello");
    expect(r.info).toContain("Hello body line");
  });

  it("rejects a non-IMAP id", async () => {
    const r = await imapDeleteMessageById("57820");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Not an IMAP message id/);
  });
});

describe("attachments via BODYSTRUCTURE (I1)", () => {
  const MID = encodeImapId("acct", "INBOX", 9);
  function attClient(): ImapClientLike {
    return {
      ...makeClient([], {}),
      fetchOne: async () => ({
        uid: 9,
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            { part: "1", type: "text/plain", size: 100 }, // body, not an attachment
            {
              part: "2",
              type: "application/pdf",
              disposition: "attachment",
              dispositionParameters: { filename: "report.pdf" },
              size: 2048,
            },
            { part: "3", type: "image/png", parameters: { name: "logo.png" }, size: 512 },
          ],
        },
      }),
      download: async (_range: string, part: string) => ({
        meta: {},
        content: (async function* () {
          yield Buffer.from(`bytes-of-${part}`);
        })(),
      }),
    };
  }

  it("lists only attachment parts from BODYSTRUCTURE", async () => {
    const r = await imapListAttachments(MID, { config: cfg, connect: async () => attClient() });
    expect(r.success).toBe(true);
    expect(r.attachments?.map((a) => a.name)).toEqual(["report.pdf", "logo.png"]);
    expect(r.attachments?.[0]).toMatchObject({ mimeType: "application/pdf", size: 2048 });
  });

  it("fetches an attachment's bytes by filename", async () => {
    const r = await imapFetchAttachment(MID, "report.pdf", {
      config: cfg,
      connect: async () => attClient(),
    });
    expect(r.success).toBe(true);
    expect(Buffer.from(r.base64 as string, "base64").toString()).toBe("bytes-of-2");
    expect(r.mimeType).toBe("application/pdf");
  });

  it("errors clearly when the attachment name isn't found", async () => {
    const r = await imapFetchAttachment(MID, "missing.txt", {
      config: cfg,
      connect: async () => attClient(),
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });

  it("rejects a non-IMAP id", async () => {
    expect((await imapListAttachments("12345")).success).toBe(false);
  });
});

describe("STATUS-based counts (I3/I4/I6)", () => {
  const boxes = [
    { path: "INBOX", name: "INBOX" },
    { path: "[Gmail]/Sent Mail", name: "Sent Mail" },
  ];
  function statusClient(
    map: Record<string, { messages?: number; unseen?: number }>
  ): ImapClientLike {
    return {
      ...makeClient([], {}),
      list: async () => boxes,
      status: async (path: string) => ({ path, messages: 0, unseen: 0, ...(map[path] || {}) }),
    };
  }

  it("imapUnreadCount returns UNSEEN for a specific mailbox", async () => {
    const n = await imapUnreadCount("INBOX", {
      config: cfg,
      connect: async () => statusClient({ INBOX: { unseen: 7 } }),
    });
    expect(n).toBe(7);
  });

  it("imapUnreadCount sums UNSEEN across all mailboxes when none given", async () => {
    const n = await imapUnreadCount(undefined, {
      config: cfg,
      connect: async () =>
        statusClient({ INBOX: { unseen: 7 }, "[Gmail]/Sent Mail": { unseen: 2 } }),
    });
    expect(n).toBe(9);
  });

  it("imapListMailboxes returns per-mailbox message/unseen counts", async () => {
    const r = await imapListMailboxes({
      config: cfg,
      connect: async () => statusClient({ INBOX: { messages: 10, unseen: 7 } }),
    });
    expect(r.find((b) => b.path === "INBOX")).toMatchObject({ messages: 10, unseen: 7 });
    expect(r).toHaveLength(2);
  });

  it("imapMailStats aggregates STATUS totals and recent SEARCH counts", async () => {
    const client: ImapClientLike = {
      ...statusClient({
        INBOX: { messages: 10, unseen: 7 },
        "[Gmail]/Sent Mail": { messages: 5, unseen: 0 },
      }),
      getMailboxLock: async () => ({ release: () => undefined }),
      search: async () => [1, 2, 3],
    };
    const s = await imapMailStats({ config: cfg, connect: async () => client });
    expect(s.totalMessages).toBe(15);
    expect(s.totalUnread).toBe(7);
    expect(s.recent.last24h).toBe(3);
    expect(s.recent.last7d).toBe(3);
  });
});

describe("connection pooling (#50 / A3)", () => {
  afterEach(async () => {
    await __resetPool();
    __setPoolConnect(null);
  });

  it("reuses one kept-alive connection across calls (NOOP liveness, no per-call logout)", async () => {
    let connects = 0;
    let noops = 0;
    let logouts = 0;
    __setPoolConnect(async () => {
      connects++;
      const c = makeClient([1, 2], {});
      return {
        ...c,
        noop: async () => {
          noops++;
        },
        logout: async () => {
          logouts++;
        },
      };
    });
    // No injected connect → uses the pool.
    await imapListMessages({ mailbox: "INBOX", limit: 5 }, { config: cfg });
    await imapListMessages({ mailbox: "INBOX", limit: 5 }, { config: cfg });
    expect(connects).toBe(1); // one connection, reused
    expect(noops).toBe(1); // liveness checked before the 2nd reuse
    expect(logouts).toBe(0); // kept alive, not logged out per call
  });

  it("reconnects when the pooled connection fails its liveness check", async () => {
    let connects = 0;
    __setPoolConnect(async () => {
      connects++;
      const c = makeClient([1], {});
      // First connection reports dead on the next NOOP → forces a reconnect.
      return connects === 1
        ? {
            ...c,
            noop: async () => {
              throw new Error("connection dropped");
            },
          }
        : c;
    });
    await imapListMessages({ mailbox: "INBOX", limit: 5 }, { config: cfg });
    await imapListMessages({ mailbox: "INBOX", limit: 5 }, { config: cfg });
    expect(connects).toBe(2);
  });

  it("keeps a separate pooled connection per account", async () => {
    let connects = 0;
    __setPoolConnect(async () => {
      connects++;
      return makeClient([1], {});
    });
    const cfgA: ImapConfig = { ...cfg, user: "a@x.com" };
    const cfgB: ImapConfig = { ...cfg, user: "b@x.com" };
    await imapListMessages({ mailbox: "INBOX", limit: 5 }, { config: cfgA });
    await imapListMessages({ mailbox: "INBOX", limit: 5 }, { config: cfgB });
    await imapListMessages({ mailbox: "INBOX", limit: 5 }, { config: cfgA }); // reuse A
    expect(connects).toBe(2); // one connection per distinct account; A reused
  });

  it("does not pool when a connect is injected (per-call logout)", async () => {
    let logouts = 0;
    const make = () => {
      const c = makeClient([1], {});
      return {
        ...c,
        logout: async () => {
          logouts++;
        },
      };
    };
    await imapListMessages(
      { mailbox: "INBOX", limit: 5 },
      { config: cfg, connect: async () => make() }
    );
    await imapListMessages(
      { mailbox: "INBOX", limit: 5 },
      { config: cfg, connect: async () => make() }
    );
    expect(logouts).toBe(2); // injected path logs out each call (no pooling)
  });
});
