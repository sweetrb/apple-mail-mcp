import { describe, it, expect } from "vitest";
import {
  decodeEncodedWords,
  headersStructured,
  isoOrUndefined,
  parseHeaderBlock,
} from "./headers.js";

const BLOCK = [
  "Received: from mx2.example.net (mx2.example.net [10.0.0.2])",
  "\tby imap.example.com with ESMTPS id abc123;",
  "\tWed, 03 Jun 2020 14:05:00 +0000",
  "Received: from sender.example.org ([10.0.0.9])",
  " by mx2.example.net; Wed, 03 Jun 2020 14:04:58 +0000",
  "Date: Wed, 3 Jun 2020 16:04:55 +0200 (CEST)",
  "From: =?UTF-8?Q?Jos=C3=A9_Puertolas?= <jose@example.org>",
  "To: Rob <rob@example.com>",
  "Cc: =?utf-8?B?Sm9zw6k=?= Dos <dos@example.org>",
  "Reply-To: list@example.org",
  "Subject: =?UTF-8?B?SGVsbG8g?=",
  " =?UTF-8?B?d29ybGQ=?=",
  "Message-ID: <orig-id@example.org>",
  "In-Reply-To: <parent@example.org>",
  "References: <root@example.org>",
  "\t<parent@example.org>",
  "MIME-Version: 1.0",
  "",
  "Body text that must not be parsed as a header",
  "X-Not-A-Header: in the body",
].join("\r\n");

describe("parseHeaderBlock", () => {
  const p = parseHeaderBlock(BLOCK);

  it("stops at the first blank line so body text is never read as a header", () => {
    expect(p.headers.some((h) => h.name === "X-Not-A-Header")).toBe(false);
    expect(p.raw.endsWith("MIME-Version: 1.0")).toBe(true);
  });

  it("unfolds continuation lines and keeps every header in wire order", () => {
    expect(p.headers[0]).toEqual({
      name: "Received",
      value:
        "from mx2.example.net (mx2.example.net [10.0.0.2]) by imap.example.com with ESMTPS id abc123; Wed, 03 Jun 2020 14:05:00 +0000",
    });
    expect(p.headers.map((h) => h.name).slice(0, 4)).toEqual([
      "Received",
      "Received",
      "Date",
      "From",
    ]);
  });

  it("keeps every Received hop, last hop first", () => {
    expect(p.received).toHaveLength(2);
    expect(p.received[0]).toMatch(/^from mx2\.example\.net/);
    expect(p.received[1]).toMatch(/^from sender\.example\.org/);
  });

  it("sources `date` from the Date: header, tolerating a trailing zone comment", () => {
    expect(p.dateHeader).toBe("Wed, 3 Jun 2020 16:04:55 +0200 (CEST)");
    expect(p.date).toBe("2020-06-03T14:04:55.000Z");
  });

  it("decodes RFC 2047 words in the display fields and joins adjacent words", () => {
    expect(p.from).toBe("José Puertolas <jose@example.org>");
    expect(p.cc).toBe("José Dos <dos@example.org>");
    expect(p.subject).toBe("Hello world");
    expect(p.replyTo).toBe("list@example.org");
    expect(p.to).toBe("Rob <rob@example.com>");
  });

  it("leaves the raw header values undecoded", () => {
    expect(p.headers.find((h) => h.name === "Subject")?.value).toBe(
      "=?UTF-8?B?SGVsbG8g?= =?UTF-8?B?d29ybGQ=?="
    );
  });

  it("strips angle brackets from the threading ids", () => {
    expect(p.messageId).toBe("orig-id@example.org");
    expect(p.inReplyTo).toBe("parent@example.org");
    expect(p.references).toEqual(["root@example.org", "parent@example.org"]);
  });

  it("accepts LF-only input and a block with no body", () => {
    const q = parseHeaderBlock("Subject: plain\nDate: not a date\nMessage-Id: <x@y>\n");
    expect(q.subject).toBe("plain");
    expect(q.date).toBeUndefined();
    expect(q.dateHeader).toBe("not a date");
    expect(q.messageId).toBe("x@y");
    expect(q.references).toEqual([]);
    expect(q.received).toEqual([]);
  });

  it("is lenient with malformed lines instead of aborting", () => {
    const q = parseHeaderBlock("garbage line\nSubject: ok\n");
    expect(q.headers).toEqual([{ name: "Subject", value: "ok" }]);
  });

  // #226 — old Entourage/Outlook-for-Mac (~2005-2011, MIME boundary
  // OUTLOOK2MACxxxxxxxx) wrote Date: using the OS locale instead of RFC 5322
  // (e.g. Spanish "jue ago 30 13:55:12 2007" — "jue" = Thursday, "ago" =
  // August). The reporter's literal minimal repro turns out to already parse
  // correctly today (this pins that down as a regression guard); the real,
  // previously-unguarded gap was bare-CR line endings, below.
  const outlook2macRepro = [
    "From: Test Sender <test@example.com>",
    "To: 'Test Recipient'",
    "Date: jue ago 30 13:55:12 2007",
    "Subject: diferencial",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="OUTLOOK2MAC8473928"',
  ];

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])(
    "never drops or merges a header just because Date: is an unparseable locale string (%s)",
    (_label, sep) => {
      const q = parseHeaderBlock(outlook2macRepro.join(sep));
      expect(q.dateHeader).toBe("jue ago 30 13:55:12 2007");
      expect(q.date).toBeUndefined();
      expect(q.subject).toBe("diferencial");
      expect(q.headers.map((h) => h.name)).toEqual([
        "From",
        "To",
        "Date",
        "Subject",
        "MIME-Version",
        "Content-Type",
      ]);
    }
  );

  it("parses bare-CR line endings the same as LF/CRLF (#226 — AppleScript's `all headers of msg` can return \\r-only text; previously this silently dropped every header)", () => {
    const q = parseHeaderBlock(outlook2macRepro.join("\r"));
    expect(q.dateHeader).toBe("jue ago 30 13:55:12 2007");
    expect(q.subject).toBe("diferencial");
    expect(q.headers).toHaveLength(6);
  });

  it("stops at the first blank line under bare-CR endings too (CRCR, not just LFLF)", () => {
    const q = parseHeaderBlock(
      [...outlook2macRepro, "", "Body text that must not be parsed as a header"].join("\r")
    );
    expect(q.headers.map((h) => h.name)).toEqual([
      "From",
      "To",
      "Date",
      "Subject",
      "MIME-Version",
      "Content-Type",
    ]);
  });

  it("returns an empty result for empty input", () => {
    const q = parseHeaderBlock("");
    expect(q.headers).toEqual([]);
    expect(q.raw).toBe("");
    expect(q.date).toBeUndefined();
  });
});

