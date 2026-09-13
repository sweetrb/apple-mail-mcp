/**
 * A date that cannot be parsed must be OMITTED, never invented (#229).
 *
 * `parseAppleScriptDate` used to return `new Date()` when parsing failed, which
 * is indistinguishable from a real timestamp — a message whose `Date:` header
 * the parser did not recognise silently claimed to have been sent *now*. It
 * also made the guard in `parseMessageDates`
 *     Number.isNaN(d.getTime()) ? undefined : d
 * permanently dead, because a fabricated `new Date()` is perfectly valid.
 *
 * Reported by @j5pu against a legacy iCloud mailbox migrated from Entourage,
 * whose headers carry Spanish-locale dates such as `mié oct 10 14:25:15 2007`.
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

/** Build the wire record `getMessageContent` parses: subject{MSGID}rfcId{DATES}pair{CONTENT}body */
function record(datesPair: string): string {
  return (
    "RE: " +
    MSGID_MARKER +
    "<337BB11B@veveo.net>" +
    DATES_MARKER +
    datesPair +
    CONTENT_MARKER +
    "body text"
  );
}

describe("#229 — an unparseable date is omitted, not fabricated", () => {
  it("omits dateSent when the date string cannot be parsed at all", () => {
    // ⚠️ NOT the Spanish string from the report — `new Date("mié oct 10
    // 14:25:15 2007")` succeeds in V8 (it ignores the weekday and reads
    // "oct 10 ... 2007"), so that shape never reaches the failure path. Use a
    // value that genuinely fails, or this test proves nothing.
    h.output = record("zzz|zzz");
    const got = new AppleMailManager().getMessageContent("345559");
    // ⚠️ Assert the parse SUCCEEDED first. Without this the test passes
    // vacuously when getMessageContent returns null — `null?.dateSent` is
    // undefined, which is exactly what we are asserting.
    expect(got, "mock record did not parse — the test would pass vacuously").not.toBeNull();

    // The regression: this used to be `new Date()` — today's date, presented
    // as though it were the message's own.
    if (got && "dateSent" in got && got.dateSent !== undefined) {
      const drift = Math.abs(Date.now() - new Date(got.dateSent as unknown as string).getTime());
      expect(
        drift,
        "dateSent was fabricated from the current clock rather than omitted"
      ).toBeGreaterThan(60_000);
    } else {
      expect(got?.dateSent).toBeUndefined();
    }
  });

  it("still returns a real date when the header IS parseable", () => {
    h.output = record("2007-10-10-14-25-15|2007-10-10-14-25-15");
    const got = new AppleMailManager().getMessageContent("345559");
    expect(got).not.toBeNull();
    const d = got?.dateSent as Date | undefined;
    expect(d).toBeInstanceOf(Date);
    expect(Number.isNaN(d!.getTime())).toBe(false);
    expect(d!.getFullYear()).toBe(2007);
  });

  it("parses the Spanish-locale shape from #229 rather than failing on it", () => {
    // Recorded because it is counter-intuitive and was my first wrong theory:
    // V8 parses this, so #229's fabricated date did NOT come from this string.
    h.output = record("mié oct 10 14:25:15 2007|mié oct 10 14:25:15 2007");
    const got = new AppleMailManager().getMessageContent("345559");
    expect(got).not.toBeNull();
    expect((got?.dateSent as Date | undefined)?.getFullYear()).toBe(2007);
  });

  it("omits both dates when the pair is empty", () => {
    h.output = record("|");
    const got = new AppleMailManager().getMessageContent("345559");
    expect(got, "mock record did not parse — the test would pass vacuously").not.toBeNull();
    expect(got?.dateSent).toBeUndefined();
  });
});
