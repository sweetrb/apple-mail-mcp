import { describe, it, expect } from "vitest";
import { locationSuffix, spansLocations } from "@/utils/messageLocation.js";

describe("locationSuffix", () => {
  it("names the mailbox and its account", () => {
    expect(locationSuffix("Deleted Items", "Exchange")).toBe(' | in "Deleted Items" (Exchange)');
    expect(locationSuffix("[Gmail]/All Mail", "Google")).toBe(' | in "[Gmail]/All Mail" (Google)');
  });

  it("leaves out an account it doesn't have", () => {
    expect(locationSuffix("INBOX", "")).toBe(' | in "INBOX"');
    expect(locationSuffix("INBOX", undefined)).toBe(' | in "INBOX"');
  });

  it("says nothing without a mailbox", () => {
    expect(locationSuffix("", "Exchange")).toBe("");
    expect(locationSuffix(undefined, "Exchange")).toBe("");
    expect(locationSuffix(42, "Exchange")).toBe("");
  });
});

describe("spansLocations", () => {
  it("is false for no rows, one row, or rows that share a mailbox and account", () => {
    expect(spansLocations([])).toBe(false);
    expect(spansLocations([{ mailbox: "INBOX", account: "Work" }])).toBe(false);
    expect(
      spansLocations([
        { mailbox: "INBOX", account: "Work" },
        { mailbox: "INBOX", account: "Work" },
      ])
    ).toBe(false);
  });

  it("is true when the rows differ in mailbox or in account", () => {
    expect(
      spansLocations([
        { mailbox: "Sent Items", account: "Exchange" },
        { mailbox: "Deleted Items", account: "Exchange" },
      ])
    ).toBe(true);
    expect(
      spansLocations([
        { mailbox: "INBOX", account: "Work" },
        { mailbox: "INBOX", account: "Home" },
      ])
    ).toBe(true);
  });
});
