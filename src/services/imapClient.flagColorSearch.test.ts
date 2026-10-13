/**
 * Flag-color search filter and read-back on the IMAP route (#286, @j5pu).
 *
 * imapflow's SearchObject can carry at most one `keyword` and one `unKeyword`
 * per query object (a plain object literal can't repeat a key), but most
 * colors need 2-3 of those ANDed together (e.g. green = bit0 AND bit1 AND NOT
 * bit2). buildCriteria rewrites that AND as a single NOT/OR via De Morgan's
 * law — this pins down the exact shape sent to `client.search()` for a
 * representative color at each end of the palette, plus the read-back of
 * `flagColor` on a fetched row.
 */
import { describe, it, expect } from "vitest";
import {
  imapSearchMessages,
  imapListMessages,
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
  criteria?: Record<string, unknown>;
}

function makeClient(
  uids: number[],
  rec: Rec,
  flagsByUid: Map<number, Set<string>> = new Map()
): ImapClientLike {
  return {
    connect: async () => undefined,
    getMailboxLock: async () => ({ release: () => undefined }),
    mailbox: { path: "INBOX" },
    search: async (q: Record<string, unknown>) => {
      rec.criteria = q;
      return uids;
    },
    fetch: async function* (range: string) {
      for (const u of range.split(",").map(Number)) {
        yield {
          uid: u,
          envelope: {
            subject: `Subject ${u}`,
            date: new Date("2026-06-01T00:00:00Z"),
            from: [{ name: `Person ${u}`, address: `p${u}@example.com` }],
          },
          flags: flagsByUid.get(u) ?? new Set<string>(["\\Flagged"]),
        };
      }
    },
    fetchOne: async () => false,
    list: async () => [{ path: "INBOX", name: "INBOX" }],
    status: async (path: string) => ({ path, messages: uids.length, unseen: 0, recent: 0 }),
    download: async () => ({ meta: {}, content: (async function* () {})() }),
    mailboxCreate: async (path: string) => ({ path, created: true }),
    mailboxRename: async (path: string, newPath: string) => ({ path, newPath }),
    mailboxDelete: async (path: string) => ({ path }),
    append: async (path: string) => ({ destination: path }),
    messageFlagsAdd: async () => true,
    messageFlagsRemove: async () => true,
    messageMove: async () => ({}),
    messageDelete: async () => true,
    noop: async () => undefined,
    logout: async () => undefined,
  };
}

describe("buildCriteria flagColorIndex (via imapSearchMessages)", () => {
  it("green (3 = bit0+bit1): KEYWORD bit0, KEYWORD bit1, UNKEYWORD bit2, all ANDed via NOT/OR", async () => {
    const rec: Rec = {};
    await imapSearchMessages(
      { account: "rob@example.com", mailbox: "INBOX", flagColorIndex: 3, limit: 5 },
      { config: cfg, connect: async () => makeClient([1], rec) }
    );
    expect(rec.criteria).toEqual({
      deleted: false,
      flagged: true,
      not: {
        or: [
          { unKeyword: "$MailFlagBit0" },
          { unKeyword: "$MailFlagBit1" },
          { keyword: "$MailFlagBit2" },
        ],
      },
    });
  });

  it("red (0 = no bits set): three UNKEYWORD terms ANDed via NOT/OR", async () => {
    const rec: Rec = {};
    await imapSearchMessages(
      { account: "rob@example.com", mailbox: "INBOX", flagColorIndex: 0, limit: 5 },
      { config: cfg, connect: async () => makeClient([1], rec) }
    );
    expect(rec.criteria).toEqual({
      deleted: false,
      flagged: true,
      not: {
        or: [
          { keyword: "$MailFlagBit0" },
          { keyword: "$MailFlagBit1" },
          { keyword: "$MailFlagBit2" },
        ],
      },
    });
  });

  it("forces flagged: true even without an explicit isFlagged filter", async () => {
    const rec: Rec = {};
    await imapSearchMessages(
      { account: "rob@example.com", mailbox: "INBOX", flagColorIndex: 4, limit: 5 },
      { config: cfg, connect: async () => makeClient([1], rec) }
    );
    expect(rec.criteria?.flagged).toBe(true);
  });

  it("combines with other filters as plain sibling AND keys", async () => {
    const rec: Rec = {};
    await imapSearchMessages(
      {
        account: "rob@example.com",
        mailbox: "INBOX",
        flagColorIndex: 4,
        isRead: false,
        limit: 5,
      },
      { config: cfg, connect: async () => makeClient([1], rec) }
    );
    expect(rec.criteria).toMatchObject({ unseen: true, flagged: true });
  });
});

describe("structuredRow flagColor (read-back)", () => {
  it("surfaces the palette name alongside the legacy flagColorIndex", async () => {
    const rec: Rec = {};
    const flagsByUid = new Map([[1, new Set(["\\Flagged", "$MailFlagBit2"])]]); // blue
    const res = await imapSearchMessages(
      { account: "rob@example.com", mailbox: "INBOX", limit: 5 },
      { config: cfg, connect: async () => makeClient([1], rec, flagsByUid) }
    );
    expect(res.messages[0]).toMatchObject({ flagColorIndex: 4, flagColor: "blue" });
  });

  it("omits flagColor for an unflagged message", async () => {
    const rec: Rec = {};
    const flagsByUid = new Map([[1, new Set<string>()]]);
    const res = await imapSearchMessages(
      { account: "rob@example.com", mailbox: "INBOX", limit: 5 },
      { config: cfg, connect: async () => makeClient([1], rec, flagsByUid) }
    );
    expect(res.messages[0].flagColor).toBeUndefined();
    expect(res.messages[0].flagColorIndex).toBeUndefined();
  });

  it("list-messages rows carry flagColor the same way as search-messages", async () => {
    const rec: Rec = {};
    const flagsByUid = new Map([[1, new Set(["\\Flagged", "$MailFlagBit0", "$MailFlagBit1"])]]); // green
    const res = await imapListMessages(
      { account: "rob@example.com", mailbox: "INBOX", limit: 5 },
      { config: cfg, connect: async () => makeClient([1], rec, flagsByUid) }
    );
    expect(res.messages[0]).toMatchObject({ flagColorIndex: 3, flagColor: "green" });
  });
});
