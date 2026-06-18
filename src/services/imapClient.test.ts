import { describe, it, expect } from "vitest";
import {
  IMAP_ENV,
  isImapAccount,
  resolveImapConfig,
  resolveMailboxPath,
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
    expect(out).toContain("UID: 5");
    expect(out).toContain("UID: 4");
    expect(out).not.toContain("UID: 3");
    expect(out).toContain("5 total matched");
    expect(out).toMatch(/Note: IDs are IMAP UIDs/);
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
    expect(out).toContain("UID: 8");
    expect(out).toContain("2 total listed");
  });
});
