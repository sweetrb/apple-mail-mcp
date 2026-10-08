/**
 * #270 part 2 — root cause found by @j5pu: a numeric id that is not where the
 * lookup expects it fell back to `messages of mb whose id is N` over EVERY
 * mailbox of every account. That probe costs ~1s on a 25k-message mailbox,
 * 8-17s on 255k and 10-32s on 794k, so the full scan took 21-53s and hit the
 * 15s by-id timeout — and an explicit `account` + `mailbox`, or a stale
 * remembered location (message moved by another client), fell back to that
 * same unscoped scan.
 *
 * Pinned here, with executeAppleScript mocked (no Mail.app):
 *   (a) an explicit account+mailbox hint that misses is a clean, scoped
 *       "not found" — exactly one osascript call, no fallback;
 *   (b) a stale idLocationIndex entry is evicted, then the read falls back to
 *       the bounded scan (and the next read goes straight to it);
 *   (c) the unscoped scan skips mailboxes above the size threshold and stops at
 *       its in-script budget, and a miss names what it did not cover;
 * across all four read-only by-id lookups, which now share one resolver.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type ScriptResult = { success: boolean; output: string; error?: string; timedOut?: boolean };

const h = vi.hoisted(() => ({
  calls: [] as Array<{ script: string; options: Record<string, unknown> | undefined }>,
  router: {
    fn: (_script: string): ScriptResult => ({ success: true, output: "" }),
  },
}));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string, options?: Record<string, unknown>) => {
      h.calls.push({ script, options });
      return h.router.fn(script);
    },
  };
});

import {
  AppleMailManager,
  describeUnscopedMiss,
  getByIdScanThreshold,
} from "@/services/appleMailManager.js";

const ERR = "\x1dERR\x1d";
const SCOPED = "\x1dSCOPED\x1d";
const COV = "\x1dCOV\x1d";
const F = "\x1dF\x1d";
const M = "\x1dM\x1d";
const FS = "\x1f";
const CONTENT_OK = "Subj\x1dMSGID\x1d<a@b>\x1dDATES\x1d\x1dCONTENT\x1dbody\x1dHTML\x1d";

const isScoped = (s: string) => s.includes(SCOPED);
const isUnscoped = (s: string) => s.includes("_budgetHit");
/**
 * Only the by-id scripts themselves — resolving a hinted mailbox name first
 * lists the account's mailboxes (cached), which is not a by-id lookup.
 */
const byId = () => h.calls.filter((c) => isScoped(c.script) || isUnscoped(c.script));
const kinds = () => byId().map((c) => (isScoped(c.script) ? "scoped" : "unscoped"));

/** The four read-only by-id entry points, each as (mgr, id, hint) → hit?. */
const READS: Array<
  [
    string,
    (m: AppleMailManager, id: string, hint?: { account: string; mailbox: string }) => unknown,
  ]
> = [
  ["getMessageContent", (m, id, hint) => m.getMessageContent(id, false, hint)],
  ["getMessageHeaders", (m, id, hint) => m.getMessageHeaders(id, hint)],
  ["getRawSource", (m, id, hint) => m.getRawSource(id, hint)],
];

