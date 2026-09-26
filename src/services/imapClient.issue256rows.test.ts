/**
 * #256 follow-up (@j5pu) — on 2.19.17, `list-messages(limit: 500)` on a
 * 255,104-message iCloud mailbox returned 497 rows, `partial: false`. The
 * three missing UIDs were live, not `\Deleted`, and a direct `UID FETCH` of
 * each returned every field.
 *
 * Cause: imapflow drops an untagged FETCH it cannot parse (its token parser
 * caps nesting at 25 levels, and BODYSTRUCTURE nests one list per MIME level)
 * and still completes the command `OK`. `fetchRows` mapped the results by UID
 * and filtered out whatever was absent. It now checks the fetched set against
 * the requested one, retries the gap with smaller item sets, and reports
 * anything it still cannot read.
 */
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetPool,
  decodeImapId,
  imapListMessages,
  imapSearchMessages,
  imapThread,
  encodeImapId,
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

type Query = Record<string, unknown>;
type Row = Record<string, unknown> & { uid: number };

const fullRow = (uid: number): Row => ({
  uid,
  envelope: {
    subject: `subject ${uid}`,
    date: new Date(Date.UTC(2026, 0, 1, 0, 0, uid % 60)),
    from: [{ name: "Sender", address: "s@example.org" }],
    messageId: `<m${uid}@example.org>`,
  },
  flags: new Set<string>(["\\Seen"]),
  internalDate: new Date(Date.UTC(2026, 0, 1)),
  bodyStructure: { type: "text/plain" },
});

interface Behaviour {
  /** Rows a FETCH with this query yields for `uid` (none = dropped). */
  rows?: (uid: number, query: Query, attempt: number) => Row[];
  /** UIDs the server holds, ascending. */
  uids: number[];
  /** STATUS MESSAGES; defaults to uids.length. */
  exists?: number;
  /** Unsolicited extras yielded before the real rows. */
  extras?: Row[];
  /** What the logger recorded for a dropped line. */
  dropError?: unknown;
}

interface Log {
  uidFetches: { range: string; query: Query }[];
}

function mailbox(log: Log, b: Behaviour): ImapClientLike {
  let lastError: unknown;
  const attempts = new Map<number, number>();
  const exists = b.exists ?? b.uids.length;
  // Sequence n (1-based) holds uids[n - 1]; for a mailbox larger than `uids`
  // the extra sequence numbers sit below, with synthetic older UIDs.
  const uidAtSeq = (seq: number) => {
    const offset = exists - b.uids.length;
    return seq > offset ? b.uids[seq - offset - 1] : seq;
  };
  return {
    connect: async () => undefined,
    getMailboxLock: async () => ({ release: () => undefined }),
    status: async (path: string) => ({ path, messages: exists }),
    search: async () => b.uids.slice(),
    fetch: async function* (range: string, query: Query, o?: { uid?: boolean }) {
      if (!o?.uid) {
        const [a, z] = range.split(":");
        const lo = Number(a);
        const hi = z === "*" ? exists : Number(z ?? a);
        for (let s = lo; s <= hi; s++) yield { uid: uidAtSeq(s), flags: new Set<string>() };
        return;
      }
      log.uidFetches.push({ range, query });
      for (const extra of b.extras ?? []) yield extra;
      for (const uid of range.split(",").map(Number)) {
        const attempt = (attempts.get(uid) ?? 0) + 1;
        attempts.set(uid, attempt);
        const rows = b.rows ? b.rows(uid, query, attempt) : [fullRow(uid)];
        if (rows.length === 0) lastError = b.dropError;
        for (const row of rows) yield row;
      }
    },
    fetchOne: async (uid: string) => ({
      uid: Number(uid),
      envelope: { messageId: "<seed@example.org>" },
      headers: Buffer.from(""),
    }),
    list: async () => [{ path: "Recovered", name: "Recovered" }],
    noop: async () => undefined,
    logout: async () => undefined,
    takeLastCommandError: () => {
      const e = lastError;
      lastError = undefined;
      return e;
    },
  } as unknown as ImapClientLike;
}

const uidsOf = (res: { messages: Record<string, unknown>[] }) =>
  res.messages.map((m) => decodeImapId(m.id as string)?.uid);

const nestingError = Object.assign(new Error("Too much nesting in IMAP string"), {
  code: "MAX_IMAP_NESTING_REACHED",
});

