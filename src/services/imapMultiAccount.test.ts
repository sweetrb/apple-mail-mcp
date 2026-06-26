import { describe, it, expect } from "vitest";
import {
  dedupKey,
  mergeMessages,
  configMatchesAccount,
  isAccountCoveredByImap,
  partitionAccountsForCounts,
  planCountSources,
  fanOutImapMessages,
  isGmailHost,
  formatMergedRows,
  type MessageRow,
} from "@/services/imapMultiAccount.js";
import type { ImapClientLike, ImapConfig } from "@/services/imapClient.js";
import type { Account } from "@/types.js";

// A minimal IMAP client mock (mirrors imapClient.test.ts) that server-side
// "searches" for the given uids and yields one envelope per uid.
function makeClient(uids: number[], messageIdByUid?: Record<number, string>): ImapClientLike {
  return {
    connect: async () => undefined,
    getMailboxLock: async () => ({ release: () => undefined }),
    search: async () => uids,
    fetch: async function* (range: string) {
      for (const u of range.split(",").map(Number)) {
        yield {
          uid: u,
          envelope: {
            subject: `Subject ${u}`,
            date: new Date("2026-06-01T00:00:00Z"),
            from: [{ name: `Person ${u}`, address: `p${u}@example.com` }],
            ...(messageIdByUid?.[u] ? { messageId: messageIdByUid[u] } : {}),
          },
          flags: new Set<string>(),
        };
      }
    },
    fetchOne: async () => false,
    list: async () => [],
    status: async (path: string) => ({ path, messages: 0, unseen: 0, recent: 0 }),
    download: async () => ({ meta: {}, content: (async function* () {})() }),
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

const cfgA: ImapConfig = {
  host: "imap.gmail.com",
  port: 993,
  secure: true,
  user: "a@gmail.com",
  pass: "x",
  accountLabel: "Personal",
};
const cfgB: ImapConfig = {
  host: "imap.work.com",
  port: 993,
  secure: true,
  user: "b@work.com",
  pass: "x",
  accountLabel: "Work",
};

function row(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "imap:abc",
    subject: "Hello",
    sender: "Alice <alice@x.com>",
    dateReceived: "2026-06-01T00:00:00.000Z",
    isRead: false,
    ...over,
  };
}

describe("dedupKey", () => {
  it("prefers a normalized Message-ID (case/brackets-insensitive)", () => {
    expect(dedupKey(row({ messageId: "<ABC@host>" }))).toBe(
      dedupKey(row({ messageId: "abc@host" }))
    );
    expect(dedupKey(row({ messageId: "<ABC@host>" }))).toBe("mid:abc@host");
  });

  it("falls back to subject|sender|dateEpoch when no Message-ID", () => {
    const k = dedupKey(row());
    expect(k.startsWith("k:")).toBe(true);
    // Re/Fwd prefixes are normalized away → same key.
    expect(dedupKey(row({ subject: "Re: Hello" }))).toBe(k);
    expect(dedupKey(row({ subject: "FWD: Hello" }))).toBe(k);
  });

  it("differs when sender or date differs", () => {
    expect(dedupKey(row({ sender: "Bob <bob@x.com>" }))).not.toBe(dedupKey(row()));
    expect(dedupKey(row({ dateReceived: "2026-06-02T00:00:00.000Z" }))).not.toBe(dedupKey(row()));
  });
});

describe("mergeMessages", () => {
  it("dedups a message present in BOTH IMAP and AppleScript, preferring the IMAP copy", () => {
    // Same subject/sender/date in both backends, but distinct ids: IMAP id wins.
    const imapRow = row({ id: "imap:WIN" });
    const appleRow = row({ id: "12345" });
    const merged = mergeMessages([imapRow], [appleRow], 50);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("imap:WIN");
  });

  it("keeps distinct messages and sorts newest-first, applying the limit", () => {
    const a = row({ id: "imap:a", subject: "A", dateReceived: "2026-06-01T00:00:00.000Z" });
    const b = row({ id: "imap:b", subject: "B", dateReceived: "2026-06-03T00:00:00.000Z" });
    const c = row({ id: "12", subject: "C", dateReceived: "2026-06-02T00:00:00.000Z" });
    const merged = mergeMessages([a, b], [c], 2);
    expect(merged.map((m) => m.id)).toEqual(["imap:b", "12"]); // newest-first, limit 2 drops the oldest
  });

  it("dedups two IMAP copies of one message via Message-ID", () => {
    const fromA = row({ id: "imap:A", messageId: "<same@host>", account: "Personal" });
    const fromB = row({ id: "imap:B", messageId: "<same@host>", account: "Work" });
    const merged = mergeMessages([fromA, fromB], [], 50);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("imap:A");
  });
});

describe("fanOutImapMessages", () => {
  it("fans the IMAP query out over EVERY configured IMAP account and concatenates rows", async () => {
    const seen: string[] = [];
    const res = await fanOutImapMessages(
      { query: "the", limit: 50 },
      "search",
      {
        connect: async (cfg) => {
          seen.push(cfg.accountLabel);
          // Personal returns uid 1, Work returns uid 2 → distinct rows.
          return makeClient(cfg.accountLabel === "Personal" ? [1] : [2]);
        },
      },
      [cfgA, cfgB]
    );
    expect(seen.sort()).toEqual(["Personal", "Work"]);
    expect(res.accountsQueried.sort()).toEqual(["Personal", "Work"]);
    expect(res.accountsFailed).toEqual([]);
    expect(res.rows).toHaveLength(2);
    expect(res.rows.map((r) => r.account).sort()).toEqual(["Personal", "Work"]);
  });

  it("records a failed account instead of throwing the whole read", async () => {
    const res = await fanOutImapMessages(
      { query: "x", limit: 50 },
      "list",
      {
        connect: async (cfg) => {
          if (cfg.accountLabel === "Work") throw new Error("auth failed");
          return makeClient([1]);
        },
      },
      [cfgA, cfgB]
    );
    expect(res.accountsQueried).toEqual(["Personal"]);
    expect(res.accountsFailed).toEqual(["Work"]);
    expect(res.rows).toHaveLength(1);
  });

  it("defaults the mailbox PER HOST when none is pinned (Gmail→All Mail, others→INBOX)", async () => {
    // Regression guard: a no-mailbox search must NOT fan Gmail's "[Gmail]/All Mail"
    // out to a non-Gmail account (e.g. iCloud), where that SELECT fails and the
    // account silently drops from the merged results.
    const selectedPath: Record<string, string> = {};
    await fanOutImapMessages(
      { query: "x", limit: 10 }, // no mailbox pinned
      "search",
      {
        connect: async (cfg) => {
          const client = makeClient([1]);
          client.getMailboxLock = async (path: string) => {
            selectedPath[cfg.accountLabel] = path;
            return { release: () => undefined };
          };
          return client;
        },
      },
      [cfgA, cfgB] // cfgA host=imap.gmail.com, cfgB host=imap.work.com
    );
    expect(selectedPath.Personal).toBe("[Gmail]/All Mail"); // Gmail host → All Mail
    expect(selectedPath.Work).toBe("INBOX"); // non-Gmail host → universal INBOX
  });

  it("honors an explicitly pinned mailbox for every account (no per-host override)", async () => {
    const selectedPath: Record<string, string> = {};
    await fanOutImapMessages(
      { query: "x", mailbox: "INBOX", limit: 10 },
      "search",
      {
        connect: async (cfg) => {
          const client = makeClient([1]);
          client.getMailboxLock = async (path: string) => {
            selectedPath[cfg.accountLabel] = path;
            return { release: () => undefined };
          };
          return client;
        },
      },
      [cfgA, cfgB]
    );
    expect(selectedPath.Personal).toBe("INBOX");
    expect(selectedPath.Work).toBe("INBOX");
  });
});

describe("isGmailHost", () => {
  it("matches gmail.com and its subdomains (Workspace), not look-alikes", () => {
    expect(isGmailHost("imap.gmail.com")).toBe(true);
    expect(isGmailHost("gmail.com")).toBe(true);
    expect(isGmailHost("imap.mail.me.com")).toBe(false); // iCloud
    expect(isGmailHost("imap.work.com")).toBe(false);
    expect(isGmailHost("notgmail.com.evil.com")).toBe(false);
  });
});

describe("isAccountCoveredByImap / partitionAccountsForCounts (no double-count)", () => {
  const accounts: Account[] = [
    { name: "Personal", email: "a@gmail.com", enabled: true },
    { name: "Work", email: "b@work.com", enabled: true },
    { name: "Exchange", email: "c@corp.com", enabled: true }, // NOT IMAP-configured
  ];

  it("matches a Mail account by label==name", () => {
    expect(isAccountCoveredByImap(accounts[0], [cfgA])).toBe(true); // label "Personal" == name
  });

  it("matches a Mail account by user==email even when label differs", () => {
    const cfg: ImapConfig = { ...cfgA, accountLabel: "freeform-label" };
    expect(isAccountCoveredByImap(accounts[0], [cfg])).toBe(true); // user a@gmail.com == email
  });

  it("does not match an account no config covers", () => {
    expect(isAccountCoveredByImap(accounts[2], [cfgA, cfgB])).toBe(false);
  });

  it("partitions so IMAP-covered accounts are counted via IMAP only", () => {
    const { imapCovered, appleScriptOnly } = partitionAccountsForCounts(accounts, [cfgA, cfgB]);
    expect(imapCovered.map((a) => a.name).sort()).toEqual(["Personal", "Work"]);
    expect(appleScriptOnly.map((a) => a.name)).toEqual(["Exchange"]);
  });

  it("ALL accounts IMAP-covered → appleScriptOnly is EMPTY (message lists run zero AppleScript)", () => {
    // The maintainer's worst case: every Mail account is IMAP-configured. The
    // message-list sites iterate appleScriptOnly to drive the AppleScript scan,
    // so an empty partition here means ZERO AppleScript work and no reliance on
    // the composite dedup.
    const allImap: Account[] = [accounts[0], accounts[1]]; // Personal + Work, both covered
    const { imapCovered, appleScriptOnly } = partitionAccountsForCounts(allImap, [cfgA, cfgB]);
    expect(appleScriptOnly).toEqual([]);
    expect(imapCovered).toHaveLength(2);
  });

  it("when IMAP covers nothing, all accounts fall to AppleScript", () => {
    const { imapCovered, appleScriptOnly } = partitionAccountsForCounts(accounts, []);
    expect(imapCovered).toEqual([]);
    expect(appleScriptOnly).toHaveLength(3);
  });

  it("configMatchesAccount is the per-pair matcher (label/user vs name/email)", () => {
    expect(configMatchesAccount(cfgA, accounts[0])).toBe(true); // Personal
    expect(configMatchesAccount(cfgA, accounts[1])).toBe(false); // Work
    expect(configMatchesAccount({ ...cfgA, accountLabel: "x" }, accounts[0])).toBe(true); // user==email
  });
});

describe("planCountSources (each account counted exactly once)", () => {
  const accounts: Account[] = [
    { name: "Personal", email: "a@gmail.com", enabled: true },
    { name: "Work", email: "b@work.com", enabled: true },
    { name: "Exchange", email: "c@corp.com", enabled: true }, // not IMAP
  ];

  it("assigns each Mail account ONE source: its matching config, else AppleScript", () => {
    const sources = planCountSources(accounts, [cfgA, cfgB]);
    expect(sources).toHaveLength(3);
    const byName = Object.fromEntries(sources.map((s) => [s.label, s.kind]));
    expect(byName).toEqual({ Personal: "imap", Work: "imap", Exchange: "applescript" });
  });

  it("does NOT double-count when an IMAP-configured account is UNMATCHED by the heuristic", () => {
    // cfg has a freeform label AND a user that matches NO Mail account email →
    // the heuristic can't match it to "Personal". It must NOT also be summed for
    // Personal via IMAP: Personal falls to AppleScript (ONE source), and the
    // orphan config is counted once via IMAP. Total sources = 3 accounts + 1
    // orphan config = 4, with Personal counted exactly once (AppleScript).
    const orphan: ImapConfig = { ...cfgA, accountLabel: "freeform", user: "nomatch@x.com" };
    const sources = planCountSources(accounts, [orphan]);
    const personal = sources.filter((s) => s.label === "Personal");
    expect(personal).toHaveLength(1);
    expect(personal[0].kind).toBe("applescript"); // counted via AppleScript only, never doubled
    // The orphan config is counted exactly once, via IMAP, under its own label.
    const orphanSrc = sources.filter((s) => s.label === "freeform");
    expect(orphanSrc).toHaveLength(1);
    expect(orphanSrc[0].kind).toBe("imap");
    expect(sources).toHaveLength(4);
  });

  it("a config consumed by one account is not reused by another (no inflation)", () => {
    // Two Mail accounts could both fuzzy-match a single config by email; the
    // config is consumed by the FIRST, so the second falls to AppleScript.
    const dupA: Account = { name: "Acct1", email: "a@gmail.com", enabled: true };
    const dupB: Account = { name: "Acct2", email: "a@gmail.com", enabled: true };
    const sources = planCountSources([dupA, dupB], [cfgA]);
    expect(sources.map((s) => s.kind)).toEqual(["imap", "applescript"]);
  });

  it("with no configs, every account is an AppleScript source", () => {
    const sources = planCountSources(accounts, []);
    expect(sources.every((s) => s.kind === "applescript")).toBe(true);
    expect(sources).toHaveLength(3);
  });
});

describe("formatMergedRows", () => {
  it("renders id, date, subject, sender and optional read-state", () => {
    const line = formatMergedRows([row({ id: "imap:z", isRead: true })]);
    expect(line).toContain("ID: imap:z");
    expect(line).toContain("Hello (from: Alice <alice@x.com>)");
    expect(line).toContain("[read]");
    expect(formatMergedRows([row()], false)).not.toContain("[");
  });
});
