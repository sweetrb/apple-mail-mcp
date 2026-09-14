/**
 * #234 §2b — Mail's own `date sent` can be INVENTED, and the tell is that it is
 * later than `date received`, which cannot happen for a real message.
 *
 * Reported by @j5pu: for a 2007 message migrated from Entourage, Mail.app's
 * `date sent` property is 2024-08-24 while its `date received` is 2014-01-14.
 * The `Date:` header is a Spanish-locale string Mail cannot parse, so Mail
 * substitutes a timestamp of its own. #230's contract is that a date is parsed
 * if possible, omitted if not, never invented — so a send time more than the
 * clock-skew tolerance after arrival is omitted.
 *
 * executeAppleScript is fully mocked, so no running Mail.app is needed.
 */
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ output: "" }));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: () => ({
      success: true,
      output: h.output,
      error: undefined as string | undefined,
    }),
  };
});

const { AppleMailManager } = await import("./appleMailManager.js");

const MSGID_MARKER = "\x1dMSGID\x1d";
const DATES_MARKER = "\x1dDATES\x1d";
const CONTENT_MARKER = "\x1dCONTENT\x1d";

/** The wire record getMessageContent parses: subject{MSGID}rfcId{DATES}sent|received{CONTENT}body */
function record(datesPair: string): string {
  return (
    "diferencial" + MSGID_MARKER + "" + DATES_MARKER + datesPair + CONTENT_MARKER + "body text"
  );
}

describe("#234 §2b — AppleScript get-message never emits a dateSent later than dateReceived", () => {
  it("omits Mail's invented date sent (2024-08-24) for a message received 2014-01-14", () => {
    h.output = record("2024-8-24-2-26-38|2014-1-14-13-53-59");
    const got = new AppleMailManager().getMessageContent("345559");
    expect(got, "mock record did not parse — the test would pass vacuously").not.toBeNull();
    expect(got?.dateReceived).toBeInstanceOf(Date);
    expect(got?.dateSent).toBeUndefined();
  });

  it("keeps a send time a few hours ahead of arrival (ordinary sender clock skew)", () => {
    h.output = record("2014-1-14-18-00-00|2014-1-14-13-53-59");
    const got = new AppleMailManager().getMessageContent("345559");
    expect(got).not.toBeNull();
    expect(got?.dateSent).toBeInstanceOf(Date);
    expect(got?.dateSent?.getHours()).toBe(18);
  });

  it("keeps the normal case — sent before received", () => {
    h.output = record("2007-8-30-13-55-12|2014-1-14-13-53-59");
    const got = new AppleMailManager().getMessageContent("345559");
    expect(got?.dateSent?.getFullYear()).toBe(2007);
  });
});
