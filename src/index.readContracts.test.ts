import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  buildEnvelopeIndex,
  writeEmlx,
  plainMessage,
  sqlite,
} from "@/utils/envelopeIndex.testFixture.js";
import {
  __setPoolConnect,
  __resetPool,
  type ImapClientLike,
  type ImapConfig,
} from "@/services/imapClient.js";

type AppleRow = { id: string; subject: string; read: boolean; hour: number };
const h = vi.hoisted(() => ({
  handlers: new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>(),
  scripts: [] as string[],
  accounts: ["A", "B"],
  rows: [] as AppleRow[],
  accountRows: {} as Record<string, AppleRow[]>,
}));

// Keep the registered tool, manager, IMAP query, and merge code real. Only the
// host transport/configuration and OS/wire boundaries are replaced by fixtures.
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registerTool(name: string, config: Record<string, unknown>, handler: never) {
      h.handlers.set(name, handler);
      return { ...config };
    }
    async connect() {}
  },
}));
vi.mock("@/services/fileConfig.js", () => ({ loadFileConfig: vi.fn() }));
vi.mock("@/tools/resourcesAndPrompts.js", () => ({ registerResourcesAndPrompts: vi.fn() }));
vi.mock("@/utils/applescript.js", async (original) => ({
  ...(await original<typeof import("@/utils/applescript.js")>()),
  executeAppleScript: (script: string) => {
    h.scripts.push(script);
    const ok = (output: string) => ({ success: true, output });
    if (script.includes("(id of acct)")) {
      return ok(h.accounts.map((a) => `${a}\x1fACCOUNT-${a}`).join("\x1e"));
    }
    if (script.includes("email addresses of acct")) {
      return ok(h.accounts.map((a) => `${a}\x1f${a}@example.test\x1ftrue`).join("\x1e"));
    }
    if (script.includes("set end of mbNames to mbPath")) return ok("INBOX");
    if (script.includes("set outputText to")) {
      // Model Mail's collection filtering BEFORE the generated loop's offset
      // and limit. Returning a fixed unread row would mask the dropped filter.
      const account = script.match(/tell account "([^"]+)"/)?.[1] ?? "";
      const rows = h.accountRows[account] ?? h.rows;
      const filtered = script.includes("read status is false")
        ? rows.filter((row) => !row.read)
        : rows;
      const offset = Number(script.match(/if skipped < (\d+)/)?.[1] ?? 0);
      const limit = Number(script.match(/if msgCount >= (\d+)/)?.[1] ?? 50);
      return ok(
        filtered
          .slice(offset, offset + limit)
          .map((row) => {
            // Mail emits local wall-clock components. Keep the instant aligned
            // with the IMAP fixtures regardless of the test runner's timezone.
            const date = new Date(Date.UTC(2026, 0, 1, row.hour));
            const localDate = [
              date.getFullYear(),
              date.getMonth() + 1,
              date.getDate(),
              date.getHours(),
              date.getMinutes(),
              date.getSeconds(),
            ].join("-");
            return [
              row.id,
              row.subject,
              "sender@example.test",
              localDate,
              localDate,
              String(row.read),
              "false",
              "-1",
              "false",
            ].join("\x1f");
          })
          .join("\x1e")
      );
    }
    return { success: false, output: "", error: "No live Mail in synthetic test" };
  },
}));

let root: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "read-contracts-"));
  const store = join(root, "V10");
  mkdirSync(join(store, "MailData"), { recursive: true });
  if (sqlite) {
    buildEnvelopeIndex(join(store, "MailData", "Envelope Index"), [
      {
        id: 11,
        account: "ACCOUNT-A",
        mailbox: "INBOX",
        subject: "Source account A",
        address: "sender@example.com",
        received: 1_750_000_000,
      },
    ]);
    writeEmlx(store, "ACCOUNT-A", "INBOX", 11, plainMessage("Source account A", "body-from-A"));
  }
  vi.stubEnv("APPLE_MAIL_MCP_IMAP_IDLE", "false");
  vi.stubEnv("APPLE_MAIL_MCP_BODY_INDEX", "false");
  vi.useFakeTimers();
  const processOn = vi.spyOn(process, "on").mockReturnValue(process);
  const stdinOn = vi.spyOn(process.stdin, "on").mockReturnValue(process.stdin);
  try {
    await import("./index.js");
  } finally {
    processOn.mockRestore();
    stdinOn.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});
