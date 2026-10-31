/**
 * Tests for `messageSummary`, the `structuredContent` shape shared by the
 * AppleScript-backed search-messages, list-messages, and get-thread (subject
 * fallback) tools (#226 follow-up).
 *
 * `Message.dateReceived` is typed as a plain `Date`, but `parseAppleScriptDate`
 * (appleMailManager.ts) returns `new Date(NaN)` — never `undefined` — when
 * Mail's own "date received" / "date sent" property doesn't parse (#230: "an
 * unparseable AppleScript date is omitted, never fabricated"). `instanceof
 * Date` is true for an invalid Date too, so the old unconditional
 * `m.dateReceived.toISOString()` threw `RangeError: Invalid time value` for
 * any AppleScript-sourced row whose arrival date Mail couldn't parse — the
 * exact crash @j5pu reported on search-messages against a mailbox migrated
 * from Entourage/Outlook for Mac with Spanish-locale Date: headers ("jue ago
 * 30 13:55:12 2007").
 */

import { describe, it, expect } from "vitest";
import { formatMessageLines, messageSummary, searchBackendInfo } from "./respond.js";
import type { Message, SearchDiagnostics } from "@/types.js";

function baseMessage(dateReceived: Date): Message {
  return {
    id: "1",
    subject: "diferencial de temperatura",
    sender: "someone@example.com",
    recipients: [],
    dateReceived,
    isRead: false,
    isFlagged: false,
    isJunk: false,
    isDeleted: false,
    mailbox: "INBOX",
    account: "XXX",
    hasAttachments: false,
  };
}

describe("messageSummary", () => {
  it("emits a valid dateReceived as ISO", () => {
    const d = new Date("2026-08-15T12:30:00Z");
    expect(messageSummary(baseMessage(d)).dateReceived).toBe(d.toISOString());
  });

  it("omits (never throws on) an Invalid Date dateReceived", () => {
    const invalid = new Date(NaN);
    expect(Number.isNaN(invalid.getTime())).toBe(true);
    expect(() => messageSummary(baseMessage(invalid))).not.toThrow();
    expect(messageSummary(baseMessage(invalid)).dateReceived).toBe("");
  });
});

describe("searchBackendInfo (#342)", () => {
  const diag = (backendByAccount?: SearchDiagnostics["backendByAccount"]): SearchDiagnostics => ({
    partial: false,
    timedOutAccounts: [],
    skippedLargeMailboxes: [],
    notSearchedMailboxes: [],
    ...(backendByAccount ? { backendByAccount } : {}),
  });

  it("reports applescript, with no summary note, when untagged (index off)", () => {
    expect(searchBackendInfo(diag())).toEqual({ backend: "applescript", note: "" });
  });

  it("names a single backend in the summary note", () => {
    expect(searchBackendInfo(diag({ Google: "envelope-index", Work: "envelope-index" }))).toEqual({
      backend: "envelope-index",
      note: " [backend: envelope-index]",
    });
  });

  it("reports mixed backends per account", () => {
    expect(searchBackendInfo(diag({ Google: "envelope-index", Work: "applescript" }))).toEqual({
      backend: "mixed",
      backendByAccount: { Google: "envelope-index", Work: "applescript" },
      note: " [backend: Google: envelope-index, Work: applescript]",
    });
  });
});

describe("formatMessageLines", () => {
  const at = (id: string, mailbox: string, account: string, isRead = false): Message => ({
    ...baseMessage(new Date("2026-10-28T23:49:08Z")),
    id,
    mailbox,
    account,
    isRead,
  });
  const where = (text: string) =>
    text.split("\n").map((l) => (l.includes(" | in ") ? l.slice(l.indexOf(" | in ")) : ""));

  // One email that was sent, and two earlier drafts of it in Exchange's trash.
  const sentAndDrafts = [
    at("72982", "Sent Items", "Exchange", true),
    at("72984", "Deleted Items", "Exchange", true),
    at("72980", "Deleted Items", "Exchange", true),
  ];

  it("says where each message is when the call didn't name a mailbox", () => {
    const text = formatMessageLines(sentAndDrafts, { readState: true, account: "Exchange" });
    expect(text.split("\n")[0]).toMatch(
      /^ {2}- ID: 72982 \| .+ \| diferencial de temperatura \(from: someone@example\.com\) \[read\] \| in "Sent Items" \(Exchange\)$/
    );
    expect(where(text)).toEqual([
      ' | in "Sent Items" (Exchange)',
      ' | in "Deleted Items" (Exchange)',
      ' | in "Deleted Items" (Exchange)',
    ]);
  });

  it("says where each message is when the call didn't name an account", () => {
    const text = formatMessageLines([at("1", "INBOX", "Work"), at("2", "INBOX", "Home")], {
      readState: false,
      mailbox: "INBOX",
    });
    expect(where(text)).toEqual([' | in "INBOX" (Work)', ' | in "INBOX" (Home)']);
    expect(text).not.toContain("[unread]");
  });

  it("leaves the lines as they were when the call named one mailbox of one account", () => {
    const inbox = [at("1", "INBOX", "Work"), at("2", "INBOX", "Work", true)];
    const text = formatMessageLines(inbox, { readState: true, mailbox: "INBOX", account: "Work" });
    expect(where(text)).toEqual(["", ""]);
    expect(text.split("\n")[1]).toMatch(/\[read\]$/);
  });

  it("still says where when a named mailbox is read from several (a Gmail-style INBOX)", () => {
    const gmailInbox = [
      at("1", "[Gmail]/All Mail", "Google"),
      at("2", "[Gmail]/Important", "Google"),
    ];
    const text = formatMessageLines(gmailInbox, {
      readState: false,
      mailbox: "INBOX",
      account: "Google",
    });
    expect(where(text)).toEqual([
      ' | in "[Gmail]/All Mail" (Google)',
      ' | in "[Gmail]/Important" (Google)',
    ]);
  });

  it("is empty for no messages", () => {
    expect(formatMessageLines([], { readState: true })).toBe("");
  });
});
