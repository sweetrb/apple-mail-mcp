/**
 * #256 (@j5pu) — an unfiltered `list-messages` with `limit: 1` failed on
 * 793,614- and 255,104-message iCloud mailboxes ("IMAP list failed in every
 * requested mailbox"), while a 25k one worked: every list ran a whole-mailbox
 * `UID SEARCH` before applying limit/offset. Large mailboxes are now read
 * top-down by sequence number, and a failed SEARCH says why.
 */
import { describe, it, expect, vi } from "vitest";
import {
  decodeImapId,
  imapListMessages,
  imapSearchMessages,
  LARGE_MAILBOX_MESSAGES,
  type ImapClientLike,
  type ImapConfig,
} from "@/services/imapClient.js";

const cfg: ImapConfig = {
  host: "imap.mail.me.com",
  port: 993,
  secure: true,
  user: "j@example.org",
  pass: "secret",
  accountLabel: "iCloud",
};

const EXISTS = 800_000;
/** Sparse, ascending UIDs, as on a real long-lived mailbox. */
const uidOf = (seq: number) => 1_000_000 + seq * 3;

interface Log {
  searches: Record<string, unknown>[];
  seqFetches: string[];
  uidFetches: string[];
  seqRowsReturned: number;
}

/**
 * An 800k-message mailbox that keeps `\Deleted`-but-not-expunged messages in
 * its sequence space (standard IMAP; iCloud leaves them out). `deleted` names
 * the ghost sequence numbers; `unseen(seq)` drives filtered searches.
 */
function bigMailbox(
  log: Log,
  opts: {
    deleted?: Set<number>;
    unseen?: (seq: number) => boolean;
    search?: ImapClientLike["search"];
    /** Make SEARCH fail the way imapflow does: log the error, resolve `false`. */
    searchFailsWith?: unknown;
  } = {}
): ImapClientLike {
  const deleted = opts.deleted ?? new Set<number>();
  const unseen = opts.unseen ?? (() => false);
  const seqOfUid = (uid: number) => (uid - 1_000_000) / 3;
  let lastError: unknown;
  const parseRange = (range: string): [number, number] => {
    const [a, b] = range.split(":");
    const lo = Number(a);
    const hi = b === "*" ? EXISTS : Number(b ?? a);
    return [Math.min(lo, hi), Math.max(lo, hi)];
  };
  return {
    connect: async () => undefined,
    getMailboxLock: async () => ({ release: () => undefined }),
    status: async (path: string) => ({ path, messages: EXISTS }),
    search:
      opts.search ??
      (async (criteria: Record<string, unknown>) => {
        if (opts.searchFailsWith !== undefined) {
          lastError = opts.searchFailsWith;
          return false;
        }
        log.searches.push(criteria);
        // A whole-mailbox enumeration is exactly what #256 must never do on a
        // mailbox this size — fail the test loudly rather than build 800k UIDs.
        if (typeof criteria.seq !== "string") throw new Error("whole-mailbox SEARCH issued");
        const [lo, hi] = parseRange(criteria.seq);
        const out: number[] = [];
        for (let s = lo; s <= hi; s++) {
          if (criteria.deleted === false && deleted.has(s)) continue;
          if (criteria.unseen === true && !unseen(s)) continue;
          out.push(uidOf(s));
        }
        return out;
      }),
    fetch: async function* (range: string, _query: Record<string, unknown>, o?: { uid?: boolean }) {
      if (o?.uid) {
        log.uidFetches.push(range);
        for (const uid of range.split(",").map(Number)) {
          yield {
            uid,
            envelope: { subject: `seq ${seqOfUid(uid)}`, date: new Date(2026, 0, 1) },
            flags: new Set<string>(),
          };
        }
        return;
      }
      log.seqFetches.push(range);
      const [lo, hi] = parseRange(range);
      for (let s = lo; s <= hi; s++) {
        log.seqRowsReturned++;
        yield {
          uid: uidOf(s),
          flags: new Set<string>(deleted.has(s) ? ["\\Deleted", "\\Seen"] : ["\\Seen"]),
        };
      }
    },
    fetchOne: async () => false,
    list: async () => [{ path: "Archive", name: "Archive", specialUse: "\\Archive" }],
    noop: async () => undefined,
    logout: async () => undefined,
    takeLastCommandError: () => {
      const e = lastError;
      lastError = undefined;
      return e;
    },
  } as unknown as ImapClientLike;
}