describe("#270 (a) — an explicit account+mailbox hint never falls back to the full scan", () => {
  let mgr: AppleMailManager;
  beforeEach(() => {
    h.calls.length = 0;
    mgr = new AppleMailManager();
  });

  for (const [name, read] of READS) {
    it(`${name}: a scoped miss returns "not found in <account> / <mailbox>" after ONE call`, () => {
      h.router.fn = (s) => ({
        success: true,
        output: isScoped(s) ? `${ERR}${SCOPED}nomessage` : "SHOULD NOT RUN",
      });
      expect(read(mgr, "1297094", { account: "iCloud", mailbox: "Archive" })).toBeNull();
      expect(byId()).toHaveLength(1);
      expect(kinds()).toEqual(["scoped"]);
      expect(isUnscoped(byId()[0].script)).toBe(false);
      expect(mgr.consumeLastMessageLookupError()).toBe(
        "Message 1297094 not found in iCloud / Archive — it may have been moved or deleted. Re-list or search to get its current id, or omit account/mailbox to scan every mailbox."
      );
    });
  }

  it("an unresolvable mailbox is reported as such, without a scan", () => {
    h.router.fn = () => ({ success: true, output: `${ERR}${SCOPED}nomailbox` });
    expect(mgr.getMessageContent("7", false, { account: "Work", mailbox: "Nope" })).toBeNull();
    expect(byId()).toHaveLength(1);
    expect(mgr.consumeLastMessageLookupError()).toMatch(
      /^Mailbox "Nope" not found in account "Work" — message 7 was not looked up\./
    );
  });

  it("Mail's own error from the scoped read is surfaced, without a scan", () => {
    h.router.fn = () => ({
      success: true,
      output: `${ERR}${SCOPED}error:Can't get account "Wrok". (-1728)`,
    });
    expect(mgr.getRawSource("7", { account: "Wrok", mailbox: "INBOX" })).toBeNull();
    expect(byId()).toHaveLength(1);
    expect(mgr.consumeLastMessageLookupError()).toBe(
      `Could not read message 7 from Wrok / INBOX: Can't get account "Wrok". (-1728)`
    );
  });

  it("a scoped hit is returned as before", () => {
    h.router.fn = (s) => ({ success: true, output: isScoped(s) ? CONTENT_OK : "" });
    expect(mgr.getMessageContent("7", false, { account: "Work", mailbox: "INBOX" })).toMatchObject({
      subject: "Subj",
      plainText: "body",
      rfcMessageId: "a@b",
    });
    expect(byId()).toHaveLength(1);
  });

  it("a scoped timeout is reported as a timeout and not followed by a scan", () => {
    h.router.fn = () => ({ success: false, output: "", error: "timed out", timedOut: true });
    expect(mgr.getMessageHeaders("7", { account: "Work", mailbox: "INBOX" })).toBeNull();
    expect(byId()).toHaveLength(1);
    expect(mgr.consumeLastMessageLookupError()).toBe(
      "AppleScript timed out resolving id 7 — Mail.app's scripting bridge may be wedged; try health-check."
    );
  });

  it("the scoped script reports its misses instead of swallowing them", () => {
    mgr.getRawSource("7", { account: "Work", mailbox: "INBOX" });
    const s = byId()[0].script;
    expect(s).toContain(`return "${ERR}${SCOPED}nomailbox"`);
    expect(s).toContain(`return "${ERR}${SCOPED}nomessage"`);
    expect(s).toContain(`return "${ERR}${SCOPED}error:" & errMsg`);
  });
});

describe("#270 (b) — a stale remembered location is evicted, then the bounded scan runs", () => {
  let mgr: AppleMailManager;
  beforeEach(() => {
    h.calls.length = 0;
    mgr = new AppleMailManager();
  });

  for (const [name, read] of READS) {
    it(`${name}: stale entry → evict → unscoped scan; the next read skips the stale scope`, () => {
      mgr.noteMessageLocation("42", "Work", "INBOX");
      h.router.fn = (s) => ({
        success: true,
        output: isScoped(s) ? `${ERR}${SCOPED}nomessage` : `${ERR}Message not found${COV}${F}false`,
      });
      expect(read(mgr, "42")).toBeNull();
      expect(kinds()).toEqual(["scoped", "unscoped"]);
      expect(mgr.consumeLastMessageLookupError()).toBe("Message not found");

      h.calls.length = 0;
      read(mgr, "42");
      expect(kinds()).toEqual(["unscoped"]);
    });
  }

  it("a non-timeout failure of a remembered scope also evicts and falls back", () => {
    mgr.noteMessageLocation("42", "Work", "INBOX");
    h.router.fn = (s) =>
      isScoped(s)
        ? { success: false, output: "", error: "boom" }
        : { success: true, output: CONTENT_OK };
    expect(mgr.getMessageContent("42")).toMatchObject({ subject: "Subj" });
    expect(byId()).toHaveLength(2);
    expect(isUnscoped(byId()[1].script)).toBe(true);
  });

  it("a timeout on a remembered scope does NOT add a second 15s scan", () => {
    mgr.noteMessageLocation("42", "Work", "INBOX");
    h.router.fn = () => ({ success: false, output: "", error: "timed out", timedOut: true });
    expect(mgr.getRawSource("42")).toBeNull();
    expect(byId()).toHaveLength(1);
    expect(mgr.consumeLastMessageLookupError()).toMatch(/^AppleScript timed out resolving id 42/);
  });

  it("an explicit hint wins over a remembered location", () => {
    mgr.noteMessageLocation("42", "Work", "INBOX");
    h.router.fn = () => ({ success: true, output: CONTENT_OK });
    mgr.getMessageContent("42", false, { account: "Home", mailbox: "Receipts" });
    expect(byId()[0].script).toContain('first account whose name is "Home"');
  });
});

