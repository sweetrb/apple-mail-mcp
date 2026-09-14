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
import { messageSummary } from "./respond.js";
import type { Message } from "@/types.js";

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