describe("#256 follow-up: a FETCH that silently omits rows", () => {
  it("j5pu's shape: 3 of the newest 500 unparseable with BODYSTRUCTURE → still 500, not partial", async () => {
    // 255,104 messages; the newest 564 carry these UIDs (ascending).
    const top = Array.from({ length: 564 }, (_, i) => 419_000 + i * 2);
    const newestFirst = top.slice().reverse();
    const bad = new Set([newestFirst[63], newestFirst[347], newestFirst[416]]);
    const log: Log = { uidFetches: [] };
    const res = await imapListMessages(
      { mailbox: "Recovered", limit: 500 },
      {
        config: cfg,
        connect: async () =>
          mailbox(log, {
            uids: top,
            exists: 255_104,
            dropError: nestingError,
            rows: (uid, q) => (bad.has(uid) && q.bodyStructure ? [] : [fullRow(uid)]),
          }),
      }
    );
    expect(res.count).toBe(500);
    expect(res.partial).toBe(false);
    expect(res.omittedMessages).toEqual([]);
    expect(uidsOf(res)).toEqual(newestFirst.slice(0, 500));
    // The three came back through the no-BODYSTRUCTURE retry, and say so.
    const degraded = res.messages.filter((m) => m.metadataIncomplete);
    expect(degraded.map((m) => decodeImapId(m.id as string)?.uid)).toEqual(
      [...bad].sort((a, b) => b - a)
    );
    // One bulk FETCH, one same-items retry of just the gap, one reduced retry.
    expect(log.uidFetches).toHaveLength(3);
    expect(log.uidFetches[1].range.split(",")).toHaveLength(3);
    expect(log.uidFetches[2].query.bodyStructure).toBeUndefined();
  });

  it("a transient loss is filled by the same-items retry, with full metadata", async () => {
    const log: Log = { uidFetches: [] };
    const uids = [1, 2, 3, 4, 5];
    const res = await imapListMessages(
      { mailbox: "Recovered", limit: 5 },
      {
        config: cfg,
        connect: async () =>
          mailbox(log, {
            uids,
            rows: (uid, _q, attempt) => (uid === 3 && attempt === 1 ? [] : [fullRow(uid)]),
          }),
      }
    );
    expect(uidsOf(res)).toEqual([5, 4, 3, 2, 1]);
    expect(res.partial).toBe(false);
    expect(res.messages.some((m) => m.metadataIncomplete)).toBe(false);
    expect(log.uidFetches.map((f) => f.range)).toEqual(["5,4,3,2,1", "3"]);
  });

  it("a row without BODYSTRUCTURE judges attachments by Content-Type", async () => {
    const log: Log = { uidFetches: [] };
    const res = await imapListMessages(
      { mailbox: "Recovered", limit: 2 },
      {
        config: cfg,
        connect: async () =>
          mailbox(log, {
            uids: [1, 2],
            rows: (uid, q) => {
              if (q.bodyStructure) return uid === 2 ? [] : [fullRow(uid)];
              return [
                {
                  ...fullRow(uid),
                  bodyStructure: undefined,
                  headers: Buffer.from(
                    "Date: Thu, 1 Jan 2026 00:00:00 +0000\r\nContent-Type: multipart/mixed;\r\n boundary=x\r\n\r\n"
                  ),
                },
              ];
            },
          }),
      }
    );
    const row = res.messages.find((m) => decodeImapId(m.id as string)?.uid === 2);
    expect(row?.hasAttachments).toBe(true);
    expect(row?.metadataIncomplete).toMatch(/BODYSTRUCTURE/);
    expect(row?.subject).toBe("subject 2");
  });

  it("falls back to raw headers when the ENVELOPE is unreadable too", async () => {
    const log: Log = { uidFetches: [] };
    const res = await imapListMessages(
      { mailbox: "Recovered", limit: 3 },
      {
        config: cfg,
        connect: async () =>
          mailbox(log, {
            uids: [1, 2, 3],
            rows: (uid, q) => {
              if (uid !== 2) return [fullRow(uid)];
              if (q.envelope) return [];
              return [
                {
                  uid,
                  flags: new Set<string>(),
                  internalDate: new Date(Date.UTC(2026, 0, 2)),
                  headers: Buffer.from(
                    "Date: Fri, 2 Jan 2026 10:00:00 +0000\r\n" +
                      'From: "Ana Pérez" <ana@example.org>\r\n' +
                      "Subject: =?utf-8?B?UmVjb3ZlcmVkIOKckw==?=\r\n" +
                      "Message-ID: <deep@example.org>\r\n\r\n"
                  ),
                },
              ];
            },
          }),
      }
    );
    expect(uidsOf(res)).toEqual([3, 2, 1]);
    expect(res.partial).toBe(false);
    const row = res.messages[1];
    expect(row.subject).toBe("Recovered ✓");
    expect(row.sender).toBe("Ana Pérez <ana@example.org>");
    expect(row.dateSent).toBe("2026-01-02T10:00:00.000Z");
    expect(row.isRead).toBe(false);
    expect(row.metadataIncomplete).toMatch(/raw headers/);
    // The headers-only retry goes one UID per command.
    expect(log.uidFetches.at(-1)?.range).toBe("2");
  });

  it("a UID nothing can read → partial:true, listed with its id and the recorded cause", async () => {
    const log: Log = { uidFetches: [] };
    const res = await imapListMessages(
      { mailbox: "Recovered", limit: 4 },
      {
        config: cfg,
        connect: async () =>
          mailbox(log, {
            uids: [10, 20, 30, 40],
            dropError: nestingError,
            rows: (uid) => (uid === 30 ? [] : [fullRow(uid)]),
          }),
      }
    );
    expect(uidsOf(res)).toEqual([40, 20, 10]);
    expect(res.partial).toBe(true);
    expect(res.failedMailboxes).toEqual([]);
    expect(res.omittedMessages).toEqual([
      {
        id: encodeImapId("iCloud", "Recovered", 30),
        mailbox: "Recovered",
        uid: 30,
        reason: expect.stringContaining("Too much nesting in IMAP string"),
      },
    ]);
    expect(res.text).toContain("Partial result. 1 message(s)");
    expect(res.text).toContain("UID 30");
  });

  it("the same check covers search-messages", async () => {
    const log: Log = { uidFetches: [] };
    const res = await imapSearchMessages(
      { mailbox: "Recovered", subject: "x", limit: 3 },
      {
        config: cfg,
        connect: async () =>
          mailbox(log, { uids: [1, 2, 3], rows: (uid) => (uid === 2 ? [] : [fullRow(uid)]) }),
      }
    );
    expect(res.partial).toBe(true);
    expect(res.omittedMessages.map((o) => o.uid)).toEqual([2]);
  });

  it("the same check covers get-thread", async () => {
    const log: Log = { uidFetches: [] };
    const client = mailbox(log, {
      uids: [1, 2, 3],
      rows: (uid) => (uid === 3 ? [] : [fullRow(uid)]),
    });
    const res = await imapThread(encodeImapId("iCloud", "Recovered", 1), {
      config: cfg,
      connect: async () => client,
    });
    expect(res?.count).toBe(2);
    expect(res?.structured.partial).toBe(true);
    expect(res?.structured.omittedMessages.map((o) => o.uid)).toEqual([3]);
    expect(res?.text).toContain("UID 3");
  });

  it("the multi-account fan-out carries omissions through, prefixed by account", async () => {
    const log: Log = { uidFetches: [] };
    const fan = await fanOutImapMessages(
      { mailbox: "Recovered", limit: 3 },
      "list",
      {
        connect: async () =>
          mailbox(log, { uids: [1, 2, 3], rows: (uid) => (uid === 1 ? [] : [fullRow(uid)]) }),
      },
      [cfg]
    );
    expect(fan.rows).toHaveLength(2);
    expect(fan.omittedMessages).toEqual([
      expect.objectContaining({ uid: 1, mailbox: "iCloud / Recovered" }),
    ]);
  });

  it("merges one UID answered across several untagged FETCH responses", async () => {
    const log: Log = { uidFetches: [] };
    const res = await imapListMessages(
      { mailbox: "Recovered", limit: 2 },
      {
        config: cfg,
        connect: async () =>
          mailbox(log, {
            uids: [1, 2],
            rows: (uid) => {
              const { flags, ...rest } = fullRow(uid);
              // uid 1: flags first, the rest after. uid 2: the full row, then a
              // late flags-only update that must not erase the envelope.
              return uid === 1
                ? [{ uid, flags }, rest]
                : [fullRow(uid), { uid, flags: new Set(["\\Flagged"]) }];
            },
          }),
      }
    );
    expect(uidsOf(res)).toEqual([2, 1]);
    expect(res.partial).toBe(false);
    expect(res.messages[0]).toMatchObject({ subject: "subject 2", isFlagged: true });
    expect(res.messages[1]).toMatchObject({ subject: "subject 1", isRead: true });
    expect(log.uidFetches).toHaveLength(1);
  });

  it("ignores an unsolicited FETCH for a UID that was not requested", async () => {
    const log: Log = { uidFetches: [] };
    const res = await imapListMessages(
      { mailbox: "Recovered", limit: 2 },
      {
        config: cfg,
        connect: async () =>
          mailbox(log, { uids: [1, 2], extras: [fullRow(99), { uid: undefined } as never] }),
      }
    );
    expect(uidsOf(res)).toEqual([2, 1]);
    expect(res.partial).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The real mechanism, end to end: imapflow over a socket to a tiny IMAP server
// whose one message has a BODYSTRUCTURE deeper than imapflow's parser accepts.
// ---------------------------------------------------------------------------

const LEAF = '("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 10 1 NIL NIL NIL NIL)';
const ENV = (uid: number) =>
  `("Thu, 1 Jan 2026 00:00:0${uid} +0000" "subject ${uid}" (("S" NIL "s" "example.org")) ` +
  `(("S" NIL "s" "example.org")) (("S" NIL "s" "example.org")) (("T" NIL "t" "example.org")) ` +
  `NIL NIL NIL "<m${uid}@example.org>")`;
/** A message forwarded as an attachment of an attachment, twelve deep. */
function deepStructure(): string {
  let body = LEAF;
  for (let i = 0; i < 12; i++) {
    body = `(${LEAF} ("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 100 ${ENV(9)} ${body} 5 NIL NIL NIL NIL) "MIXED" ("BOUNDARY" "b${i}") NIL NIL NIL)`;
  }
  return body;
}

function fakeImapServer(): Promise<{ port: number; close: () => void }> {
  const deep = deepStructure();
  const server = net.createServer((sock) => {
    sock.write("* OK fake ready\r\n");
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [tag, cmd = "", ...rest] = line.split(" ");
        const C = cmd.toUpperCase();
        const out = (s: string) => sock.write(s);
        if (C === "CAPABILITY") out(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK\r\n`);
        else if (C === "LOGIN") out(`${tag} OK logged in\r\n`);
        else if (C === "LIST") out(`* LIST () "/" "INBOX"\r\n${tag} OK\r\n`);
        else if (C === "STATUS") out(`* STATUS "INBOX" (MESSAGES 3)\r\n${tag} OK\r\n`);
        else if (C === "SELECT" || C === "EXAMINE")
          out(
            `* 3 EXISTS\r\n* OK [UIDVALIDITY 7] v\r\n* OK [UIDNEXT 4] n\r\n${tag} OK [READ-WRITE] done\r\n`
          );
        else if (C === "UID" && rest[0]?.toUpperCase() === "SEARCH")
          out(`* SEARCH 1 2 3\r\n${tag} OK\r\n`);
        else if (C === "UID" && rest[0]?.toUpperCase() === "FETCH") {
          const wantStructure = /BODYSTRUCTURE/i.test(line);
          const uids = rest[1].split(",").map(Number);
          for (const uid of uids) {
            const bs = wantStructure ? ` BODYSTRUCTURE ${uid === 2 ? deep : LEAF}` : "";
            const hdr = /HEADER\.FIELDS/i.test(line)
              ? ` BODY[HEADER.FIELDS (DATE)] {40}\r\nDate: Thu, 1 Jan 2026 00:00:00 +0000\r\n\r\n`
              : "";
            out(
              `* ${uid} FETCH (UID ${uid} FLAGS (\\Seen) INTERNALDATE "01-Jan-2026 00:00:00 +0000" ENVELOPE ${ENV(uid)}${bs}${hdr})\r\n`
            );
          }
          out(`${tag} OK fetch done\r\n`);
        } else if (C === "LOGOUT") {
          out(`* BYE\r\n${tag} OK\r\n`);
          sock.end();
        } else out(`${tag} OK\r\n`);
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => server.close(),
      })
    )
  );
}

describe("#256 follow-up: real imapflow against a too-deep BODYSTRUCTURE", () => {
  afterEach(async () => {
    await __resetPool();
  });

  it("recovers the row imapflow's parser drops, instead of returning a short page", async () => {
    const srv = await fakeImapServer();
    try {
      const res = await imapListMessages(
        { mailbox: "INBOX", limit: 3 },
        {
          config: {
            host: "127.0.0.1",
            port: srv.port,
            secure: false,
            allowPlaintext: true,
            user: "u",
            pass: "p",
            accountLabel: "Fake",
          },
        }
      );
      expect(uidsOf(res)).toEqual([3, 2, 1]);
      expect(res.partial).toBe(false);
      expect(res.messages[1]).toMatchObject({ subject: "subject 2" });
      expect(res.messages[1].metadataIncomplete).toMatch(/BODYSTRUCTURE/);
      expect(res.messages[0].metadataIncomplete).toBeUndefined();
    } finally {
      srv.close();
    }
  });
});
