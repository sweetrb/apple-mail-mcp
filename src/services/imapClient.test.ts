import { describe, it, expect, afterEach, vi } from "vitest";
import {
  IMAP_ENV,
  isImapAccount,
  shouldUseImap,
  resolveImapConfig,
  resolveMailboxPath,
  imapSearchMessages,
  imapListMessages,
  imapCreateMailbox,
  imapDeleteMailbox,
  imapRenameMailbox,
  encodeImapId,
  decodeImapId,
  imapFetchMessageId,
  normalizeMessageId,
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
  bodyStructureHasAttachments,
  imapBatchMarkRead,
  imapBatchMove,
  imapBatchDelete,
  imapBatchUnflag,
  imapThread,
  listImapAccountLabels,
  imapHealthCheck,
  __setPoolConnect,
  __resetPool,
  dropAllPools,
  buildImapConnectionOptions,
  type ImapClientLike,
  type ImapConfig,
} from "@/services/imapClient.js";
import { MAX_IMAP_ATTACHMENT_BYTES } from "@/utils/attachmentLimits.js";

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

describe("imapFetchMessageId / normalizeMessageId (imap→numeric bridge)", () => {
  it("normalizeMessageId strips surrounding angle brackets and whitespace", () => {
    expect(normalizeMessageId("  <abc@ex.com> ")).toBe("abc@ex.com");
    expect(normalizeMessageId("abc@ex.com")).toBe("abc@ex.com");
    expect(normalizeMessageId("<<weird>>")).toBe("weird");
  });

  it("returns null for a non-imap (numeric) id without touching IMAP", async () => {
    expect(await imapFetchMessageId("12345", { config: cfg })).toBeNull();
  });

  it("fetches and normalizes the Message-ID for an imap: id", async () => {
    const id = encodeImapId("rob@example.com", "INBOX", 42);
    const client: ImapClientLike = {
      ...makeClient([], {}),
      getMailboxLock: async () => ({ release: () => undefined }),
      fetchOne: async () => ({ uid: 42, envelope: { messageId: "<HELLO@mail.example.com>" } }),
    };
    const mid = await imapFetchMessageId(id, { config: cfg, connect: async () => client });
    expect(mid).toBe("HELLO@mail.example.com");
  });

  it("returns null when the envelope carries no Message-ID", async () => {
    const id = encodeImapId("rob@example.com", "INBOX", 7);
    const client: ImapClientLike = {
      ...makeClient([], {}),
      getMailboxLock: async () => ({ release: () => undefined }),
      fetchOne: async () => ({ uid: 7, envelope: { subject: "no msgid" } }),
    };
    expect(await imapFetchMessageId(id, { config: cfg, connect: async () => client })).toBeNull();
  });

  it("returns null (not throw) when the fetch fails", async () => {
    const id = encodeImapId("rob@example.com", "INBOX", 9);
    const client: ImapClientLike = {
      ...makeClient([], {}),
      getMailboxLock: async () => ({ release: () => undefined }),
      fetchOne: async () => {
        throw new Error("connection reset");
      },
    };
    expect(await imapFetchMessageId(id, { config: cfg, connect: async () => client })).toBeNull();
  });
});

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

