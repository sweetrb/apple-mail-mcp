/**
 * #234 (@j5pu) — IMAP-path date recovery and 8-bit bytes.
 *
 * §3: `parseDateHeader` recovered `2007-08-30T11:55:12Z` for a message in
 *     get-message-headers, while search/list/get-message/get-thread reported
 *     no `dateSent` for the same message: they read imapflow's `envelope.date`
 *     only, which is a raw unparseable string (iCloud passes
 *     `jue ago 30 13:55:12 2007` through verbatim) or absent (a server that
 *     sends NIL). The Date: header now rides in the SAME FETCH and goes through
 *     the same tolerant parser, and sort order uses it.
 * §2b on this path: a send time implausibly later than INTERNALDATE is omitted.
 * §4: iCloud rewrites 8-bit header bytes in ENVELOPE (`*`) and in
 *     BODY[HEADER] / BODY[HEADER.FIELDS] (U+FFFD); only BODY[] keeps them. The
 *     body was additionally destroyed locally (UTF-8 decode of the whole source,
 *     part charset ignored) and HTML was flagged `isHtml: false`.
 */
import { describe, it, expect } from "vitest";
import {
  encodeImapId,
  decodeImapId,
  imapGetMessage,
  imapGetMessageHeaders,
  imapListMessages,
  imapSearchMessages,
  imapThread,
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

type Msg = Record<string, unknown> & { uid: number };

function client(
  msgs: Msg[],
  rec: { fetchOpts?: Record<string, unknown>[]; oneOpts?: Record<string, unknown>[] } = {}
): ImapClientLike {
  return {
    connect: async () => undefined,
    getMailboxLock: async () => ({ release: () => undefined }),
    search: async () => msgs.map((m) => m.uid),
    fetch: async function* (range: string, o: Record<string, unknown>) {
      (rec.fetchOpts ??= []).push(o);
      const want = new Set(range.split(",").map(Number));
      for (const m of msgs) if (want.has(m.uid)) yield m as never;
    },
    fetchOne: async (_r: string, o: Record<string, unknown>) => {
      (rec.oneOpts ??= []).push(o);
      return (msgs[0] as never) ?? false;
    },
    list: async () => [{ path: "INBOX", name: "INBOX", specialUse: "\\Inbox" }],
    status: async (path: string) => ({ path, messages: 0, unseen: 0, recent: 0 }),
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
  } as unknown as ImapClientLike;
}

const SPANISH = "jue ago 30 13:55:12 2007";
const RECOVERED = new Date("Thu Aug 30 13:55:12 2007").toISOString();
const MIGRATED_ARRIVAL = new Date("2014-01-14T12:53:59.000Z");
const L = (s: string) => Buffer.from(s, "latin1");

describe("#234 §3 — list/search rows recover dateSent from the Date: header", () => {
  it("requests the Date: header in the SAME fetch as the envelope (no second round trip)", async () => {
    const rec: { fetchOpts?: Record<string, unknown>[] } = {};
    await imapListMessages(
      { limit: 10 },
      {
        config: cfg,
        connect: async () =>
          client([{ uid: 7, envelope: { date: SPANISH }, flags: new Set() }], rec),
      }
    );
    expect(rec.fetchOpts).toHaveLength(1);
    expect(rec.fetchOpts![0].envelope).toBe(true);
    expect(rec.fetchOpts![0].headers).toEqual(["date"]);
  });

  it("recovers a locale Date: the server passed through as a raw string (iCloud's behaviour)", async () => {
    const res = await imapListMessages(
      { limit: 10 },
      {
        config: cfg,
        connect: async () =>
          client([
            {
              uid: 7,
              envelope: { subject: "diferencial", date: SPANISH },
              flags: new Set(),
              internalDate: MIGRATED_ARRIVAL,
            },
          ]),
      }
    );
    const row = res.messages[0];
    expect(row.dateSent).toBe(RECOVERED);
    expect(row.dateReceived).toBe(MIGRATED_ARRIVAL.toISOString());
  });

  it("recovers from the fetched Date: header when the ENVELOPE date is NIL", async () => {
    const res = await imapSearchMessages(
      { query: "diferencial", limit: 10 },
      {
        config: cfg,
        connect: async () =>
          client([
            {
              uid: 7,
              envelope: { subject: "diferencial" },
              headers: Buffer.from(`Date: ${SPANISH}\r\n\r\n`),
              flags: new Set(),
              internalDate: MIGRATED_ARRIVAL,
            },
          ]),
      }
    );
    expect(res.messages[0].dateSent).toBe(RECOVERED);
  });

  it("omits a header date implausibly later than INTERNALDATE (§2b guard, shared helper)", async () => {
    const res = await imapListMessages(
      { limit: 10 },
      {
        config: cfg,
        connect: async () =>
          client([
            {
              uid: 7,
              envelope: { date: new Date("2037-01-01T00:00:00Z") },
              flags: new Set(),
              internalDate: MIGRATED_ARRIVAL,
            },
          ]),
      }
    );
    expect(res.messages[0].dateSent).toBe("");
    expect(res.messages[0].dateReceived).toBe(MIGRATED_ARRIVAL.toISOString());
  });

  it("sorts an unscoped search by the RECOVERED header date, not by 0", async () => {
    // uid 7: 2007 but only as a locale string; uid 8: a real 2006 Date. Newest-first
    // must put the 2007 message first — before the fix it had epoch 0 and sank last.
    const c = client([
      { uid: 7, envelope: { subject: "a", date: SPANISH }, flags: new Set() },
      {
        uid: 8,
        envelope: { subject: "b", date: new Date("2006-05-01T00:00:00Z") },
        flags: new Set(),
      },
    ]);
    const res = await imapSearchMessages(
      { query: "x", limit: 10 },
      { config: cfg, connect: async () => c }
    );
    expect(res.messages.map((m) => decodeImapId(m.id as string)?.uid)).toEqual([7, 8]);
  });
});

describe("#234 §3 — get-message and get-thread recover dateSent too", () => {
  const MID = encodeImapId("iCloud", "INBOX", 1);
  const SOURCE = L(
    `From: x <x@example.org>\r\nDate: ${SPANISH}\r\nSubject: diferencial\r\nContent-Type: text/plain\r\n\r\nhola\r\n`
  );

  it("get-message reads the Date: header out of the source it already fetched", async () => {
    const rec: { oneOpts?: Record<string, unknown>[] } = {};
    const r = await imapGetMessage(MID, false, {
      config: cfg,
      connect: async () =>
        client(
          [
            {
              uid: 1,
              envelope: { subject: "diferencial", date: SPANISH },
              internalDate: MIGRATED_ARRIVAL,
              source: SOURCE,
            },
          ],
          rec
        ),
    });
    expect(r.success).toBe(true);
    expect(r.meta?.dateSent).toBe(RECOVERED);
    expect(rec.oneOpts).toHaveLength(1);
  });

  it("get-message omits a dateSent implausibly later than arrival", async () => {
    const future = L(
      "Date: Thu, 01 Jan 2037 00:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nx\r\n"
    );
    const r = await imapGetMessage(MID, false, {
      config: cfg,
      connect: async () =>
        client([
          {
            uid: 1,
            envelope: { date: new Date("2037-01-01T00:00:00Z") },
            internalDate: MIGRATED_ARRIVAL,
            source: future,
          },
        ]),
    });
    expect(r.meta?.dateSent).toBeUndefined();
    expect(r.meta?.dateReceived).toBe(MIGRATED_ARRIVAL.toISOString());
  });

  it("get-thread's per-message date uses the recovered header date", async () => {
    const seed = {
      uid: 1,
      envelope: { subject: "t", date: SPANISH, messageId: "<a@x>" },
      flags: new Set(),
    };
    const reply = {
      uid: 2,
      envelope: { subject: "Re: t", date: new Date("2007-09-01T00:00:00Z") },
      flags: new Set(),
    };
    const t = await imapThread(
      MID,
      { config: cfg, connect: async () => client([seed, reply]) },
      50
    );
    expect(t).not.toBeNull();
    const dates = t!.structured.messages.map((m) => m.date);
    expect(dates).toEqual([RECOVERED, "2007-09-01T00:00:00.000Z"]);
  });
});

describe("#234 §4 — 8-bit bytes on the IMAP path", () => {
  const MID = encodeImapId("iCloud", "INBOX", 1);
  // Byte-for-byte what iCloud returned for the ZZ234 probe: BODY[] keeps the raw
  // latin-1 bytes; BODY[HEADER] had already replaced them with `*`.
  const RAW_SOURCE = Buffer.concat([
    L('From: "ZZ234 Jos\xe9 Pu\xf1ez" <zz234-probe@example.invalid>\r\n'),
    L(`Date: ${SPANISH}\r\n`),
    L("Subject: diferencial t\xe9rmico\r\n"),
    L('Content-Type: multipart/mixed; boundary="OUTLOOK2MAC8473928"\r\n\r\n'),
    L("--OUTLOOK2MAC8473928\r\n"),
    L('Content-Type: text/html; charset="ISO-8859-1"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'),
    L("<html><body><p>Se\xf1or Jos\xe9</p></body></html>\r\n"),
    L("--OUTLOOK2MAC8473928--\r\n"),
  ]);
  const SERVER_HEADER = L(
    'From: "ZZ234 Jos* Pu*ez" <zz234-probe@example.invalid>\r\nSubject: diferencial t*rmico\r\n\r\n'
  );

  it("get-message decodes an 8bit ISO-8859-1 body and flags extracted HTML as HTML", async () => {
    const r = await imapGetMessage(MID, false, {
      config: cfg,
      connect: async () =>
        client([{ uid: 1, envelope: { subject: "diferencial t*rmico" }, source: RAW_SOURCE }]),
    });
    expect(r.info).toContain("Señor José");
    expect(r.info).not.toContain("�");
    // No text/plain part exists, so the HTML part is what came back — say so.
    expect(r.meta?.isHtml).toBe(true);
  });

  it("get-message takes the subject from the raw source when the server mangled the envelope", async () => {
    const r = await imapGetMessage(MID, false, {
      config: cfg,
      connect: async () =>
        client([{ uid: 1, envelope: { subject: "diferencial t*rmico" }, source: RAW_SOURCE }]),
    });
    expect(r.info?.startsWith("Subject: diferencial térmico\n")).toBe(true);
  });

  it("get-message-headers reads the header block from BODY[] bytes, recovering the display name", async () => {
    const rec: { oneOpts?: Record<string, unknown>[] } = {};
    const r = await imapGetMessageHeaders(MID, {
      config: cfg,
      connect: async () =>
        client([{ uid: 1, envelope: {}, headers: SERVER_HEADER, source: RAW_SOURCE }], rec),
    });
    expect(r.success).toBe(true);
    expect(r.info).toContain('From: "ZZ234 José Puñez" <zz234-probe@example.invalid>');
    expect(r.info).not.toContain("*");
    // Only the header window of the source — never the whole body.
    const opts = rec.oneOpts![0];
    expect(opts.source).toEqual({ start: 0, maxLength: expect.any(Number) });
    expect((opts.source as { maxLength: number }).maxLength).toBeLessThanOrEqual(256 * 1024);
  });
});
