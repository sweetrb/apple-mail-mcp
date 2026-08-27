import { describe, expect, it } from "vitest";

import { resolveAppleMailboxPath } from "@/services/appleMailManager.js";

const EXCHANGE_PATHS = ["Inbox", "Archive", "Archive/Inbox", "Sent Items", "Deleted Items"];

describe("AppleScript mailbox path resolution", () => {
  it("prefers the exact top-level Inbox over a nested Inbox", () => {
    expect(resolveAppleMailboxPath("Inbox", EXCHANGE_PATHS)).toBe("Inbox");
    expect(resolveAppleMailboxPath("INBOX", EXCHANGE_PATHS)).toBe("Inbox");
  });

  it("addresses the nested archival Inbox by its full path", () => {
    expect(resolveAppleMailboxPath("Archive/Inbox", EXCHANGE_PATHS)).toBe("Archive/Inbox");
  });

  it("keeps a unique legacy leaf name working", () => {
    expect(resolveAppleMailboxPath("Receipts", ["Projects/Receipts", "Inbox"])).toBe(
      "Projects/Receipts"
    );
  });

  it("refuses an ambiguous leaf and names every candidate", () => {
    expect(() =>
      resolveAppleMailboxPath("Receipts", ["Personal/Receipts", "Work/Receipts"])
    ).toThrow(
      'Mailbox "Receipts" is ambiguous — it matches "Personal/Receipts" and "Work/Receipts". Pass the full path.'
    );
  });

  it("applies aliases without choosing an ambiguous nested mailbox", () => {
    expect(resolveAppleMailboxPath("Sent", ["Sent Items", "Archive/Sent Items"])).toBe(
      "Sent Items"
    );
  });

  // Regression for #203: an underscore-prefixed name is matched by ordinary
  // string comparison here, same as any other name — the -1728 failure the
  // issue describes comes from addressing it with an AppleScript named
  // specifier (`mailbox "_Foo" of account "X"`) elsewhere in the resolution
  // path, not from this comparison.
  it("resolves an underscore-prefixed mailbox by exact and case-insensitive match", () => {
    const paths = ["INBOX", "_Foo", "_Bar/_Baz"];
    expect(resolveAppleMailboxPath("_Foo", paths)).toBe("_Foo");
    expect(resolveAppleMailboxPath("_foo", paths)).toBe("_Foo");
    expect(resolveAppleMailboxPath("_Bar/_Baz", paths)).toBe("_Bar/_Baz");
  });
});