beforeEach(() => {
  h.scripts.length = 0;
  h.accounts = ["A", "B"];
  h.accountRows = {};
  h.rows = [
    { id: "1", subject: "Read newest", read: true, hour: 12 },
    { id: "2", subject: "Unread first", read: false, hour: 11 },
    { id: "3", subject: "Unread second", read: false, hour: 10 },
  ];
  vi.stubEnv("APPLE_MAIL_MCP_IMAP_USER", "");
  vi.stubEnv("APPLE_MAIL_MCP_IMAP_ACCOUNTS", "");
  vi.stubEnv("APPLE_MAIL_MCP_ENVELOPE_INDEX", "false");
});
afterEach(async () => {
  await __resetPool();
  __setPoolConnect(null);
  vi.unstubAllEnvs();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const call = (tool: string, args: Record<string, unknown>) => h.handlers.get(tool)!(args);
const subjects = (result: CallToolResult) =>
  (result.structuredContent?.messages as { subject: string }[]).map((row) => row.subject);

function configureImap(accounts = ["A", "B"]) {
  vi.stubEnv(
    "APPLE_MAIL_MCP_IMAP_ACCOUNTS",
    JSON.stringify(
      accounts.map((account) => ({
        account,
        user: `${account}@example.test`,
        host: "imap.example.test",
        password: "fixture",
      }))
    )
  );
  __setPoolConnect(async (cfg) => paginationClient(cfg.accountLabel));
}

describe("registered read tool contracts", () => {
  it
    .skipIf(!sqlite)
    .each([
      { account: "B" },
      { account: "B", mailbox: "INBOX" },
      { account: "A", mailbox: "Wrong mailbox" },
      { account: "Unknown account", mailbox: "INBOX" },
    ])("refuses an indexed message outside explicit scope %j", async (scope) => {
    vi.stubEnv("APPLE_MAIL_MCP_MAIL_DIR", root);
    vi.stubEnv("APPLE_MAIL_MCP_ENVELOPE_INDEX", "1");
    const result = await call("get-message", { id: "11", ...scope });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.body).toBeUndefined();
  });

  it("filters unread messages before applying the AppleScript page", async () => {
    const result = await call("list-messages", {
      mailbox: "INBOX",
      account: "A",
      unreadOnly: true,
      limit: 1,
      offset: 1,
    });
    expect(result.isError).not.toBe(true);
    expect(subjects(result)).toEqual(["Unread second"]);
    expect(result.structuredContent?.partial).toBe(false);
  });

  it("leaves read rows in an unfiltered AppleScript list", async () => {
    const result = await call("list-messages", { mailbox: "INBOX", account: "A", limit: 1 });
    expect(subjects(result)).toEqual(["Read newest"]);
  });

  it.each(["search-messages", "list-messages"])(
    "applies offset once to the combined chronology of %s",
    async (tool) => {
      configureImap();
      expect(subjects(await call(tool, { mailbox: "INBOX", limit: 1 }))).toEqual(["A-10"]);
      const second = await call(tool, { mailbox: "INBOX", offset: 1, limit: 1 });
      expect(subjects(second)).toEqual(["B-9"]);
      expect(second.structuredContent?.partial).toBe(false);
      expect(subjects(await call(tool, { mailbox: "INBOX", offset: 2, limit: 2 }))).toEqual([
        "A-8",
        "B-7",
      ]);
    }
  );

  it("merges filtered AppleScript and IMAP prefixes before applying a list offset", async () => {
    configureImap(["A"]);
    h.rows = [
      { id: "1", subject: "Read B-12", read: true, hour: 12 },
      { id: "2", subject: "Unread B-9", read: false, hour: 9 },
      { id: "3", subject: "Unread B-7", read: false, hour: 7 },
    ];
    expect(
      subjects(await call("list-messages", { mailbox: "INBOX", unreadOnly: true, limit: 1 }))
    ).toEqual(["A-10"]);
    const result = await call("list-messages", {
      mailbox: "INBOX",
      unreadOnly: true,
      offset: 1,
      limit: 1,
    });
    expect(subjects(result)).toEqual(["Unread B-9"]);
    expect(result.structuredContent?.partial).toBe(false);
  });

  it("applies the same global list page when every account uses AppleScript", async () => {
    h.accountRows = {
      A: [
        { id: "1", subject: "A-10", read: false, hour: 10 },
        { id: "2", subject: "A-8", read: false, hour: 8 },
      ],
      B: [
        { id: "3", subject: "B-9", read: false, hour: 9 },
        { id: "4", subject: "B-7", read: false, hour: 7 },
      ],
    };
    expect(subjects(await call("list-messages", { mailbox: "INBOX", limit: 1 }))).toEqual(["A-10"]);
    expect(
      subjects(await call("list-messages", { mailbox: "INBOX", offset: 1, limit: 1 }))
    ).toEqual(["B-9"]);
    expect(
      subjects(await call("list-messages", { mailbox: "INBOX", offset: 2, limit: 2 }))
    ).toEqual(["A-8", "B-7"]);
  });

  it.each(["search-messages", "list-messages"])(
    "preserves account failure diagnostics on a globally paginated %s",
    async (tool) => {
      configureImap();
      __setPoolConnect(async (cfg) => {
        if (cfg.accountLabel === "B") throw new Error("fixture account B is unavailable");
        return paginationClient(cfg.accountLabel);
      });
      const result = await call(tool, { mailbox: "INBOX", offset: 1, limit: 1 });
      expect(subjects(result)).toEqual(["A-8"]);
      expect(result.structuredContent?.partial).toBe(true);
      expect(result.structuredContent?.timedOutAccounts).toContain("B");
    }
  );

  it.each(["search-messages", "list-messages"])(
    "refuses an unbounded global page for %s before connecting",
    async (tool) => {
      configureImap();
      const connect = vi.fn(async (cfg: ImapConfig) => paginationClient(cfg.accountLabel));
      __setPoolConnect(connect);
      const result = await call(tool, { mailbox: "INBOX", offset: 5_000, limit: 1 });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("account");
      expect(connect).not.toHaveBeenCalled();
    }
  );

  it.each(["search-messages", "list-messages"])(
    "keeps deep explicit-account/mailbox pagination available for %s",
    async (tool) => {
      configureImap();
      const connect = vi.fn(async (cfg: ImapConfig) => paginationClient(cfg.accountLabel));
      __setPoolConnect(connect);
      const result = await call(tool, {
        account: "A",
        mailbox: "INBOX",
        offset: 5_000,
        limit: 1,
      });
      expect(result.isError).not.toBe(true);
      expect(subjects(result)).toEqual([]);
      expect(connect).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ["search-messages", "INBOX"],
    ["list-messages", "INBOX"],
    ["search-messages", undefined],
  ])("refills duplicate prefixes before paging %s in %s", async (tool, mailbox) => {
    configureImap();
    __setPoolConnect(async (cfg) => duplicatePaginationClient(cfg.accountLabel));
    const result = await call(tool!, { mailbox, offset: 1, limit: 1 });
    expect(result.isError).not.toBe(true);
    expect(subjects(result)).toEqual(["A-8"]);
    expect(result.structuredContent?.partial).toBe(false);
  });

  it.each(["search-messages", "list-messages"])(
    "reports a bounded, partial page when %s cannot fill its unique prefix",
    async (tool) => {
      configureImap();
      const fetched: number[] = [];
      __setPoolConnect(async (cfg) => duplicatePaginationClient(cfg.accountLabel, 5_001, fetched));
      const result = await call(tool, { mailbox: "INBOX", offset: 1, limit: 1 });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent?.partial).toBe(true);
      expect(result.structuredContent?.failedMailboxes).toContain("A / INBOX");
      expect(result.structuredContent?.failedMailboxReasons).toMatchObject({
        "A / INBOX": expect.stringContaining("5,000"),
      });
      expect(Math.max(...fetched)).toBeLessThanOrEqual(5_000);
      expect(fetched.length).toBeLessThan(16);
    }
  );

  it("preserves distinct same-timestamp AppleScript messages when paging", async () => {
    configureImap(["A"]);
    h.accountRows.B = [
      { id: "1", subject: "B repeated subject", read: false, hour: 12 },
      { id: "2", subject: "B repeated subject", read: false, hour: 12 },
      { id: "3", subject: "Re: B repeated subject", read: false, hour: 12 },
    ];
    const result = await call("list-messages", { mailbox: "INBOX", offset: 1, limit: 1 });
    expect(result.structuredContent?.messages).toEqual([
      expect.objectContaining({ id: "2", subject: "B repeated subject", account: "B" }),
    ]);
    expect(result.structuredContent?.partial).toBe(false);
  });

  it("refills an AppleScript prefix containing repeated source identities", async () => {
    configureImap(["A"]);
    h.accountRows.B = [
      { id: "1", subject: "B duplicate", read: false, hour: 12 },
      { id: "1", subject: "B duplicate", read: false, hour: 12 },
      { id: "3", subject: "B-11", read: false, hour: 11 },
    ];
    const result = await call("list-messages", { mailbox: "INBOX", offset: 1, limit: 1 });
    expect(subjects(result)).toEqual(["B-11"]);
    expect(result.structuredContent?.partial).toBe(false);
  });

  it("bounds duplicate-heavy AppleScript refills and explains the partial coverage", async () => {
    configureImap(["A"]);
    h.accountRows.B = Array.from({ length: 5_001 }, (_, i) => ({
      id: i === 5_000 ? "2" : "1",
      subject: i === 5_000 ? "B-11" : "B duplicate",
      read: false,
      hour: i === 5_000 ? 11 : 12,
    }));
    const result = await call("list-messages", { mailbox: "INBOX", offset: 1, limit: 1 });
    expect(result.structuredContent?.partial).toBe(true);
    expect(result.structuredContent?.notSearchedMailboxes).toEqual([
      expect.stringContaining("B / INBOX (merged pagination reached the 5,000-message prefix cap"),
    ]);
    const requested = h.scripts.flatMap((script) =>
      script.includes('tell account "B"')
        ? Array.from(script.matchAll(/if msgCount >= (\d+)/g), (match) => Number(match[1]))
        : []
    );
    expect(Math.max(...requested)).toBe(5_000);
  });

  it.each([
    ["search-messages", "throws"],
    ["list-messages", "throws"],
    ["search-messages", "omits"],
    ["list-messages", "omits"],
  ])("retains an earlier prefix when a duplicate refill in %s %s", async (tool, failure) => {
    configureImap();
    let aFetches = 0;
    __setPoolConnect(async (cfg) => {
      const client = duplicatePaginationClient(cfg.accountLabel);
      const fetch = client.fetch;
      client.fetch = async function* (...args) {
        if (cfg.accountLabel === "A" && ++aFetches > 1) {
          if (failure === "throws") throw new Error("refill unavailable");
          return;
        }
        yield* fetch(...args);
      };
      return client;
    });
    const result = await call(tool, { mailbox: "INBOX", limit: 2 });
    expect(subjects(result)).toEqual(["A-10", "B-7"]);
    expect(result.structuredContent?.partial).toBe(true);
    if (failure === "throws") {
      expect(result.structuredContent?.failedMailboxes).toContain("A / INBOX");
      expect(result.structuredContent?.failedMailboxReasons).toMatchObject({
        "A / INBOX": expect.stringContaining("Could not refill merged pagination"),
      });
      expect(result.structuredContent?.timedOutAccounts).not.toContain("A");
    } else {
      expect((result.structuredContent?.omittedMessages as unknown[]).length).toBeGreaterThan(0);
    }
  });
});

