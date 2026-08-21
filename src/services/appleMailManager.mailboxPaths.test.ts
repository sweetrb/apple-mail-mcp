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
});