describe("#270 (c) — the unscoped scan is bounded and says what it skipped", () => {
  let mgr: AppleMailManager;
  const saved = process.env.APPLE_MAIL_MAX_BYID_SCAN_MAILBOX;
  beforeEach(() => {
    h.calls.length = 0;
    delete process.env.APPLE_MAIL_MAX_BYID_SCAN_MAILBOX;
    mgr = new AppleMailManager();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.APPLE_MAIL_MAX_BYID_SCAN_MAILBOX;
    else process.env.APPLE_MAIL_MAX_BYID_SCAN_MAILBOX = saved;
  });

  it("guards each mailbox (accounts AND local store) by size and by the in-script budget", () => {
    h.router.fn = () => ({ success: true, output: "" });
    mgr.getMessageContent("42");
    const s = byId()[0].script;
    expect((s.match(/if _mbCount < 0 or _mbCount > 50000 then/g) ?? []).length).toBe(2);
    expect((s.match(/with timeout of 3 seconds/g) ?? []).length).toBe(2);
    expect((s.match(/if \(\(current date\) - _startedAt\) > 9 then/g) ?? []).length).toBe(2);
    expect(s).toContain('set _skipped to _skipped & (name of acct) & " / " & _skipPath');
    expect(s).toContain(
      `return "${ERR}Message not found${COV}" & _skipped & "${F}" & (_budgetHit as string)`
    );
    // The id probe itself only runs for a mailbox that passed the guard.
    expect(s).toMatch(
      /if _probe then\s+try\s+set matchingMsgs to \(messages of mb whose id is 42\)/
    );
  });

  it("#270 follow-up (@j5pu) — the count probe itself is capped and fails toward 'skip'", () => {
    h.router.fn = () => ({ success: true, output: "" });
    mgr.getMessageContent("42");
    const s = byId()[0].script;
    // The probe defaults to the -1 sentinel, is wrapped in its own timeout,
    // and a probe that never reset the sentinel (timed out) gets the same
    // "too large, skip it" treatment as a confirmed over-threshold mailbox —
    // never falls through to default-small.
    expect(s).toContain("set _mbCount to -1");
    expect(s).toMatch(
      /try\s+with timeout of 3 seconds\s+set _mbCount to count of messages of mb\s+end timeout\s+end try/
    );
    expect(s).toContain('set _sizeLabel to "size unknown (count probe exceeded 3s)"');
    expect(s).toContain("if _mbCount > -1 then set _sizeLabel to (_mbCount as string)");
    expect(s).toContain(
      'set _skipped to _skipped & (name of acct) & " / " & _skipPath & " (" & _sizeLabel & ")'
    );
  });

  it("a miss naming a size-unknown (probe-timed-out) mailbox reads the same as a counted one", () => {
    h.router.fn = () => ({
      success: true,
      output: `${ERR}Message not found${COV}iCloud / Archive (size unknown (count probe exceeded 3s))${F}false`,
    });
    expect(mgr.getMessageContent("1297094")).toBeNull();
    expect(mgr.consumeLastMessageLookupError()).toBe(
      "Message 1297094 not found in the mailboxes scanned. Not scanned — too large for a cross-mailbox id scan (over 50000 messages; APPLE_MAIL_MAX_BYID_SCAN_MAILBOX): iCloud / Archive (size unknown (count probe exceeded 3s)). If the message is in a mailbox that was not scanned, pass account + mailbox to read it from that mailbox directly, or use its imap: id from list-messages/search-messages."
    );
  });

  it("APPLE_MAIL_MAX_BYID_SCAN_MAILBOX overrides the threshold; 0 disables the guard", () => {
    process.env.APPLE_MAIL_MAX_BYID_SCAN_MAILBOX = "100000";
    mgr.getRawSource("42");
    expect(byId()[0].script).toContain("if _mbCount < 0 or _mbCount > 100000 then");

    process.env.APPLE_MAIL_MAX_BYID_SCAN_MAILBOX = "0";
    mgr.getRawSource("42");
    expect(byId()[1].script).not.toContain("_mbCount");
    expect(byId()[1].script).toContain("messages of mb whose id is 42");
  });

  it("a miss with skipped mailboxes names them and says how to reach them", () => {
    h.router.fn = () => ({
      success: true,
      output: `${ERR}Message not found${COV}iCloud / Archive (793630)${M}iCloud / Recovered (255104)${M}${F}false`,
    });
    expect(mgr.getMessageContent("1297094")).toBeNull();
    expect(mgr.consumeLastMessageLookupError()).toBe(
      "Message 1297094 not found in the mailboxes scanned. Not scanned — too large for a cross-mailbox id scan (over 50000 messages; APPLE_MAIL_MAX_BYID_SCAN_MAILBOX): iCloud / Archive (793630), iCloud / Recovered (255104). If the message is in a mailbox that was not scanned, pass account + mailbox to read it from that mailbox directly, or use its imap: id from list-messages/search-messages."
    );
  });

  it("the same diagnostic reaches getMessageHeaders, getRawSource and getMessageById", () => {
    h.router.fn = () => ({
      success: true,
      output: `${ERR}Message not found${COV}iCloud / Archive (793630)${M}${F}false`,
    });
    for (const read of [
      () => mgr.getMessageHeaders("9"),
      () => mgr.getRawSource("9"),
      () => mgr.getMessageById("9"),
    ]) {
      expect(read()).toBeNull();
      expect(mgr.consumeLastMessageLookupError()).toContain("iCloud / Archive (793630)");
    }
  });

  it("a budget-exhausted miss says the scan stopped early", () => {
    h.router.fn = () => ({ success: true, output: `${ERR}Message not found${COV}${F}true` });
    expect(mgr.getRawSource("5")).toBeNull();
    expect(mgr.consumeLastMessageLookupError()).toBe(
      "Message 5 not found in the mailboxes scanned. The scan also stopped after its 9s budget before reaching every mailbox. If the message is in a mailbox that was not scanned, pass account + mailbox to read it from that mailbox directly, or use its imap: id from list-messages/search-messages."
    );
  });

  it("a complete scan that found nothing is still a plain 'Message not found'", () => {
    h.router.fn = () => ({ success: true, output: `${ERR}Message not found${COV}${F}false` });
    expect(mgr.getMessageHeaders("5")).toBeNull();
    expect(mgr.consumeLastMessageLookupError()).toBe("Message not found");
  });

  it("the ambiguity refusal is unchanged for content/headers/source", () => {
    mgr.getMessageHeaders("42");
    expect(byId()[0].script).toContain("if (count of _hits) > 1 then return");
  });
});