describe("shouldUseImap (v2.6.0 prefer-IMAP read gate)", () => {
  const env = { [IMAP_ENV.user]: "rob@example.com", [IMAP_ENV.account]: "Work" };

  it("is false when IMAP is not configured (behavior unchanged → AppleScript)", () => {
    expect(shouldUseImap(undefined, {})).toBe(false);
    expect(shouldUseImap("anything", {})).toBe(false);
  });

  it("is true with no account when IMAP IS configured (→ merge across accounts)", () => {
    expect(shouldUseImap(undefined, env)).toBe(true);
  });

  it("is true for an explicitly-named configured IMAP account (label or user)", () => {
    expect(shouldUseImap("Work", env)).toBe(true);
    expect(shouldUseImap("rob@example.com", env)).toBe(true);
  });

  it("is FALSE for an explicitly-named NON-IMAP account (→ AppleScript)", () => {
    expect(shouldUseImap("Exchange-Work", env)).toBe(false);
    expect(shouldUseImap("someone@else.com", env)).toBe(false);
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
    expect(c.allowPlaintext).toBe(false);
    expect(c.pass).toBe("pw");
  });
  it("requires explicit opt-in before allowing plaintext IMAP", () => {
    const c = resolveImapConfig({
      [IMAP_ENV.user]: "rob@example.com",
      [IMAP_ENV.password]: "pw",
      [IMAP_ENV.port]: "143",
      [IMAP_ENV.allowPlaintext]: "1",
    });
    expect(c.secure).toBe(false);
    expect(c.allowPlaintext).toBe(true);
    // Opportunistic (undefined), not `false`: the opt-out means "reach a server
    // that cannot do TLS", not "never encrypt even when the server offers it".
    expect(buildImapConnectionOptions(c)).toMatchObject({
      secure: false,
      doSTARTTLS: undefined,
    });
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

describe("account identity dedupe — same (host, port, user), different label", () => {
  // Regression: the dedupe compared LABELS only, so declaring one mailbox twice
  // (legacy singular keys + an ACCOUNTS entry under a different nickname)
  // produced two specs. Every merge-across-accounts counter then visited that
  // mailbox twice and double-counted it.
  const dupEnv: NodeJS.ProcessEnv = {
    [IMAP_ENV.user]: "rob@example.com",
    [IMAP_ENV.password]: "pw",
    [IMAP_ENV.host]: "imap.gmail.com",
    [IMAP_ENV.accounts]: JSON.stringify([
      { account: "Personal Gmail", user: "rob@example.com", host: "imap.gmail.com" },
    ]),
  };

  it("keeps exactly one spec when two labels resolve to the same mailbox", () => {
    expect(listImapAccountLabels(dupEnv)).toEqual(["rob@example.com"]);
  });

  it("the collapsed nickname still ADDRESSES the mailbox (no routing regression)", () => {
    // Deduping must not make a previously-working selector unresolvable: the
    // mailbox stops being counted twice, but both names keep working.
    expect(isImapAccount("Personal Gmail", dupEnv)).toBe(true);
    expect(isImapAccount("rob@example.com", dupEnv)).toBe(true);
    expect(resolveImapConfig(dupEnv, "Personal Gmail").user).toBe("rob@example.com");
    // …and it resolves to the SAME single account, under its canonical label.
    expect(resolveImapConfig(dupEnv, "Personal Gmail").accountLabel).toBe("rob@example.com");
    expect(isImapAccount("Not A Real Nickname", dupEnv)).toBe(false);
  });

  it("drops the duplicate from a mixed list and keeps the genuinely distinct ones", () => {
    const env: NodeJS.ProcessEnv = {
      [IMAP_ENV.user]: "rob@example.com",
      [IMAP_ENV.password]: "pw",
      [IMAP_ENV.accounts]: JSON.stringify([
        { account: "Work", user: "rob@work.example", host: "imap.gmail.com" },
        { account: "iCloud", user: "rob@icloud.example", host: "imap.mail.me.com" },
        // Same mailbox as the legacy account above, under a different nickname.
        { account: "Personal Gmail", user: "rob@example.com", host: "imap.gmail.com" },
      ]),
    };
    expect(listImapAccountLabels(env)).toEqual(["rob@example.com", "Work", "iCloud"]);
  });

  it("folds host case (DNS is case-insensitive)", () => {
    const env: NodeJS.ProcessEnv = {
      [IMAP_ENV.user]: "rob@example.com",
      [IMAP_ENV.password]: "pw",
      [IMAP_ENV.host]: "imap.gmail.com",
      [IMAP_ENV.accounts]: JSON.stringify([
        { account: "Shouty", user: "rob@example.com", host: "IMAP.GMAIL.COM" },
      ]),
    };
    expect(listImapAccountLabels(env)).toEqual(["rob@example.com"]);
  });

  it("does NOT fold the user local part — a different login stays a real account", () => {
    // RFC 5321 leaves the local part case-sensitive and only the receiving
    // server may fold it; dropping an account is worse than double-counting.
    const env: NodeJS.ProcessEnv = {
      [IMAP_ENV.user]: "Rob@example.com",
      [IMAP_ENV.password]: "pw",
      [IMAP_ENV.host]: "imap.gmail.com",
      [IMAP_ENV.accounts]: JSON.stringify([
        { account: "lowercase", user: "rob@example.com", host: "imap.gmail.com" },
      ]),
    };
    expect(listImapAccountLabels(env)).toEqual(["Rob@example.com", "lowercase"]);
  });

  it("still rejects two distinct mailboxes sharing one label", () => {
    const env: NodeJS.ProcessEnv = {
      [IMAP_ENV.user]: "rob@example.com",
      [IMAP_ENV.password]: "pw",
      [IMAP_ENV.account]: "Personal",
      [IMAP_ENV.accounts]: JSON.stringify([
        { account: "Personal", user: "someone.else@example.com", host: "imap.gmail.com" },
      ]),
    };
    expect(listImapAccountLabels(env)).toEqual(["Personal"]);
  });

  it("treats a different port as a different mailbox", () => {
    const env: NodeJS.ProcessEnv = {
      [IMAP_ENV.user]: "rob@example.com",
      [IMAP_ENV.password]: "pw",
      [IMAP_ENV.host]: "imap.example.com",
      [IMAP_ENV.accounts]: JSON.stringify([
        { account: "Plain", user: "rob@example.com", host: "imap.example.com", port: 143 },
      ]),
    };
    expect(listImapAccountLabels(env)).toEqual(["rob@example.com", "Plain"]);
  });
});

describe("imapHealthCheck configured-gate (#138)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports NOT configured only when no account is configured at all", async () => {
    vi.stubEnv(IMAP_ENV.user, "");
    vi.stubEnv(IMAP_ENV.accounts, "");
    expect(await imapHealthCheck()).toEqual({ configured: false, ok: false });
  });

  it("sees an ACCOUNTS-only config as configured and returns a real error", async () => {
    // Regression for #138: the gate used to test the legacy singular
    // APPLE_MAIL_MCP_IMAP_USER only, so an ACCOUNTS-only setup short-circuited
    // to {configured:false, ok:false} with NO error — which doctor rendered as
    // "connection failed: undefined". No password/Keychain here, so the config
    // fails to resolve and we get a real message without touching the network.
    vi.stubEnv(IMAP_ENV.user, "");
    vi.stubEnv(IMAP_ENV.accounts, JSON.stringify([{ account: "Work", user: "me@co.com" }]));
    const h = await imapHealthCheck({ account: "Work" });
    expect(h.configured).toBe(true);
    expect(h.ok).toBe(false);
    expect(h.error).toBeDefined();
    expect(h.error).toMatch(/No IMAP password for account "Work"/);
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
    const res = await imapSearchMessages(
      { query: "the", limit: 2 },
      { config: cfg, connect: async () => makeClient([1, 2, 3, 4, 5], rec) }
    );
    const out = res.text;
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
    // structuredContent now mirrors the AppleScript path's shape (messages + count).
    expect(res.count).toBe(2);
    expect(res.messages.map((m) => decodeImapId(m.id as string)?.uid)).toEqual([5, 4]);
    expect(res.messages[0]).toMatchObject({
      subject: "Subject 5",
      mailbox: "[Gmail]/All Mail",
      isRead: false,
    });
  });

  it("returns a clear empty message when nothing matches", async () => {
    const res = await imapSearchMessages(
      { query: "zzz" },
      { config: cfg, connect: async () => makeClient([], {}) }
    );
    expect(res.text).toMatch(/No messages found via IMAP/);
    expect(res.count).toBe(0);
    expect(res.messages).toEqual([]);
  });
});

describe("imapListMessages", () => {
  it("defaults to INBOX and maps unreadOnly to an unseen search", async () => {
    const rec: Rec = {};
    const res = await imapListMessages(
      { unreadOnly: true, limit: 10 },
      { config: cfg, connect: async () => makeClient([7, 8], rec) }
    );
    const out = res.text;
    expect(rec.path).toBe("INBOX");
    expect(rec.criteria).toEqual({ unseen: true });
    const uids = [...out.matchAll(/imap:[A-Za-z0-9_-]+/g)].map((m) => decodeImapId(m[0])?.uid);
    expect(uids).toEqual([8, 7]); // newest-first
    expect(out).toContain("2 total listed");
    expect(res.count).toBe(2);
    expect(res.messages.map((m) => decodeImapId(m.id as string)?.uid)).toEqual([8, 7]);
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

// #137: the leaf-name fallback used `.find()`, so a name matching two mailboxes
// under different parents silently resolved to whichever the server listed
// first — and a *move* then reported success for the wrong destination.
describe("ambiguous mailbox resolution (#137)", () => {
  const TWO_ARCHIVES = [
    { path: "Work/Archive", name: "Archive" },
    { path: "Thornlands/Archive", name: "Archive" },
  ];

  it("an exact path match still wins over a same-named leaf", async () => {
    const rec: FolderRec = {};
    const r = await imapDeleteMailbox("Archive", {
      config: cfg,
      connect: async () =>
        makeFolderClient([{ path: "Archive", name: "Archive" }, ...TWO_ARCHIVES], rec),
    });
    expect(r.success).toBe(true);
    expect(rec.deleted).toBe("Archive");
  });

  it("a single leaf match still resolves (stored pre-full-path names keep working)", async () => {
    const rec: FolderRec = {};
    const r = await imapDeleteMailbox("Home Reno", {
      config: cfg,
      connect: async () =>
        makeFolderClient([{ path: "Thornlands/Home Reno", name: "Home Reno" }], rec),
    });
    expect(r.success).toBe(true);
    expect(rec.deleted).toBe("Thornlands/Home Reno");
  });

  it("two leaf matches error, name both candidates, and delete nothing", async () => {
    const rec: FolderRec = {};
    const r = await imapDeleteMailbox("Archive", {
      config: cfg,
      connect: async () => makeFolderClient(TWO_ARCHIVES, rec),
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/ambiguous/i);
    expect(r.error).toContain("Thornlands/Archive");
    expect(r.error).toContain("Work/Archive");
    expect(r.error).toMatch(/full path/i);
    expect(rec.deleted).toBeUndefined();
  });

  it("rename refuses an ambiguous source rather than renaming the wrong mailbox", async () => {
    const rec: FolderRec = {};
    const r = await imapRenameMailbox("Archive", "Archived", {
      config: cfg,
      connect: async () => makeFolderClient(TWO_ARCHIVES, rec),
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/ambiguous/i);
    expect(rec.renamed).toBeUndefined();
  });

  // The one that motivated the issue: a silent wrong move is worse than a refusal,
  // because the call reports success and nothing surfaces the mistake.
  it("move refuses an ambiguous destination instead of picking the first", async () => {
    const rec: MsgRec = {};
    const r = await imapMoveMessageById(MID, "Archive", {
      config: cfg,
      connect: async () => ({ ...makeMsgClient(rec), list: async () => TWO_ARCHIVES }),
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/ambiguous/i);
    expect(r.error).toContain("Thornlands/Archive");
    expect(r.error).toContain("Work/Archive");
    expect(rec.moved).toBeUndefined();
  });

  it("batch move reports the ambiguity as a failure rather than moving the batch", async () => {
    const rec: MsgRec = {};
    const r = await imapBatchMove([MID], "Archive", {
      config: cfg,
      connect: async () => ({ ...makeMsgClient(rec), list: async () => TWO_ARCHIVES }),
    });
    expect(r.success).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.errors.join(" ")).toMatch(/ambiguous/i);
    expect(rec.moved).toBeUndefined();
  });

  it("an unmatched destination still falls back to the literal path (unchanged)", async () => {
    const rec: MsgRec = {};
    const r = await imapMoveMessageById(MID, "Archive", {
      config: cfg,
      connect: async () => ({ ...makeMsgClient(rec), list: async () => [] }),
    });
    expect(r.success).toBe(true);
    expect(rec.moved).toEqual([[1], "Archive"]);
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
    // colorIndex omitted -> plain flag, no color keywords touched
    await imapFlagMessage(MID, undefined, {
      config: cfg,
      connect: async () => makeMsgClient(recF),
    });
    expect(recF.flagsAdded).toEqual(["\\Flagged"]);
    const recU: MsgRec = {};
    await imapUnflagMessage(MID, { config: cfg, connect: async () => makeMsgClient(recU) });
    // Unflag clears the color bits too, or Mail.app keeps rendering the color.
    expect(recU.flagsRemoved).toEqual([
      "\\Flagged",
      "$MailFlagBit0",
      "$MailFlagBit1",
      "$MailFlagBit2",
    ]);
  });

  it("flagging with a color sets \\Flagged plus that color's bits", async () => {
    const rec: MsgRec = {};
    // 5 = purple = bit0 + bit2
    await imapFlagMessage(MID, 5, { config: cfg, connect: async () => makeMsgClient(rec) });
    expect(rec.flagsAdded).toEqual(["\\Flagged", "$MailFlagBit0", "$MailFlagBit2"]);
    // bit1 must be cleared, so re-flagging in a new color replaces rather than OR-ing
    expect(rec.flagsRemoved).toEqual(["$MailFlagBit1"]);
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

  it("delete moves the uid to Trash (recoverable) rather than expunging", async () => {
    // Gmail expunge on [Gmail]/All Mail is a no-op, so delete must MOVE to Trash.
    // With an empty LIST the mailbox resolves to the [Gmail]/Trash default.
    const rec: MsgRec = {};
    const r = await imapDeleteMessageById(MID, {
      config: cfg,
      connect: async () => makeMsgClient(rec),
    });
    expect(r.success).toBe(true);
    expect(rec.moved).toEqual([[1], "[Gmail]/Trash"]);
    expect(rec.deleted).toBeUndefined();
  });

  it("delete resolves the server's \\Trash special-use mailbox", async () => {
    const rec: MsgRec = {};
    const client: ImapClientLike = {
      ...makeMsgClient(rec),
      list: async () => [
        { path: "INBOX", name: "INBOX" },
        { path: "Deleted Messages", name: "Deleted Messages", specialUse: "\\Trash" },
      ],
    };
    const r = await imapDeleteMessageById(MID, { config: cfg, connect: async () => client });
    expect(r.success).toBe(true);
    expect(rec.moved).toEqual([[1], "Deleted Messages"]);
  });

  it("delete from within Trash permanently expunges (empty-from-Trash)", async () => {
    const rec: MsgRec = {};
    const trashId = encodeImapId("iCloud", "[Gmail]/Trash", 1);
    const r = await imapDeleteMessageById(trashId, {
      config: cfg,
      connect: async () => makeMsgClient(rec),
    });
    expect(r.success).toBe(true);
    expect(rec.deleted).toEqual([1]);
    expect(rec.moved).toBeUndefined();
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

  it("rejects an account override that disagrees with the composite message id", async () => {
    await expect(
      imapGetMessage(MID, false, {
        account: "Work",
        config: cfg,
        connect: async () => makeMsgClient({}),
      })
    ).rejects.toThrow(/belongs to account "iCloud", not "Work"/);
  });

  it("accepts the login-address selector for a label-encoded message id", async () => {
    const aliasCfg = {
      ...cfg,
      user: "person@example.com",
      accountLabel: "Personal",
    };
    const id = encodeImapId("Personal", "INBOX", 1);
    const result = await imapGetMessage(id, false, {
      account: "person@example.com",
      config: aliasCfg,
      connect: async () => makeMsgClient({}, "Content-Type: text/plain\r\n\r\nAlias body"),
    });

    expect(result.success).toBe(true);
    expect(result.info).toContain("Alias body");
  });

  it("rejects a non-IMAP id", async () => {
    const r = await imapDeleteMessageById("57820");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Not an IMAP message id/);
  });
});

describe("true threading via References (I5)", () => {
  const MID = encodeImapId("acct", "INBOX", 10);
  function threadClient(): ImapClientLike {
    return {
      ...makeClient([], {}),
      fetchOne: async () => ({
        uid: 10,
        envelope: { subject: "Re: Plan", messageId: "<b@x>", inReplyTo: "<a@x>" },
        headers: Buffer.from("References: <a@x>\r\nIn-Reply-To: <a@x>\r\n"),
      }),
      search: async (q: Record<string, unknown>) => {
        const h = (q.header as Record<string, string>) || {};
        if (h.references === "<b@x>" || h["in-reply-to"] === "<b@x>") return [11];
        if (h["message-id"] === "<a@x>") return [9];
        return [];
      },
      fetch: async function* (range: string) {
        for (const u of range.split(",").map(Number)) {
          yield {
            uid: u,
            envelope: {
              subject: u === 9 ? "Plan" : "Re: Plan",
              date: new Date(2026, 0, u),
              from: [{ address: `p${u}@x` }],
            },
            flags: new Set<string>(),
          };
        }
      },
    };
  }

  it("assembles ancestors + descendants oldest-first", async () => {
    const t = await imapThread(MID, { config: cfg, connect: async () => threadClient() }, 50);
    expect(t).not.toBeNull();
    expect(t?.count).toBe(3); // seed 10 + descendant 11 + ancestor 9
    expect(t?.structured.messages.map((m) => m.subject)).toEqual(["Plan", "Re: Plan", "Re: Plan"]);
    expect(t?.text).toMatch(/References-linked/);
  });

  it("returns null when only the seed is found (caller falls back to subject)", async () => {
    const client: ImapClientLike = {
      ...makeClient([], {}),
      fetchOne: async () => ({
        uid: 10,
        envelope: { subject: "x", messageId: "<b@x>" },
        headers: Buffer.from(""),
      }),
      search: async () => [],
    };
    expect(await imapThread(MID, { config: cfg, connect: async () => client }, 50)).toBeNull();
  });

  it("returns null for a non-IMAP id", async () => {
    expect(await imapThread("12345")).toBeNull();
  });
});

describe("batch ops via UID STORE/MOVE (I2)", () => {
  it("groups ids by mailbox and applies flags as one UID set per mailbox", async () => {
    const calls: { path: string; uids: number[]; flags: string[] }[] = [];
    let opens = 0;
    let lastPath = "";
    const client: ImapClientLike = {
      ...makeClient([], {}),
      getMailboxLock: async (path: string) => {
        opens++;
        lastPath = path;
        return { release: () => undefined };
      },
      messageFlagsAdd: async (uids: number[], flags: string[]) => {
        calls.push({ path: lastPath, uids, flags });
        return true;
      },
    };
    const ids = [
      encodeImapId("acct", "INBOX", 1),
      encodeImapId("acct", "INBOX", 2),
      encodeImapId("acct", "Archive", 9),
    ];
    const r = await imapBatchMarkRead(ids, { config: cfg, connect: async () => client });
    expect(r.success).toBe(3);
    expect(r.failed).toBe(0);
    expect(opens).toBe(2); // one lock per distinct mailbox
    expect(calls).toEqual([
      { path: "INBOX", uids: [1, 2], flags: ["\\Seen"] },
      { path: "Archive", uids: [9], flags: ["\\Seen"] },
    ]);
  });

  it("counts non-IMAP ids as failures", async () => {
    const r = await imapBatchMarkRead(["12345"], {
      config: cfg,
      connect: async () => makeClient([], {}),
    });
    expect(r.success).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.errors[0]).toMatch(/Not an IMAP id/);
  });

  it("fails a group whose composite ids disagree with the requested account", async () => {
    const connect = vi.fn(async () => makeClient([], {}));
    const r = await imapBatchMarkRead([encodeImapId("Personal", "INBOX", 1)], {
      account: "Work",
      config: cfg,
      connect,
    });

    expect(r.success).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.errors[0]).toMatch(/belongs to account "Personal", not "Work"/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("batch-moves a label-encoded id when the account selector is its login address", async () => {
    const aliasCfg = {
      ...cfg,
      user: "person@example.com",
      accountLabel: "Personal",
    };
    const rec: MsgRec = {};
    const client: ImapClientLike = {
      ...makeMsgClient(rec),
      list: async () => [{ path: "Archive", name: "Archive" }],
    };

    const result = await imapBatchMove([encodeImapId("Personal", "INBOX", 1)], "Archive", {
      account: "person@example.com",
      config: aliasCfg,
      connect: async () => client,
    });

    expect(result).toMatchObject({ success: 1, failed: 0, errors: [] });
    expect(rec.moved).toEqual([[1], "Archive"]);
  });

  it("moves a UID set to a resolved destination mailbox", async () => {
    let moved: { uids: number[]; dest: string } | null = null;
    const client: ImapClientLike = {
      ...makeClient([], {}),
      list: async () => [{ path: "Archive", name: "Archive" }],
      messageMove: async (uids: number[], dest: string) => {
        moved = { uids, dest };
        return {};
      },
    };
    const ids = [encodeImapId("acct", "INBOX", 5), encodeImapId("acct", "INBOX", 6)];
    const r = await imapBatchMove(ids, "Archive", { config: cfg, connect: async () => client });
    expect(r.success).toBe(2);
    expect(moved).toEqual({ uids: [5, 6], dest: "Archive" });
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

  // Apple Mail sends genuine file attachments as `Content-Disposition: inline`
  // — it inlines them into the message flow rather than appending them. The
  // structure below is copied from a real message (an invoice PDF this server's
  // own author sent from Mail.app): inline, named, and with NO Content-ID.
  //
  // Excluding every inline part made all of them invisible AND unfetchable over
  // IMAP, because fetch-attachment resolves by name against this same list.
  function appleMailClient(): ImapClientLike {
    return {
      ...makeClient([], {}),
      fetchOne: async () => ({
        uid: 9,
        bodyStructure: {
          type: "multipart/alternative",
          childNodes: [
            { part: "1", type: "text/plain", size: 353 },
            {
              part: "2",
              type: "multipart/mixed",
              childNodes: [
                { part: "2.1", type: "text/html", size: 443 },
                {
                  part: "2.2",
                  type: "application/pdf",
                  parameters: { name: "SEI Invoice.pdf" },
                  disposition: "inline",
                  dispositionParameters: { filename: "SEI Invoice.pdf" },
                  size: 66714,
                },
                { part: "2.3", type: "text/html", size: 3715 },
              ],
            },
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

  it("lists an inline-disposition file attachment (Apple Mail's shape)", async () => {
    const r = await imapListAttachments(MID, {
      config: cfg,
      connect: async () => appleMailClient(),
    });
    expect(r.success).toBe(true);
    expect(r.attachments?.map((a) => a.name)).toEqual(["SEI Invoice.pdf"]);
    expect(r.attachments?.[0]).toMatchObject({ mimeType: "application/pdf", size: 66714 });
  });

  it("can fetch that inline attachment by name", async () => {
    // Listing it is only half the fix: fetch/save resolve by name against the
    // same walk, so an unlisted part is also an unfetchable one.
    const r = await imapFetchAttachment(MID, "SEI Invoice.pdf", {
      config: cfg,
      connect: async () => appleMailClient(),
    });
    expect(r.success).toBe(true);
    expect(r.mimeType).toBe("application/pdf");
  });

  it("still excludes an embedded image referenced by Content-ID", async () => {
    // The other half: a signature logo is inline, named AND carries a
    // Content-ID because the HTML references it as cid:. That one is genuinely
    // not an attachment, and widening the rule must not start listing it.
    const client: ImapClientLike = {
      ...makeClient([], {}),
      fetchOne: async () => ({
        uid: 9,
        bodyStructure: {
          type: "multipart/related",
          childNodes: [
            { part: "1", type: "text/html", size: 900 },
            {
              part: "2",
              type: "image/png",
              id: "<image001.png@01DC.4F2>",
              parameters: { name: "image001.png" },
              disposition: "inline",
              dispositionParameters: { filename: "image001.png" },
              size: 4096,
            },
          ],
        },
      }),
    };
    const r = await imapListAttachments(MID, { config: cfg, connect: async () => client });
    expect(r.success).toBe(true);
    expect(r.attachments).toEqual([]);
  });

  it("reports hasAttachments from BODYSTRUCTURE rather than assuming false", async () => {
    // Hardcoded `false` from 2.2.0: indistinguishable from "no attachments", so
    // every IMAP-sourced message claimed to have none and a caller deciding
    // whether to call list-attachments would always skip.
    const withAtt = bodyStructureHasAttachments({
      type: "multipart/mixed",
      childNodes: [
        { part: "1", type: "text/plain", size: 10 },
        {
          part: "2",
          type: "application/pdf",
          disposition: "inline",
          dispositionParameters: { filename: "Invoice.pdf" },
          size: 99,
        },
      ],
    });
    expect(withAtt).toBe(true);

    const bodyOnly = bodyStructureHasAttachments({
      type: "multipart/alternative",
      childNodes: [
        { part: "1", type: "text/plain", size: 10 },
        { part: "2", type: "text/html", size: 20 },
      ],
    });
    expect(bodyOnly).toBe(false);

    // Absent BODYSTRUCTURE must not claim attachments exist.
    expect(bodyStructureHasAttachments(undefined)).toBe(false);
  });

  it("lists an explicit attachment even when it carries a Content-ID", async () => {
    // Observed in real mail: disposition "attachment" WITH a Content-ID. The
    // explicit disposition has to win, or Content-ID becomes an over-broad veto.
    const client: ImapClientLike = {
      ...makeClient([], {}),
      fetchOne: async () => ({
        uid: 9,
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            { part: "1", type: "text/plain", size: 10 },
            {
              part: "2",
              type: "application/pdf",
              id: "<newsletter@example>",
              disposition: "attachment",
              dispositionParameters: { filename: "Newsletter.pdf" },
              size: 1234,
            },
          ],
        },
      }),
    };
    const r = await imapListAttachments(MID, { config: cfg, connect: async () => client });
    expect(r.attachments?.map((a) => a.name)).toEqual(["Newsletter.pdf"]);
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

  it("rejects a BODYSTRUCTURE attachment above the fetch limit before downloading", async () => {
    let downloaded = false;
    const base = attClient();
    const client: ImapClientLike = {
      ...base,
      fetchOne: async () => ({
        uid: 9,
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            {
              part: "2",
              type: "application/pdf",
              disposition: "attachment",
              dispositionParameters: { filename: "report.pdf" },
              size: MAX_IMAP_ATTACHMENT_BYTES + 1,
            },
          ],
        },
      }),
      download: async () => {
        downloaded = true;
        return { content: (async function* () {})() };
      },
    };

    const r = await imapFetchAttachment(MID, "report.pdf", {
      config: cfg,
      connect: async () => client,
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/25 MiB/i);
    expect(downloaded).toBe(false);
  });

  it("stops a streamed attachment when it crosses the fetch limit", async () => {
    const base = attClient();
    const client: ImapClientLike = {
      ...base,
      download: async () => ({
        content: (async function* () {
          yield Buffer.alloc(MAX_IMAP_ATTACHMENT_BYTES);
          yield Buffer.from([0]);
        })(),
      }),
    };

    const r = await imapFetchAttachment(MID, "report.pdf", {
      config: cfg,
      connect: async () => client,
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/25 MiB/i);
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

  it("imapUnreadCount defaults to INBOX (no cross-mailbox double-count) when none given", async () => {
    const n = await imapUnreadCount(undefined, {
      config: cfg,
      connect: async () =>
        statusClient({ INBOX: { unseen: 7 }, "[Gmail]/Sent Mail": { unseen: 2 } }),
    });
    // INBOX only — the old sum-all behaviour double-counted Gmail labels/All Mail.
    expect(n).toBe(7);
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

  it("dropAllPools logs out and clears every pooled connection (shutdown cleanup)", async () => {
    let connects = 0;
    let logouts = 0;
    __setPoolConnect(async () => {
      connects++;
      const c = makeClient([1], {});
      return {
        ...c,
        logout: async () => {
          logouts++;
        },
      };
    });
    const cfgA: ImapConfig = { ...cfg, user: "a@x.com" };
    const cfgB: ImapConfig = { ...cfg, user: "b@x.com" };
    await imapListMessages({ mailbox: "INBOX", limit: 5 }, { config: cfgA });
    await imapListMessages({ mailbox: "INBOX", limit: 5 }, { config: cfgB });
    expect(logouts).toBe(0); // both pooled, kept alive
    await dropAllPools(); // exactly what the server's shutdown handler now calls
    expect(logouts).toBe(2); // both pooled connections logged out on shutdown
    await imapListMessages({ mailbox: "INBOX", limit: 5 }, { config: cfgA });
    expect(connects).toBe(3); // pool was cleared → next call reconnects
  });

  it("force-closes the socket even when logout() rejects (CLOSE_WAIT leak fix)", async () => {
    let logouts = 0;
    let closes = 0;
    __setPoolConnect(async () => {
      const c = makeClient([1], {});
      return {
        ...c,
        logout: async () => {
          logouts++;
          throw new Error("socket half-closed — LOGOUT cannot complete");
        },
        close: () => {
          closes++;
        },
      };
    });
    await imapListMessages({ mailbox: "INBOX", limit: 5 }, { config: cfg });
    await dropAllPools(); // dropPool: logout() rejects (caught) → close() must still fire
    expect(logouts).toBe(1); // graceful logout was attempted
    expect(closes).toBe(1); // socket force-closed anyway → no leaked CLOSE_WAIT FD
  });

  it("closes the pooled connection after the idle window (at-rest → ZERO open sockets)", async () => {
    // Regression for the connection-footprint work: after the last read, the
    // pool's idle timer must fire and LOG OUT the connection, so an instance
    // that isn't actively serving IMAP holds no socket. Proven with fake timers
    // + a short idle window so the test is deterministic.
    vi.useFakeTimers();
    const prev = process.env.APPLE_MAIL_MCP_IMAP_IDLE_MS;
    process.env.APPLE_MAIL_MCP_IMAP_IDLE_MS = "1000";
    try {
      let logouts = 0;
      __setPoolConnect(async () => {
        const c = makeClient([1], {});
        return {
          ...c,
          logout: async () => {
            logouts++;
          },
        };
      });
      await imapListMessages({ mailbox: "INBOX", limit: 5 }, { config: cfg });
      expect(logouts).toBe(0); // still pooled immediately after the read
      await vi.advanceTimersByTimeAsync(1500); // cross the idle window
      expect(logouts).toBe(1); // idle timer fired → connection closed at rest
    } finally {
      if (prev === undefined) delete process.env.APPLE_MAIL_MCP_IMAP_IDLE_MS;
      else process.env.APPLE_MAIL_MCP_IMAP_IDLE_MS = prev;
      vi.useRealTimers();
    }
  });

  it("never closes the pooled connection when the idle window is disabled (0)", async () => {
    vi.useFakeTimers();
    const prev = process.env.APPLE_MAIL_MCP_IMAP_IDLE_MS;
    process.env.APPLE_MAIL_MCP_IMAP_IDLE_MS = "0"; // 0 = keep alive forever
    try {
      let logouts = 0;
      __setPoolConnect(async () => {
        const c = makeClient([1], {});
        return {
          ...c,
          logout: async () => {
            logouts++;
          },
        };
      });
      await imapListMessages({ mailbox: "INBOX", limit: 5 }, { config: cfg });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(logouts).toBe(0); // explicitly opted out of idle-close
    } finally {
      if (prev === undefined) delete process.env.APPLE_MAIL_MCP_IMAP_IDLE_MS;
      else process.env.APPLE_MAIL_MCP_IMAP_IDLE_MS = prev;
      vi.useRealTimers();
    }
  });

  it("single-flights concurrent connects for one account (no orphaned sockets)", async () => {
    let connects = 0;
    __setPoolConnect(async () => {
      connects++;
      await new Promise((r) => setTimeout(r, 20)); // make the two acquisitions overlap
      return makeClient([1], {});
    });
    // Two reads for the SAME account fired before either has connected.
    await Promise.all([
      imapListMessages({ mailbox: "INBOX", limit: 5 }, { config: cfg }),
      imapListMessages({ mailbox: "INBOX", limit: 5 }, { config: cfg }),
    ]);
    expect(connects).toBe(1); // one shared connection, not two orphaned sockets
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

describe("mail transport TLS policy", () => {
  it("requires STARTTLS for non-implicit IMAP connections", () => {
    expect(buildImapConnectionOptions({ ...cfg, secure: false })).toMatchObject({
      secure: false,
      doSTARTTLS: true,
    });
    expect(buildImapConnectionOptions(cfg)).toMatchObject({
      secure: true,
      doSTARTTLS: undefined,
    });
    expect(
      buildImapConnectionOptions({ ...cfg, secure: false, allowPlaintext: true })
    ).toMatchObject({
      secure: false,
      doSTARTTLS: undefined,
    });
  });
});

describe("plaintext escape hatch does not disable an offered STARTTLS upgrade", () => {
  const base = { host: "mail.example.com", port: 143, user: "u", pass: "p" };

  it("requires STARTTLS when the escape hatch is off", () => {
    expect(
      buildImapConnectionOptions({ ...base, secure: false, allowPlaintext: false }).doSTARTTLS
    ).toBe(true);
  });

  it("falls back to opportunistic (undefined), never false, when the escape hatch is on", () => {
    const opts = buildImapConnectionOptions({ ...base, secure: false, allowPlaintext: true });
    // `false` means "never STARTTLS even if advertised" — strictly weaker than the
    // pre-2.10.28 behaviour, where the option was absent and ImapFlow upgraded
    // opportunistically. The opt-out must not downgrade a server that still offers TLS.
    expect(opts.doSTARTTLS).not.toBe(false);
    expect(opts.doSTARTTLS).toBeUndefined();
  });

  it("never asks for STARTTLS on an implicit-TLS connection", () => {
    expect(
      buildImapConnectionOptions({ ...base, port: 993, secure: true, allowPlaintext: false })
        .doSTARTTLS
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #181: imapflow reports a server NO/BAD by RESOLVING to `false`, not by
// throwing (move.js:55, copy.js:42, store.js:96, expunge.js:55 all
// catch -> log.warn -> return false). Every one of these cases reported
// {success: true} before 2.12.0 because the result was discarded and the
// try/catch could never see the rejection.
// ---------------------------------------------------------------------------
describe("#181 IMAP mutations report a rejected command as a failure", () => {
  const ID = encodeImapId("acct", "INBOX", 5);

  it("move: a rejected MOVE fails loudly instead of reporting success", async () => {
    const client: ImapClientLike = {
      ...makeClient([], {}),
      messageMove: async () => false,
    };
    const r = await imapMoveMessageById(ID, "Archive", {
      config: cfg,
      connect: async () => client,
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/rejected the command/i);
  });

  it("delete: a rejected MOVE-to-Trash fails loudly", async () => {
    const client: ImapClientLike = {
      ...makeClient([], {}),
      list: async () => [{ path: "Trash", name: "Trash", specialUse: "\\Trash" }],
      messageMove: async () => false,
    };
    const r = await imapDeleteMessageById(ID, { config: cfg, connect: async () => client });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/rejected the command/i);
  });

  it("delete-from-Trash: a rejected EXPUNGE fails loudly", async () => {
    const client: ImapClientLike = {
      ...makeClient([], {}),
      list: async () => [{ path: "Trash", name: "Trash", specialUse: "\\Trash" }],
      messageDelete: async () => false,
    };
    const r = await imapDeleteMessageById(encodeImapId("acct", "Trash", 5), {
      config: cfg,
      connect: async () => client,
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/rejected the command/i);
  });

  it("batch move: a rejected MOVE counts the whole group as failed, not succeeded", async () => {
    const client: ImapClientLike = {
      ...makeClient([], {}),
      list: async () => [{ path: "Archive", name: "Archive" }],
      messageMove: async () => false,
    };
    const ids = [encodeImapId("acct", "INBOX", 5), encodeImapId("acct", "INBOX", 6)];
    const r = await imapBatchMove(ids, "Archive", { config: cfg, connect: async () => client });
    expect(r.success).toBe(0);
    expect(r.failed).toBe(2);
    expect(r.errors.join(" ")).toMatch(/rejected the command/i);
  });

  it("batch mark-read: a rejected STORE counts the group as failed", async () => {
    const client: ImapClientLike = {
      ...makeClient([], {}),
      messageFlagsAdd: async () => false,
    };
    const r = await imapBatchMarkRead([ID], { config: cfg, connect: async () => client });
    expect(r.success).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.errors.join(" ")).toMatch(/rejected the command/i);
  });

  it("batch unflag: a rejected STORE counts the group as failed", async () => {
    const client: ImapClientLike = {
      ...makeClient([], {}),
      messageFlagsRemove: async () => false,
    };
    const r = await imapBatchUnflag([ID], { config: cfg, connect: async () => client });
    expect(r.success).toBe(0);
    expect(r.failed).toBe(1);
  });

  it("batch delete: a rejected MOVE-to-Trash counts the group as failed", async () => {
    const client: ImapClientLike = {
      ...makeClient([], {}),
      list: async () => [{ path: "Trash", name: "Trash", specialUse: "\\Trash" }],
      messageMove: async () => false,
    };
    const r = await imapBatchDelete([ID], { config: cfg, connect: async () => client });
    expect(r.success).toBe(0);
    expect(r.failed).toBe(1);
  });

  // Guard against the design killed in review: uidMap/uidValidity are UIDPLUS-only,
  // so treating their ABSENCE as failure hard-fails every working move on a server
  // that does not advertise the extension. Only the falsy channel means failure.
  it("a UIDPLUS-less success (no uidMap) is still a success", async () => {
    const client: ImapClientLike = {
      ...makeClient([], {}),
      list: async () => [{ path: "Archive", name: "Archive" }],
      messageMove: async () => ({ path: "INBOX", destination: "Archive" }),
    };
    const r = await imapMoveMessageById(ID, "Archive", {
      config: cfg,
      connect: async () => client,
    });
    expect(r.success).toBe(true);
  });
});
