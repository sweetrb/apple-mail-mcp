import { describe, it, expect } from "vitest";
import { isLocalStoreName, unlistableStoreError } from "@/tools/mailboxListing.js";

const ACCOUNTS = ["iCloud", "robert.b.sweet@gmail.com", "rob@superiortech.io"];

describe("#183 a refused mailbox listing says so instead of reading as empty", () => {
  it("names the failure rather than reporting nothing found", () => {
    const msg = unlistableStoreError(
      "Nonsense",
      'Can\'t get account "Nonsense". (-1728)',
      ACCOUNTS
    );
    expect(msg).toMatch(/Could not list mailboxes for "Nonsense"/);
    expect(msg).toMatch(/-1728/);
    // The whole point: it must not be phrased as an empty result.
    expect(msg).not.toMatch(/No mailboxes found/i);
  });

  it("names the accounts that DO exist, so the caller can correct the argument", () => {
    const msg = unlistableStoreError("Nonsense", "boom", ACCOUNTS);
    for (const a of ACCOUNTS) expect(msg).toContain(a);
  });

  // Since 2.14.0 the local store IS listable, so this message must no longer
  // tell the caller it is unsupported — that would send them away from a
  // working call. It now says the failure is something other than a bad name.
  it("says the local store IS listable, so a failure is not 'no such account'", () => {
    const msg = unlistableStoreError("On My Mac", "boom", ACCOUNTS);
    expect(msg).toMatch(/LOCAL store, which IS listable/);
    expect(msg).not.toMatch(/not yet supported/);
    expect(msg).not.toMatch(/cannot be reached/);
  });

  it("does not claim a real account is the local store", () => {
    const msg = unlistableStoreError("iCloud", "boom", ACCOUNTS);
    expect(msg).not.toMatch(/LOCAL store/);
  });

  it("still explains itself when the account enumeration is also unavailable", () => {
    const msg = unlistableStoreError("On My Mac", undefined, []);
    expect(msg).toMatch(/Mail declined the request/);
    expect(msg).not.toMatch(/Accounts on this Mac/);
    expect(msg).toMatch(/LOCAL store/);
  });

  // The list itself is owned by appleMailManager (it is what routes a request
  // to the local branch); this re-export must stay in agreement with it, or a
  // name would be accepted by one and not the other.
  it("recognises the local store by its common names, case- and space-insensitively", () => {
    for (const n of ["on my mac", "on my computer", "local", "local folders"]) {
      expect(isLocalStoreName(n)).toBe(true);
      expect(isLocalStoreName(`  ${n.toUpperCase()}  `)).toBe(true);
    }
    expect(isLocalStoreName("iCloud")).toBe(false);
    expect(isLocalStoreName("On My Mac Archive")).toBe(false);
  });
});