const newLog = (): Log => ({ searches: [], seqFetches: [], uidFetches: [], seqRowsReturned: 0 });
const uids = (res: { messages: Record<string, unknown>[] }) =>
  res.messages.map((m) => decodeImapId(m.id as string)?.uid);

describe("#256 list-messages on an 800k-message mailbox", () => {
  it("is well above the large-mailbox threshold", () => {
    expect(EXISTS).toBeGreaterThan(LARGE_MAILBOX_MESSAGES);
  });

  it("limit 1 returns the newest message without any SEARCH", async () => {
    const log = newLog();
    const res = await imapListMessages(
      { mailbox: "Archive", limit: 1 },
      { config: cfg, connect: async () => bigMailbox(log) }
    );
    expect(res.partial).toBe(false);
    expect(uids(res)).toEqual([uidOf(EXISTS)]);
    expect(log.searches).toEqual([]);
    // One small flags-only window, addressed from the top with `*`.
    expect(log.seqFetches).toHaveLength(1);
    expect(log.seqFetches[0]).toMatch(/^\d+:\*$/);
    expect(log.seqRowsReturned).toBeLessThan(100);
    // Full rows only for the page itself.
    expect(log.uidFetches).toEqual([String(uidOf(EXISTS))]);
    expect(res.text).toContain("800000 total listed");
  });

  it("limit + offset pages newest-first by sequence number", async () => {
    const log = newLog();
    const res = await imapListMessages(
      { mailbox: "Archive", limit: 5, offset: 10 },
      { config: cfg, connect: async () => bigMailbox(log) }
    );
    const want = [10, 11, 12, 13, 14].map((k) => uidOf(EXISTS - k));
    expect(uids(res)).toEqual(want);
    // The 10 skipped messages are never fetched in full.
    expect(log.uidFetches).toEqual([want.join(",")]);
    expect(log.searches).toEqual([]);
  });

  it("a deep offset walks bounded windows and stays exact", async () => {
    const log = newLog();
    const res = await imapListMessages(
      { mailbox: "Archive", limit: 2, offset: 100_000 },
      { config: cfg, connect: async () => bigMailbox(log) }
    );
    expect(uids(res)).toEqual([uidOf(EXISTS - 100_000), uidOf(EXISTS - 100_001)]);
    for (const r of log.seqFetches) {
      const [a, b] = r.split(":");
      const hi = b === "*" ? EXISTS : Number(b);
      expect(hi - Number(a) + 1).toBeLessThanOrEqual(50_000);
    }
    expect(log.seqRowsReturned).toBeLessThan(200_000);
  });

  it("skips interleaved \\Deleted ghosts, including a run of them at the top", async () => {
    const deleted = new Set<number>();
    for (let s = EXISTS; s > EXISTS - 300; s--) deleted.add(s); // 300 ghosts on top
    for (let s = EXISTS - 300; s > EXISTS - 400; s -= 2) deleted.add(s); // then every other one
    const log = newLog();
    const res = await imapListMessages(
      { mailbox: "Archive", limit: 3, offset: 2 },
      { config: cfg, connect: async () => bigMailbox(log, { deleted }) }
    );
    // Live messages from the top: 799699, 799697, 799695, 799693, 799691, …
    expect(uids(res)).toEqual([799_695, 799_693, 799_691].map(uidOf));
    expect(log.seqFetches.length).toBeGreaterThan(1); // the first window was all ghosts
    for (const uid of uids(res)) expect(deleted.has(((uid as number) - 1_000_000) / 3)).toBe(false);
  });
});