describe("decodeEncodedWords", () => {
  it("passes through text without encoded-words untouched", () => {
    expect(decodeEncodedWords("plain <a@b>")).toBe("plain <a@b>");
  });

  it("decodes Q encoding underscores as spaces and hex escapes", () => {
    expect(decodeEncodedWords("=?iso-8859-1?Q?caf=E9_au_lait?=")).toBe("café au lait");
  });

  it("falls back to UTF-8 for an unknown charset rather than throwing", () => {
    expect(decodeEncodedWords("=?x-unknown-cs?B?aGk=?=")).toBe("hi");
  });

  it("leaves an undecodable word in place", () => {
    // `?=` with no text and a bad charset label still round-trips as text.
    expect(decodeEncodedWords("=?utf-8?X?zzz?=")).toBe("=?utf-8?X?zzz?=");
  });
});

describe("headersStructured", () => {
  it("carries the backend arrival timestamp beside the Date: header", () => {
    const s = headersStructured(
      "imap:abc",
      parseHeaderBlock(BLOCK),
      new Date("2026-01-02T03:04:05Z")
    );
    expect(s.id).toBe("imap:abc");
    expect(s.date).toBe("2020-06-03T14:04:55.000Z");
    expect(s.dateReceived).toBe("2026-01-02T03:04:05.000Z");
    expect(s.headerCount).toBe(12);
    expect(s.messageId).toBe("orig-id@example.org");
  });

  it("omits dateReceived when the backend had none or it was invalid", () => {
    expect(headersStructured("1", parseHeaderBlock("Subject: x"))).not.toHaveProperty(
      "dateReceived"
    );
    expect(
      headersStructured("1", parseHeaderBlock("Subject: x"), new Date("garbage"))
    ).not.toHaveProperty("dateReceived");
  });
});

describe("isoOrUndefined", () => {
  it("handles Date, string, empty and invalid inputs", () => {
    expect(isoOrUndefined(new Date("2020-01-01T00:00:00Z"))).toBe("2020-01-01T00:00:00.000Z");
    expect(isoOrUndefined("2020-01-01T00:00:00Z")).toBe("2020-01-01T00:00:00.000Z");
    expect(isoOrUndefined("")).toBeUndefined();
    expect(isoOrUndefined(undefined)).toBeUndefined();
    expect(isoOrUndefined(new Date("nope"))).toBeUndefined();
  });
});
