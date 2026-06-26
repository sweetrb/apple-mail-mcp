/**
 * Tests for the reply/forward MIME-building helpers (2.5.0 prefer-direct path).
 *
 * Pure functions — no network, no Mail.app, no SMTP server. They validate header
 * parsing, reply addressing/threading, subject-prefix rules, and forward bodies.
 */

import { describe, it, expect } from "vitest";
import {
  extractAddresses,
  parseOriginalHeaders,
  withSubjectPrefix,
  quoteBody,
  buildReplyOptions,
  buildForwardOptions,
} from "@/services/replyForward.js";

const RAW = [
  "From: Alice Example <alice@example.com>",
  "To: Bob <bob@work.com>, me@myhost.com",
  "Cc: Carol <carol@work.com>",
  "Subject: Project status",
  "Date: Mon, 23 Jun 2026 10:00:00 -0400",
  "Message-ID: <orig-123@example.com>",
  "References: <root-1@example.com> <root-2@example.com>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Here is the original body.",
  "Second line.",
].join("\r\n");

describe("extractAddresses", () => {
  it("pulls bare addresses out of a display-name list", () => {
    expect(extractAddresses("Alice Example <alice@example.com>, bob@work.com")).toEqual([
      "alice@example.com",
      "bob@work.com",
    ]);
  });

  it("returns [] for an empty/whitespace value and drops non-addresses", () => {
    expect(extractAddresses("   ")).toEqual([]);
    expect(extractAddresses("undisclosed-recipients")).toEqual([]);
  });
});

describe("parseOriginalHeaders", () => {
  it("extracts Message-ID, merged References chain, addresses, subject and date", () => {
    const h = parseOriginalHeaders(RAW);
    expect(h.messageId).toBe("<orig-123@example.com>");
    expect(h.references).toEqual(["<root-1@example.com>", "<root-2@example.com>"]);
    expect(h.from).toEqual(["alice@example.com"]);
    expect(h.to).toEqual(["bob@work.com", "me@myhost.com"]);
    expect(h.cc).toEqual(["carol@work.com"]);
    expect(h.subject).toBe("Project status");
    expect(h.date).toBe("Mon, 23 Jun 2026 10:00:00 -0400");
  });

  it("merges In-Reply-To into the References chain and unfolds folded headers", () => {
    const raw = [
      "From: a@x.com",
      "Subject: Folded",
      "  continuation",
      "In-Reply-To: <only@x.com>",
      "Message-ID: <m@x.com>",
      "",
      "body",
    ].join("\r\n");
    const h = parseOriginalHeaders(raw);
    expect(h.subject).toBe("Folded continuation");
    expect(h.references).toEqual(["<only@x.com>"]);
  });

  it("prefers Reply-To when present", () => {
    const raw = ["From: a@x.com", "Reply-To: list@x.com", "Message-ID: <m@x.com>", "", "b"].join(
      "\r\n"
    );
    expect(parseOriginalHeaders(raw).replyTo).toEqual(["list@x.com"]);
  });
});

describe("withSubjectPrefix", () => {
  it("adds the prefix once and is idempotent on existing prefixes", () => {
    expect(withSubjectPrefix("Hello", "Re:")).toBe("Re: Hello");
    expect(withSubjectPrefix("Re: Hello", "Re:")).toBe("Re: Hello");
    expect(withSubjectPrefix("RE: Hello", "Re:")).toBe("RE: Hello");
    expect(withSubjectPrefix("Hello", "Fwd:")).toBe("Fwd: Hello");
    expect(withSubjectPrefix("Fw: Hello", "Fwd:")).toBe("Fw: Hello");
    expect(withSubjectPrefix("FWD: Hello", "Fwd:")).toBe("FWD: Hello");
  });
});

describe("quoteBody", () => {
  it("prefixes every line with > and keeps blank lines as bare >", () => {
    expect(quoteBody("a\n\nb")).toBe("> a\n>\n> b");
  });
});

describe("buildReplyOptions", () => {
  const original = parseOriginalHeaders(RAW);

  it("replies to the sender with Re: subject and full threading headers", () => {
    const opts = buildReplyOptions({
      original,
      originalPlainText: "Here is the original body.",
      body: "Thanks!",
      replyAll: false,
      self: ["me@myhost.com"],
      from: "me@myhost.com",
    });
    expect(opts.to).toEqual(["alice@example.com"]);
    expect(opts.cc).toBeUndefined();
    expect(opts.subject).toBe("Re: Project status");
    expect(opts.inReplyTo).toBe("<orig-123@example.com>");
    expect(opts.references).toEqual([
      "<root-1@example.com>",
      "<root-2@example.com>",
      "<orig-123@example.com>",
    ]);
    expect(opts.body).toContain("Thanks!");
    expect(opts.body).toContain("> Here is the original body.");
  });

  it("reply-all adds the other recipients as Cc, excluding self and the sender", () => {
    const opts = buildReplyOptions({
      original,
      originalPlainText: "",
      body: "All:",
      replyAll: true,
      self: ["me@myhost.com"],
      from: "me@myhost.com",
    });
    expect(opts.to).toEqual(["alice@example.com"]);
    // To list had bob@work.com + me@myhost.com (self, dropped); Cc had carol.
    expect(opts.cc).toEqual(["bob@work.com", "carol@work.com"]);
  });

  it("omits threading headers and quote when the original lacks a Message-ID/body", () => {
    const bare = parseOriginalHeaders(["From: a@x.com", "Subject: Hi", "", ""].join("\r\n"));
    const opts = buildReplyOptions({
      original: bare,
      originalPlainText: "",
      body: "yo",
      replyAll: false,
      self: [],
    });
    expect(opts.inReplyTo).toBeUndefined();
    expect(opts.references).toBeUndefined();
    expect(opts.body).toBe("yo");
  });
});

describe("buildForwardOptions", () => {
  const original = parseOriginalHeaders(RAW);

  it("builds a Fwd: message with the forwarded header block and no threading", () => {
    const opts = buildForwardOptions({
      original,
      originalPlainText: "Here is the original body.",
      to: ["dave@elsewhere.com"],
      body: "FYI",
      from: "me@myhost.com",
    });
    expect(opts.to).toEqual(["dave@elsewhere.com"]);
    expect(opts.subject).toBe("Fwd: Project status");
    expect(opts.inReplyTo).toBeUndefined();
    expect(opts.references).toBeUndefined();
    expect(opts.body).toContain("FYI");
    expect(opts.body).toContain("---------- Forwarded message ----------");
    expect(opts.body).toContain("From: alice@example.com");
    expect(opts.body).toContain("Subject: Project status");
    expect(opts.body).toContain("Here is the original body.");
  });
});
