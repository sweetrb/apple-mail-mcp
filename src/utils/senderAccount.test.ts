/**
 * `account` on send-email / create-draft must end up as the actual From, or the
 * call must fail without sending. Mail.app silently ignores `set sender` to
 * anything that is not a configured address, so the account is resolved to one
 * exact address first.
 */
import { describe, expect, it } from "vitest";
import { extractAddress, pickSenderAddress } from "@/utils/senderAccount.js";
import type { Account } from "@/types.js";

const acct = (name: string, enabled: boolean, addresses: string[]): Account => ({
  name,
  enabled,
  addresses,
  email: addresses[0],
});

const accounts: Account[] = [
  acct("mrcoryzhao@gmail", true, ["mrcoryzhao@gmail.com"]),
  acct("coryzhao@icloud", true, ["coryzhao@icloud.com", "Cory@Me.com"]),
  acct("old", false, ["old@example.com"]),
  acct("dup", true, ["a@dup.test"]),
  acct("dup", true, ["b@dup.test"]),
];

describe("pickSenderAddress", () => {
  it("resolves an account NAME to its single address (the case that sent from the wrong account)", () => {
    expect(pickSenderAddress("mrcoryzhao@gmail", accounts)).toEqual({
      address: "mrcoryzhao@gmail.com",
    });
  });

  it("accepts an exact address, any case, bare or as Name <address>", () => {
    expect(pickSenderAddress("MRCORYZHAO@gmail.com", accounts)).toEqual({
      address: "mrcoryzhao@gmail.com",
    });
    expect(pickSenderAddress("Cory <cory@me.com>", accounts)).toEqual({ address: "Cory@Me.com" });
  });

  it("rejects unknown, disabled, ambiguous-name and multi-address-name input", () => {
    for (const bad of [
      "nobody@example.invalid",
      "old",
      "old@example.com",
      "dup",
      "coryzhao@icloud",
    ]) {
      const r = pickSenderAddress(bad, accounts);
      expect(r, bad).toHaveProperty("error");
    }
  });
});

describe("extractAddress", () => {
  it("takes the angle-bracket address, else the trimmed text", () => {
    expect(extractAddress("Cory Zhao <a@b.c>")).toBe("a@b.c");
    expect(extractAddress(" a@b.c ")).toBe("a@b.c");
  });
});
