import { describe, it, expect } from "vitest";
import { splitSearchDiagnostics, mergeSearchDiagnostics } from "@/services/appleMailManager.js";
import type { SearchDiagnostics } from "@/types.js";

// Control-character separators must match the constants in appleMailManager.ts
// (issue #30): GS-wrapped markers + RS/US field/record separators.
const DIAG = "\x1dDIAG\x1d";
const F = "\x1dF\x1d";
const M = "\x1dM\x1d";

/**
 * Build a DIAG trailer exactly the way the search AppleScript does: each list
 * entry is suffixed with the item separator, entries are concatenated with no
 * separator, and the three fields are joined with the field separator. Building
 * it this way keeps the fixtures locked to the real emission format.
 */
function buildTrailer(opts: {
  timedOut?: boolean;
  skipped?: string[];
  notSearched?: string[];
}): string {
  const skipped = (opts.skipped ?? []).map((e) => e + M).join("");
  const notSearched = (opts.notSearched ?? []).map((e) => e + M).join("");
  return `${DIAG}timedOut=${opts.timedOut ? "true" : "false"}${F}skipped=${skipped}${F}notSearched=${notSearched}`;
}

/** A complete, clean diagnostics object. */
function emptyDiag(): SearchDiagnostics {
  return {
    partial: false,
    timedOutAccounts: [],
    skippedLargeMailboxes: [],
    notSearchedMailboxes: [],
  };
}

describe("splitSearchDiagnostics", () => {
  it("treats output with no DIAG trailer as a complete, non-partial result", () => {
    // Back-compat: older payloads (or non-search callers) have no trailer.
    const out = "123|||Subject|||a@b.com|||date|||true|||false";
    const { payload, diagnostics } = splitSearchDiagnostics(out, "iCloud");
    expect(payload).toBe(out);
    expect(diagnostics.partial).toBe(false);
    expect(diagnostics.skippedLargeMailboxes).toEqual([]);
    expect(diagnostics.notSearchedMailboxes).toEqual([]);
  });

  it("separates the message payload from the trailer", () => {
    const out = `MSGS_HERE${buildTrailer({})}`;
    const { payload, diagnostics } = splitSearchDiagnostics(out, "iCloud");
    expect(payload).toBe("MSGS_HERE");
    expect(diagnostics.partial).toBe(false);
  });

  it("reports a clean (non-partial) result when nothing was skipped or timed out", () => {
    const { diagnostics } = splitSearchDiagnostics(buildTrailer({}), "Gmail");
    expect(diagnostics).toEqual(emptyDiag());
  });

  it("marks partial and prefixes skipped mailboxes with the account name", () => {
    const out = buildTrailer({
      timedOut: true,
      skipped: ["All Mail (44287)", "Important (34767)"],
    });
    const { diagnostics } = splitSearchDiagnostics(out, "Gmail");
    expect(diagnostics.partial).toBe(true);
    expect(diagnostics.skippedLargeMailboxes).toEqual([
      "Gmail / All Mail (44287)",
      "Gmail / Important (34767)",
    ]);
    expect(diagnostics.notSearchedMailboxes).toEqual([]);
  });

  it("captures mailboxes that timed out mid-scan", () => {
    const out = buildTrailer({ timedOut: true, notSearched: ["Archive"] });
    const { diagnostics } = splitSearchDiagnostics(out, "Work");
    expect(diagnostics.partial).toBe(true);
    expect(diagnostics.notSearchedMailboxes).toEqual(["Work / Archive"]);
  });

  it("infers partial=true from a skip list even if the timedOut flag is false", () => {
    // Defensive: the skip/notSearched lists are the source of truth for coverage.
    const out = buildTrailer({ timedOut: false, skipped: ["Huge (99999)"] });
    const { diagnostics } = splitSearchDiagnostics(out, "Gmail");
    expect(diagnostics.partial).toBe(true);
    expect(diagnostics.skippedLargeMailboxes).toEqual(["Gmail / Huge (99999)"]);
  });

  it("uses the LAST DIAG marker so a stray marker in message text can't truncate the payload", () => {
    const out = `weird${DIAG}leftover${buildTrailer({})}`;
    const { payload, diagnostics } = splitSearchDiagnostics(out, "iCloud");
    expect(payload).toBe(`weird${DIAG}leftover`);
    expect(diagnostics.partial).toBe(false);
  });

  it("does not corrupt when a mailbox name contains the old ||| delimiter (#30)", () => {
    // The whole point of #30: a value containing the legacy printable delimiter
    // is now harmless because the real separators are control characters.
    const out = buildTrailer({ timedOut: true, skipped: ["Weird|||Box (9000)"] });
    const { diagnostics } = splitSearchDiagnostics(out, "Gmail");
    expect(diagnostics.skippedLargeMailboxes).toEqual(["Gmail / Weird|||Box (9000)"]);
  });
});

describe("mergeSearchDiagnostics", () => {
  it("accumulates per-account diagnostics into the aggregate", () => {
    const agg = emptyDiag();
    mergeSearchDiagnostics(agg, {
      partial: true,
      timedOutAccounts: ["Exchange"],
      skippedLargeMailboxes: ["Gmail / All Mail (44287)"],
      notSearchedMailboxes: [],
    });
    mergeSearchDiagnostics(agg, {
      partial: false,
      timedOutAccounts: [],
      skippedLargeMailboxes: ["Gmail / Important (34767)"],
      notSearchedMailboxes: ["Work / Archive"],
    });

    expect(agg.partial).toBe(true);
    expect(agg.timedOutAccounts).toEqual(["Exchange"]);
    expect(agg.skippedLargeMailboxes).toEqual([
      "Gmail / All Mail (44287)",
      "Gmail / Important (34767)",
    ]);
    expect(agg.notSearchedMailboxes).toEqual(["Work / Archive"]);
  });

  it("stays non-partial when every account reported complete coverage", () => {
    const agg = emptyDiag();
    mergeSearchDiagnostics(agg, emptyDiag());
    mergeSearchDiagnostics(agg, emptyDiag());
    expect(agg).toEqual(emptyDiag());
  });
});