describe("#270 — getMessageById shares the resolver", () => {
  let mgr: AppleMailManager;
  beforeEach(() => {
    h.calls.length = 0;
    mgr = new AppleMailManager();
  });

  const row = [
    "Hello",
    "a@b.c",
    "Monday, 5 October 2026 at 10:00:00",
    "true",
    "false",
    "false",
    "false",
    "Archive/2026",
    "Work",
    "false",
  ].join(FS);

  it("first-hit scan (no ambiguity refusal), bounded, and records the location", () => {
    h.router.fn = (s) => ({ success: true, output: isUnscoped(s) ? row : "" });
    const msg = mgr.getMessageById("42");
    expect(msg).toMatchObject({ subject: "Hello", mailbox: "Archive/2026", account: "Work" });
    const s = byId()[0].script;
    expect(s).not.toContain("if (count of _hits) > 1 then return");
    expect(s).toContain("if (count of _hits) > 0 then exit repeat");
    expect(s).toContain("if _mbCount < 0 or _mbCount > 50000 then");
    expect(s).toContain("set msgAccount to _hitAcct");

    // The recorded location now scopes the next read.
    h.calls.length = 0;
    h.router.fn = () => ({ success: true, output: CONTENT_OK });
    mgr.getMessageContent("42");
    expect(byId()).toHaveLength(1);
    expect(byId()[0].script).toContain('first account whose name is "Work"');
  });

  it("uses a remembered location first, and evicts it when stale", () => {
    mgr.noteMessageLocation("42", "Work", "INBOX");
    h.router.fn = (s) => ({
      success: true,
      output: isScoped(s) ? `${ERR}${SCOPED}nomessage` : row,
    });
    expect(mgr.getMessageById("42")).toMatchObject({ mailbox: "Archive/2026" });
    expect(kinds()).toEqual(["scoped", "unscoped"]);
  });
});

describe("describeUnscopedMiss / getByIdScanThreshold", () => {
  const saved = process.env.APPLE_MAIL_MAX_BYID_SCAN_MAILBOX;
  afterEach(() => {
    if (saved === undefined) delete process.env.APPLE_MAIL_MAX_BYID_SCAN_MAILBOX;
    else process.env.APPLE_MAIL_MAX_BYID_SCAN_MAILBOX = saved;
  });

  it("passes through outcomes without a coverage trailer (e.g. the ambiguity refusal)", () => {
    expect(describeUnscopedMiss("1", "Message id 1 is present in more than one mailbox (…)")).toBe(
      "Message id 1 is present in more than one mailbox (…)"
    );
  });

  it("defaults to 50000 and ignores junk overrides", () => {
    delete process.env.APPLE_MAIL_MAX_BYID_SCAN_MAILBOX;
    expect(getByIdScanThreshold()).toBe(50000);
    process.env.APPLE_MAIL_MAX_BYID_SCAN_MAILBOX = "abc";
    expect(getByIdScanThreshold()).toBe(50000);
    process.env.APPLE_MAIL_MAX_BYID_SCAN_MAILBOX = "-5";
    expect(getByIdScanThreshold()).toBe(50000);
    process.env.APPLE_MAIL_MAX_BYID_SCAN_MAILBOX = "";
    expect(getByIdScanThreshold()).toBe(50000);
    process.env.APPLE_MAIL_MAX_BYID_SCAN_MAILBOX = "0";
    expect(getByIdScanThreshold()).toBe(0);
  });
});
