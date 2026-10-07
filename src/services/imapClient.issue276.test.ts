/**
 * #276 (@j5pu) — an unscoped IMAP `search-messages` over 32 iCloud mailboxes
 * ran 134-141s (Archive alone 96s) and held the serial gate the whole time;
 * `notifications/cancelled` did not stop it and there was no deadline.
 *
 * The fan-out now watches a stop signal (cancel or deadline): it abandons the
 * mailbox in flight by closing the connection under it, never starts the rest,
 * and returns what it found plus `timedOutMailboxes`.
 */
import { describe, it, expect, vi } from "vitest";
import {
  __resetPool,
  __setPoolConnect,
  imapSearchMessages,
  type ImapClientLike,
  type ImapConfig,
} from "@/services/imapClient.js";
import { fanOutImapMessages } from "@/services/imapMultiAccount.js";

const cfg: ImapConfig = {
  host: "imap.mail.me.com",
  port: 993,
  secure: true,
  user: "j@example.org",
  pass: "secret",
  accountLabel: "iCloud",
};

/**
 * Three mailboxes, no `\All`, so an unscoped search walks each one. INBOX
 * answers at once; Archive's SEARCH never answers until the socket is closed.
 */
function iCloudLike(opts: { onSearch?: (path: string) => void } = {}) {
  let rejectHung: ((e: Error) => void) | undefined;
  let current = "";
  const searched: string[] = [];
  const client = {
    connect: async () => undefined,
    getMailboxLock: async (path: string) => {
      current = path;
      return { release: () => undefined };
    },
    status: async (path: string) => ({ path, messages: 10 }),
    search: async () => {
      searched.push(current);
      opts.onSearch?.(current);
      if (current === "Archive") {
        return new Promise<number[]>((_, reject) => {
          rejectHung = reject;
        });
      }
      return [7];
    },
    fetch: async function* (range: string) {
      for (const uid of range.split(",").map(Number)) {
        yield {
          uid,
          envelope: {
            subject: `hit in ${current}`,
            date: new Date(2026, 0, 1),
            messageId: `<${current}-${uid}@x>`,
          },
          flags: new Set<string>(),
        };
      }
    },
    fetchOne: async () => false,
    list: async () => [
      { path: "INBOX", name: "INBOX" },
      { path: "Archive", name: "Archive", specialUse: "\\Archive" },
      { path: "Recovered", name: "Recovered" },
    ],
    noop: async () => undefined,
    logout: async () => undefined,
    close: vi.fn(() => rejectHung?.(new Error("Connection closed"))),
    takeLastCommandError: () => undefined,
  };
  return { client: client as unknown as ImapClientLike, raw: client, searched };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("#276 — a stopped IMAP search releases instead of running to completion", () => {
  it("abandons the mailbox in flight, skips the rest, and returns partial results", async () => {
    const ctrl = new AbortController();
    const { client, raw, searched } = iCloudLike({
      onSearch: (path) => {
        // The deadline fires while Archive's SEARCH is outstanding.
        if (path === "Archive")
          setTimeout(
            () =>
              ctrl.abort({
                kind: "deadline",
                deadlineMs: 45000,
                envVar: "APPLE_MAIL_MCP_SEARCH_DEADLINE_MS",
              }),
            5
          );
      },
    });

    const r = await imapSearchMessages(
      { query: "invoice" },
      { config: cfg, connect: async () => client, signal: ctrl.signal }
    );

    expect(searched).toEqual(["INBOX", "Archive"]); // Recovered never started
    expect(r.messages.map((m) => m.subject)).toEqual(["hit in INBOX"]);
    expect(r.partial).toBe(true);
    expect(r.timedOutMailboxes).toEqual(["Archive", "Recovered"]);
    expect(r.stoppedBy).toBe("deadline");
    expect(r.failedMailboxes).toEqual([]);
    // The hung command's connection was closed, not left holding the slot.
    expect(raw.close).toHaveBeenCalled();
    expect(r.text).toContain(
      "Stopped by the 45s search deadline (APPLE_MAIL_MCP_SEARCH_DEADLINE_MS)"
    );
    expect(r.text).toContain('"Archive", "Recovered"');
    expect(r.text).toContain('NOT a confirmed "no such mail"');
  });

  it("a request cancelled before the search starts searches nothing and says so", async () => {
    const ctrl = new AbortController();
    ctrl.abort({ kind: "cancelled" });
    const { client, searched } = iCloudLike();
    const r = await imapSearchMessages(
      { query: "invoice" },
      { config: cfg, connect: async () => client, signal: ctrl.signal }
    );
    expect(searched).toEqual([]);
    expect(r.count).toBe(0);
    expect(r.partial).toBe(true);
    expect(r.stoppedBy).toBe("cancelled");
    expect(r.timedOutMailboxes).toEqual(["INBOX", "Archive", "Recovered"]);
    expect(r.text).toContain("Stopped by the request being cancelled");
  });

  it("without a signal the search behaves exactly as before", async () => {
    const { client, searched } = iCloudLike();
    // Archive would hang forever, so give it a normal answer here.
    (client as unknown as { search: () => Promise<number[]> }).search = async () => {
      searched.push("x");
      return [7];
    };
    const r = await imapSearchMessages(
      { query: "invoice" },
      { config: cfg, connect: async () => client }
    );
    expect(r.partial).toBe(false);
    expect(r.timedOutMailboxes).toBeUndefined();
    expect(searched).toHaveLength(3);
  });

  it("the multi-account fan-out stops starting accounts once stopped", async () => {
    const ctrl = new AbortController();
    const first = iCloudLike({
      onSearch: (path) => {
        if (path === "Archive") setTimeout(() => ctrl.abort({ kind: "cancelled" }), 5);
      },
    });
    const second = iCloudLike();
    const connect = vi
      .fn()
      .mockImplementationOnce(async () => first.client)
      .mockImplementationOnce(async () => second.client);
    const fan = await fanOutImapMessages(
      { query: "invoice" },
      "search",
      { connect, signal: ctrl.signal },
      [cfg, { ...cfg, user: "w@example.org", accountLabel: "Work" }]
    );
    await tick();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(second.searched).toEqual([]);
    expect(fan.timedOutMailboxes).toEqual(["iCloud / Archive", "iCloud / Recovered", "Work / *"]);
    expect(fan.rows).toHaveLength(1);
  });

  it("pooled (production) path: the abandoned connection leaves the pool; the next call reconnects once", async () => {
    await __resetPool();
    const ctrl = new AbortController();
    const first = iCloudLike({
      onSearch: (path) => {
        if (path === "Archive") setTimeout(() => ctrl.abort({ kind: "cancelled" }), 5);
      },
    });
    const second = iCloudLike();
    (second.client as unknown as { search: () => Promise<number[]> }).search = async () => [7];
    const connect = vi
      .fn()
      .mockImplementationOnce(async () => first.client)
      .mockImplementationOnce(async () => second.client);
    __setPoolConnect(connect);
    try {
      const r1 = await imapSearchMessages({ query: "x" }, { config: cfg, signal: ctrl.signal });
      expect(r1.stoppedBy).toBe("cancelled");
      expect(first.raw.close).toHaveBeenCalled();
      // A fresh call does not reuse the closed socket — exactly one new connect.
      const r2 = await imapSearchMessages({ query: "x" }, { config: cfg });
      expect(r2.partial).toBe(false);
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      __setPoolConnect(null);
      await __resetPool();
    }
  });
});
