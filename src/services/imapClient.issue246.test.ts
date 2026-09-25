/**
 * #246 (@j5pu, 2026-09-25 follow-up) — iCloud's `UID SEARCH ALL` returns
 * `\Deleted`-but-never-expunged UIDs that EXISTS, STATUS and FETCH all
 * exclude: 100,011 UIDs for a 48-message INBOX. Every filter-less
 * list-messages (and every isRead/unreadOnly-only search) tripped the 2.19.11
 * STATUS guard and failed. Enumerating searches now always carry UNDELETED.
 */
import { describe, it, expect } from "vitest";
import {
  imapListMessages,
  imapMailStats,
  imapSearchMessages,
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

const REAL = Array.from({ length: 48 }, (_, i) => 524_300 + i);
const GHOSTS = Array.from({ length: 2_000 }, (_, i) => 100 + i); // \Deleted, never expunged

/** Behaves like the iCloud server @j5pu captured. */
function icloudLike(seen: Record<string, unknown>[]): ImapClientLike {
  return {
    connect: async () => undefined,
    getMailboxLock: async () => ({ release: () => undefined }),
    search: async (criteria: Record<string, unknown>) => {
      seen.push(criteria);
      // Flag-only criteria include the ghosts unless UNDELETED is present.
      return criteria.deleted === false ? REAL : [...GHOSTS, ...REAL];
    },
    fetch: async function* (range: string) {
      const live = new Set(REAL);
      for (const uid of range.split(",").map(Number)) {
        if (live.has(uid))
          yield { uid, envelope: { subject: `m${uid}` }, flags: new Set() } as never;
      }
    },
    fetchOne: async () => false,
    list: async () => [{ path: "INBOX", name: "INBOX", specialUse: "\\Inbox" }],
    status: async (path: string) => ({ path, messages: REAL.length, unseen: 0, recent: 0 }),
    noop: async () => undefined,
    logout: async () => undefined,
  } as unknown as ImapClientLike;
}

describe("#246 enumerating searches exclude \\Deleted, never-expunged messages", () => {
  it("a filter-less list-messages on INBOX succeeds with the real count", async () => {
    const seen: Record<string, unknown>[] = [];
    const res = await imapListMessages(
      { mailbox: "INBOX", limit: 5 },
      { config: cfg, connect: async () => icloudLike(seen) }
    );
    expect(seen[0]).toEqual({ deleted: false });
    expect(res.partial).toBe(false);
    expect(res.text).toContain("48");
    expect(res.messages).toHaveLength(5);
  });

  it("unreadOnly / isRead searches carry UNDELETED too", async () => {
    const seen: Record<string, unknown>[] = [];
    const deps = { config: cfg, connect: async () => icloudLike(seen) };
    await imapListMessages({ mailbox: "INBOX", unreadOnly: true, limit: 5 }, deps);
    await imapSearchMessages({ mailbox: "INBOX", isRead: true, limit: 5 }, deps);
    expect(seen).toEqual([
      { deleted: false, unseen: true },
      { deleted: false, seen: true },
    ]);
  });

  it("mail-stats recent counts carry UNDELETED", async () => {
    const seen: Record<string, unknown>[] = [];
    await imapMailStats({ config: cfg, connect: async () => icloudLike(seen) });
    expect(seen.length).toBeGreaterThan(0);
    for (const c of seen) expect(c.deleted).toBe(false);
  });
});