function paginationClient(account: string): ImapClientLike {
  const hours = account === "A" ? [8, 10] : [7, 9];
  return {
    connect: async () => {},
    getMailboxLock: async () => ({ release() {} }),
    search: async () => [1, 2],
    fetch: async function* (range) {
      const ids = range.split(",").flatMap((part) => {
        const [start, end = start] = part.split(":").map(Number);
        return Array.from({ length: end - start + 1 }, (_, i) => start + i);
      });
      for (const uid of ids) {
        const date = new Date(Date.UTC(2026, 0, 1, hours[uid - 1]));
        yield {
          uid,
          internalDate: date,
          envelope: {
            subject: `${account}-${hours[uid - 1]}`,
            date,
            from: [{ address: `${account}@sender.test` }],
            messageId: `<${account}-${uid}@fixture>`,
          },
          flags: new Set<string>(),
        };
      }
    },
    fetchOne: async () => false,
    list: async () => [{ path: "INBOX", name: "INBOX" }],
    status: async (path) => ({ path, messages: 2 }),
    download: async () => ({ meta: {}, content: (async function* () {})() }),
    mailboxCreate: async (path) => ({ path, created: true }),
    mailboxRename: async (path, newPath) => ({ path, newPath }),
    mailboxDelete: async (path) => ({ path }),
    messageFlagsAdd: async () => true,
    messageFlagsRemove: async () => true,
    messageMove: async () => ({}),
    messageDelete: async () => true,
    noop: async () => {},
    logout: async () => {},
  };
}

function duplicatePaginationClient(
  account: string,
  count = 3,
  fetched: number[] = []
): ImapClientLike {
  const hours = account === "A" ? Array.from({ length: count }, (_, i) => 8 + i) : [7];
  return {
    ...paginationClient(account),
    search: async () => hours.map((_, i) => i + 1),
    status: async (path) => ({ path, messages: hours.length }),
    fetch: async function* (range) {
      const ids = range.split(",").flatMap((part) => {
        const [start, end = start] = part.split(":").map(Number);
        return Array.from({ length: end - start + 1 }, (_, i) => start + i);
      });
      fetched.push(ids.length);
      for (const uid of ids) {
        const date = new Date(Date.UTC(2026, 0, 1, hours[uid - 1]));
        yield {
          uid,
          internalDate: date,
          envelope: {
            subject: `${account}-${hours[uid - 1]}`,
            date,
            from: [{ address: `${account}@sender.test` }],
            messageId:
              account === "A" && uid >= 2 ? "<duplicate@fixture>" : `<${account}-${uid}@fixture>`,
          },
          flags: new Set<string>(),
        };
      }
    },
  };
}
