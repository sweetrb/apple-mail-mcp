import { describe, it, expect } from "vitest";
import {
  isLocalStoreName,
  unlistableStoreError,
  LOCAL_STORE_NAMES,
} from "@/tools/mailboxListing.js";

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

  it("explains that the local store is not an account and cannot be reached this way", () => {
    const msg = unlistableStoreError("On My Mac", "boom", ACCOUNTS);
    expect(msg).toMatch(/is Mail's LOCAL store, not an account/);
    expect(msg).toMatch(/not yet supported/);
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

  it("recognises the local store by its common names, case- and space-insensitively", () => {
    for (const n of LOCAL_STORE_NAMES) {
      expect(isLocalStoreName(n)).toBe(true);
      expect(isLocalStoreName(`  ${n.toUpperCase()}  `)).toBe(true);
    }
    expect(isLocalStoreName("iCloud")).toBe(false);
    expect(isLocalStoreName("On My Mac Archive")).toBe(false);
  });
});
