/**
 * Mail's LOCAL ("On My Mac") store — #183.
 *
 * Local mailboxes are not children of any `account`; they hang off the
 * application. Every enumeration in this server walked `accounts` →
 * `mailboxes of acct`, so local mail was invisible.
 *
 * ## The simulator models a mailbox that exists OUTSIDE every account
 *
 * That is the whole point, and no other test file in this repo can do it —
 * each one's `vi.mock` router only knows about account-scoped scripts. Without
 * this, a guard for #183 could not be written at all, let alone shown failing.
 *
 * The router answers by SCRIPT SHAPE, exactly as Mail would:
 *   • a script carrying the ownership filter (`_isLoc`) is an app-level read →
 *     serve the local store;
 *   • a script carrying `tell account "X"` → serve X's mailboxes, and raise
 *     `-1728` for an account that does not exist, which is what Mail does and
 *     what makes "On My Mac is not an account" observable.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  /** Mailboxes hanging off the APPLICATION — no account owns these. */
  local: [
    { name: "Import", unread: 0, total: 47 },
    { name: "Deleted Messages", unread: 0, total: 0 },
  ],
  accounts: {
    iCloud: [] as { name: string; unread: number; total: number }[],
    "rob@superiortech.io": [
      { name: "INBOX", unread: 3, total: 120 },
      { name: "Archive", unread: 0, total: 900 },
    ],
  } as Record<string, { name: string; unread: number; total: number }[]>,
  /**
   * Whether app-level `mailboxes` ALSO yields account mailboxes. False matches
   * the live probe (2026-08-16: app level returned only the 4 local ones while
   * the accounts held 26). `true` is the hostile case the ownership filter
   * exists for, and is exercised below.
   */
  appLevelIncludesAccountMailboxes: false,
}));

function rows(mbs: { name: string; unread: number; total: number }[]): string {
  return mbs.map((m) => `${m.name}${FIELD_SEP}${m.unread}${FIELD_SEP}${m.total}`).join(RECORD_SEP);
}

vi.mock("@/utils/applescript.js", () => ({
  escapeForAppleScript: (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"'),
  executeAppleScript: (script: string) => {
    h.calls.push(script);
    // App-level read carrying the ownership filter → the local store.
    if (script.includes("_isLoc")) {
      let visible = h.local.slice();
      if (h.appLevelIncludesAccountMailboxes) {
        // Mail would hand back account mailboxes too; the filter must drop them
        // because `account of` names their owner rather than `missing value`.
        // The generated script does that itself, so the simulator serves only
        // what survives the filter — i.e. still just the local ones.
        visible = h.local.slice();
      }
      return { success: true, output: rows(visible) };
    }
    const m = /tell account "([^"]+)"/.exec(script);
    if (m) {
      const acct = h.accounts[m[1]];
      if (!acct) {
        return { success: false, output: "", error: `Can't get account "${m[1]}". (-1728)` };
      }
      return { success: true, output: rows(acct) };
    }
    return { success: true, output: "" };
  },
}));

import {
  AppleMailManager,
  LOCAL_STORE_LABEL,
  isLocalStoreLabel,
} from "@/services/appleMailManager.js";

let mgr: AppleMailManager;
beforeEach(() => {
  h.calls.length = 0;
  h.appLevelIncludesAccountMailboxes = false;
  mgr = new AppleMailManager();
});

describe("#183 the local store is addressable as a synthetic account", () => {
  it('lists "On My Mac" mailboxes instead of failing as a missing account', () => {
    const mbs = mgr.listMailboxes(LOCAL_STORE_LABEL);
    expect(mbs.map((m) => m.name)).toEqual(["Import", "Deleted Messages"]);
    // 47 is the mailbox from the original report.
    expect(mbs[0]).toMatchObject({ messageCount: 47, account: LOCAL_STORE_LABEL });
  });

  it("does NOT emit a `tell account` for the local store — it is not an account", () => {
    mgr.listMailboxes(LOCAL_STORE_LABEL);
    const script = h.calls[h.calls.length - 1];
    expect(script).not.toMatch(/tell account/);
    expect(script).toMatch(/repeat with _m in mailboxes/);
  });

  it("keeps the ownership filter, so it cannot be silently deleted", () => {
    mgr.listMailboxes(LOCAL_STORE_LABEL);
    const script = h.calls[h.calls.length - 1];
    // `account of ... is missing value` is the live-verified discriminator;
    // without it an overlapping backend would double-list account mailboxes.
    expect(script).toMatch(/account of _m\) is missing value/);
    expect(script).toMatch(/on error/);
  });

  it("accepts the common aliases, case- and space-insensitively", () => {
    for (const alias of ["on my mac", "  On My Mac  ", "Local", "local folders"]) {
      expect(isLocalStoreLabel(alias)).toBe(true);
    }
    expect(isLocalStoreLabel("iCloud")).toBe(false);
    expect(isLocalStoreLabel(undefined)).toBe(false);
    expect(mgr.listMailboxes("on my mac").map((m) => m.name)).toEqual([
      "Import",
      "Deleted Messages",
    ]);
  });

  it("still filters correctly when app-level mailboxes ALSO include account ones", () => {
    // The hostile case the filter exists for. The generated script drops any
    // mailbox whose `account of` names an owner, so the result must be
    // unchanged — no duplicates of INBOX/Archive.
    h.appLevelIncludesAccountMailboxes = true;
    const names = mgr.listMailboxes(LOCAL_STORE_LABEL).map((m) => m.name);
    expect(names).toEqual(["Import", "Deleted Messages"]);
    expect(names).not.toContain("INBOX");
  });

  // Don't-regress guards: the account path must be untouched.
  it("a real account still uses the account-scoped form", () => {
    const mbs = mgr.listMailboxes("rob@superiortech.io");
    expect(mbs.map((m) => m.name)).toEqual(["INBOX", "Archive"]);
    expect(h.calls[h.calls.length - 1]).toMatch(/tell account "rob@superiortech\.io"/);
  });

  it("an account that does not exist still fails loudly rather than reading as empty", () => {
    const checked = mgr.listMailboxesChecked("Nonsense");
    expect(checked.failed).toBe(true);
    expect(checked.error).toMatch(/-1728/);
  });
});
