/**
 * Flag-color search filter and read-back on the IMAP route (#286, @j5pu).
 *
 * The server-side SEARCH for a `flagColor` filter sends only `flagged: true`
 * — no `$MailFlagBit0/1/2` KEYWORD/UNKEYWORD terms. That compound clause
 * used to encode the exact color via a De Morgan NOT/OR, but on a real
 * iCloud account it cost a near-linear per-mailbox scan even ANDed with
 * FLAGGED, which blew the unscoped search's shared 45s deadline on one or
 * two huge mailboxes and starved every other mailbox of a chance to be
 * searched at all (follow-up to #286, @j5pu). The exact color is now decided
 * client-side (`filterUidsByColor`) from the flags every row fetch already
 * carries, on the much smaller FLAGGED-only candidate set.
 */
import { describe, it, expect } from "vitest";
import {
  imapSearchMessages,
  imapListMessages,
  mailFlagBitsFor,
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
  /** Every `fetch()` call's query shape, in call order (#286 follow-up). */
  fetchQueries?: Record<string, unknown>[];
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
    fetch: async function* (range: string, query: Record<string, unknown>) {
      (rec.fetchQueries ??= []).push(query);
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
  it("sends only flagged: true server-side — no $MailFlagBit keyword tree (#286 follow-up)", async () => {
    const rec: Rec = {};
    await imapSearchMessages(
      { account: "rob@example.com", mailbox: "INBOX", flagColorIndex: 3, limit: 5 },
      { config: cfg, connect: async () => makeClient([1], rec) }
    );
    expect(rec.criteria).toEqual({ deleted: false, flagged: true });
  });

  it("red (0) also sends only flagged: true — same cheap query as any other color", async () => {
    const rec: Rec = {};
    await imapSearchMessages(
      { account: "rob@example.com", mailbox: "INBOX", flagColorIndex: 0, limit: 5 },
      { config: cfg, connect: async () => makeClient([1], rec) }
    );
    expect(rec.criteria).toEqual({ deleted: false, flagged: true });
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

describe("flagColor filtering is client-side on the FLAGGED candidate set (#286 follow-up)", () => {
  it("returns only the messages actually carrying the requested color", async () => {
    const rec: Rec = {};
    const flagsByUid = new Map([
      [1, new Set(["\\Flagged", "$MailFlagBit2"])], // blue (4)
      [2, new Set(["\\Flagged", "$MailFlagBit0", "$MailFlagBit1"])], // green (3)
      [3, new Set(["\\Flagged"])], // plain/red
    ]);
    const res = await imapSearchMessages(
      { account: "rob@example.com", mailbox: "INBOX", flagColorIndex: 4, limit: 5 },
      { config: cfg, connect: async () => makeClient([1, 2, 3], rec, flagsByUid) }
    );
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]).toMatchObject({ flagColorIndex: 4, flagColor: "blue" });
  });

  it("red (0) matches a plain flagged message and excludes an explicitly colored one", async () => {
    const rec: Rec = {};
    const flagsByUid = new Map([
      [1, new Set(["\\Flagged"])], // plain/red — no $MailFlagBit set
      [2, new Set(["\\Flagged", "$MailFlagBit2"])], // blue — must NOT match red
    ]);
    const res = await imapSearchMessages(
      { account: "rob@example.com", mailbox: "INBOX", flagColorIndex: 0, limit: 5 },
      { config: cfg, connect: async () => makeClient([1, 2], rec, flagsByUid) }
    );
    expect(res.messages.map((m) => m.id)).toHaveLength(1);
    expect(res.messages[0].flagColor).toBeUndefined(); // inherent red/plain ambiguity, documented
  });

  it("a search with no color matches reports zero, not every flagged message", async () => {
    const rec: Rec = {};
    const flagsByUid = new Map([[1, new Set(["\\Flagged", "$MailFlagBit0"])]]); // orange (1)
    const res = await imapSearchMessages(
      { account: "rob@example.com", mailbox: "INBOX", flagColorIndex: 4, limit: 5 }, // blue
      { config: cfg, connect: async () => makeClient([1], rec, flagsByUid) }
    );
    expect(res.messages).toHaveLength(0);
    expect(res.text).toContain("No messages found");
  });

  it("narrows with a flags-only fetch before the full row fetch for the page", async () => {
    const rec: Rec = {};
    const flagsByUid = new Map([
      [1, new Set(["\\Flagged", "$MailFlagBit2"])], // blue — matches
      [2, new Set(["\\Flagged"])], // plain — excluded
    ]);
    await imapSearchMessages(
      { account: "rob@example.com", mailbox: "INBOX", flagColorIndex: 4, limit: 5 },
      { config: cfg, connect: async () => makeClient([1, 2], rec, flagsByUid) }
    );
    expect(rec.fetchQueries).toBeDefined();
    // The narrowing pass asks only for flags — never envelope/bodyStructure —
    // so it stays cheap regardless of how many messages are FLAGGED.
    const narrowing = rec.fetchQueries!.find(
      (q) => q.flags === true && !("envelope" in q) && !("bodyStructure" in q)
    );
    expect(narrowing).toBeDefined();
    // A separate, full-row fetch still happens for the page itself.
    const fullRow = rec.fetchQueries!.find((q) => "envelope" in q && "bodyStructure" in q);
    expect(fullRow).toBeDefined();
  });
});

describe("flagColor narrowing keeps each FETCH command short", () => {
  it("fetches the flags of many candidates in slices, not one command line", async () => {
    const uids = Array.from({ length: 1200 }, (_, i) => i + 1);
    const base = makeClient(uids, {});
    const ranges: string[] = [];
    const client: ImapClientLike = {
      ...base,
      fetch: ((range: string, query: Record<string, unknown>, opts: unknown) => {
        if (!("envelope" in query)) ranges.push(range);
        return (base.fetch as (r: string, q: unknown, o: unknown) => AsyncIterable<unknown>)(
          range,
          query,
          opts
        );
      }) as ImapClientLike["fetch"],
    };
    const res = await imapSearchMessages(
      { account: "rob@example.com", mailbox: "INBOX", flagColorIndex: 0, limit: 5 },
      { config: cfg, connect: async () => client }
    );
    expect(ranges.length).toBeGreaterThan(1);
    expect(ranges.every((r) => r.split(",").length <= 500)).toBe(true);
    expect(ranges.join(",").split(",")).toHaveLength(1200);
    expect(res.messages.length).toBeGreaterThan(0);
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

describe("flagColor filtering on a large (>LARGE_MAILBOX_MESSAGES) mailbox (#286 follow-up, @j5pu)", () => {
  // Reproduces the reported shape: a huge iCloud mailbox, searched for one
  // flag color with no `mailbox` scope reaching this one via the per-mailbox
  // fan-out in `run()`. The per-window SEARCH must stay FLAGGED-only — never
  // the old $MailFlagBit NOT/OR tree — which is what let every window finish
  // fast instead of exhausting the shared search deadline.
  const EXISTS = 50_000;
  const uidOf = (seq: number) => seq; // simple 1:1 for this test

  function bigColorMailbox(seqColorIndex: Map<number, number | undefined>) {
    const searchCriteria: Record<string, unknown>[] = [];
    return {
      client: {
        connect: async () => undefined,
        getMailboxLock: async () => ({ release: () => undefined }),
        status: async (path: string) => ({ path, messages: EXISTS }),
        search: async (criteria: Record<string, unknown>) => {
          searchCriteria.push(criteria);
          const [lo, hiRaw] = String(criteria.seq).split(":");
          const hi = hiRaw === "*" ? EXISTS : Number(hiRaw);
          const out: number[] = [];
          for (let s = Number(lo); s <= hi; s++) out.push(uidOf(s)); // FLAGGED: every seq "flagged"
          return out;
        },
        fetch: async function* (range: string) {
          for (const n of range.split(",").map(Number)) {
            const idx = seqColorIndex.get(n);
            yield {
              uid: uidOf(n),
              envelope: { subject: `seq ${n}`, date: new Date(2026, 0, 1) },
              // Same bit encoding production code uses, not a naive "$MailFlagBit${idx}"
              // (idx is a bitmask, not a bit position — e.g. green=3 sets bit0+bit1).
              flags:
                idx === undefined
                  ? new Set(["\\Flagged"])
                  : new Set(["\\Flagged", ...mailFlagBitsFor(idx).set]),
            };
          }
        },
        fetchOne: async () => false,
        list: async () => [{ path: "Archive", name: "Archive", specialUse: "\\Archive" }],
        noop: async () => undefined,
        logout: async () => undefined,
      } as unknown as ImapClientLike,
      searchCriteria,
    };
  }

  it("is well above the large-mailbox threshold", () => {
    expect(EXISTS).toBeGreaterThan(50_000 - 1);
  });

  it("every per-window SEARCH is FLAGGED-only, never a $MailFlagBit keyword tree", async () => {
    const { client, searchCriteria } = bigColorMailbox(
      new Map([[EXISTS, 4 /* blue */]]) // one match, right at the top
    );
    await imapSearchMessages(
      { mailbox: "Archive", flagColorIndex: 4, limit: 5 },
      { config: cfg, connect: async () => client }
    );
    expect(searchCriteria.length).toBeGreaterThan(0);
    for (const c of searchCriteria) {
      expect(c).toMatchObject({ deleted: false, flagged: true });
      expect(c.not).toBeUndefined();
      expect(c.keyword).toBeUndefined();
      expect(c.unKeyword).toBeUndefined();
    }
  });

  it("finds a single matching message near the bottom without exhausting a KEYWORD-tree budget", async () => {
    // The scenario reported live: a small match far from the top of a huge
    // mailbox, which the old compound-keyword query risked never reaching
    // before a shared deadline elapsed.
    const target = 7; // near the very bottom
    const { client } = bigColorMailbox(new Map([[target, 1 /* orange */]]));
    const res = await imapSearchMessages(
      { mailbox: "Archive", flagColorIndex: 1, limit: 5 },
      { config: cfg, connect: async () => client }
    );
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]).toMatchObject({ flagColorIndex: 1, flagColor: "orange" });
  });
});