describe("#256 filtered searches on an 800k-message mailbox", () => {
  it("searches newest-first sequence windows, never the whole mailbox", async () => {
    const log = newLog();
    const deleted = new Set([EXISTS - 3]);
    const res = await imapListMessages(
      { mailbox: "Archive", unreadOnly: true, limit: 4 },
      {
        config: cfg,
        connect: async () =>
          bigMailbox(log, { deleted, unseen: (s) => s % 1000 === 0 || s === EXISTS - 3 }),
      }
    );
    expect(uids(res)).toEqual([EXISTS, EXISTS - 1000, EXISTS - 2000, EXISTS - 3000].map(uidOf));
    expect(log.searches[0]).toMatchObject({
      deleted: false,
      unseen: true,
      seq: `${EXISTS - 4999}:*`,
    });
    for (const c of log.searches) expect(typeof c.seq).toBe("string");
    // Filled from the first window, so the total is only a lower bound.
    expect(res.text).toContain("at least 5 total listed");
  });

  it("a narrow filter keeps widening windows and reports an exact total at the bottom", async () => {
    const log = newLog();
    const res = await imapSearchMessages(
      { mailbox: "Archive", isRead: false, limit: 50 },
      {
        config: cfg,
        connect: async () => bigMailbox(log, { unseen: (s) => s === 7 || s === 400_000 }),
      }
    );
    expect(uids(res)).toEqual([uidOf(400_000), uidOf(7)]);
    expect(res.text).toContain("2 total matched");
    // Windows grow ×4 to a 50k ceiling and never overlap.
    const widths = log.searches.map((c) => {
      const [a, b] = String(c.seq).split(":");
      return (b === "*" ? EXISTS : Number(b)) - Number(a) + 1;
    });
    expect(widths.slice(0, 3)).toEqual([5_000, 20_000, 50_000]);
    expect(Math.max(...widths)).toBe(50_000);
    expect(widths.reduce((a, b) => a + b, 0)).toBe(EXISTS);
  });

  it("refuses a window that reports more matches than it holds (#246 guard)", async () => {
    const log = newLog();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      imapListMessages(
        { mailbox: "Archive", unreadOnly: true, limit: 1 },
        {
          config: cfg,
          connect: async () =>
            bigMailbox(log, { search: async () => Array.from({ length: 6_000 }, (_, i) => i + 1) }),
        }
      )
    ).rejects.toThrow(/reported 6000 matches in a 5000-message window/);
    errSpy.mockRestore();
  });
});

describe("#256 a failed SEARCH is an error that names its cause", () => {
  const errSpy = () => vi.spyOn(console, "error").mockImplementation(() => undefined);

  it("surfaces the error imapflow swallowed, with the mailbox size", async () => {
    const spy = errSpy();
    const cause = Object.assign(new Error("Command failed"), {
      responseStatus: "NO",
      responseText: "Search result too large",
    });
    await expect(
      imapSearchMessages(
        { mailbox: "Archive", from: "x@example.com", limit: 1 },
        {
          config: cfg,
          connect: async () => bigMailbox(newLog(), { searchFailsWith: cause }),
        }
      )
    ).rejects.toThrow(
      /IMAP search failed in every requested mailbox.*Archive \(IMAP SEARCH on "Archive" \(800,000 messages\) failed: NO Search result too large\)/
    );
    spy.mockRestore();
  });

  it("names a likely timeout when the connection dropped without a server reply", async () => {
    const spy = errSpy();
    await expect(
      imapSearchMessages(
        { mailbox: "Archive", from: "x@example.com", limit: 1 },
        { config: cfg, connect: async () => bigMailbox(newLog(), { search: async () => false }) }
      )
    ).rejects.toThrow(/800,000 messages\) failed: .*connection dropped.*timeout/);
    spy.mockRestore();
  });

  it("a small mailbox's failed SEARCH is no longer reported as 'no messages'", async () => {
    const spy = errSpy();
    const client = {
      ...bigMailbox(newLog(), { search: async () => false }),
      status: async (path: string) => ({ path, messages: 40 }),
    } as ImapClientLike;
    await expect(
      imapListMessages({ mailbox: "INBOX", limit: 5 }, { config: cfg, connect: async () => client })
    ).rejects.toThrow(/IMAP SEARCH on "INBOX" \(40 messages\) failed/);
    spy.mockRestore();
  });

  it("a FETCH failure while paging a large mailbox names the mailbox and its size", async () => {
    const spy = errSpy();
    const client = {
      ...bigMailbox(newLog()),
      // eslint-disable-next-line require-yield
      fetch: async function* () {
        throw new Error("Socket timeout");
      },
    } as unknown as ImapClientLike;
    await expect(
      imapListMessages(
        { mailbox: "Archive", limit: 1 },
        { config: cfg, connect: async () => client }
      )
    ).rejects.toThrow(/"Archive" \(800,000 messages\) failed: Socket timeout/);
    spy.mockRestore();
  });
});
