/**
 * Flag COLOR over IMAP — Mail.app's `$MailFlagBit0/1/2` keyword bitfield.
 *
 * The palette index is a plain 3-bit little-endian field. Getting the bit order
 * backwards still "works" for red (0) and gray (6) — the palindromes — so the
 * asymmetric colors are what actually pin the encoding down. These expectations
 * were taken from live Mail.app state, not from the spec:
 *   green  (3) = bit0 + bit1
 *   blue   (4) = bit2
 *   purple (5) = bit0 + bit2
 */
import { describe, it, expect } from "vitest";
import {
  mailFlagBitsFor,
  mailFlagColorIndex,
  flagColorName,
  FLAG_COLOR_NAMES,
} from "@/services/imapClient.js";

const B0 = "$MailFlagBit0";
const B1 = "$MailFlagBit1";
const B2 = "$MailFlagBit2";

describe("mailFlagBitsFor", () => {
  it("encodes the observed live values", () => {
    expect(mailFlagBitsFor(3).set.sort()).toEqual([B0, B1]); // green
    expect(mailFlagBitsFor(4).set).toEqual([B2]); // blue
    expect(mailFlagBitsFor(5).set.sort()).toEqual([B0, B2]); // purple
  });

  it("red (0) sets no bits but still clears all three", () => {
    expect(mailFlagBitsFor(0).set).toEqual([]);
    expect(mailFlagBitsFor(0).clear.sort()).toEqual([B0, B1, B2]);
  });

  it("gray (6) is bit1 + bit2", () => {
    expect(mailFlagBitsFor(6).set.sort()).toEqual([B1, B2]);
    expect(mailFlagBitsFor(6).clear).toEqual([B0]);
  });

  it("set and clear are always complementary — no bit left ambiguous", () => {
    for (let i = 0; i <= 6; i++) {
      const { set, clear } = mailFlagBitsFor(i);
      expect([...set, ...clear].sort()).toEqual([B0, B1, B2]);
      expect(set.filter((b) => clear.includes(b))).toEqual([]);
    }
  });
});

describe("mailFlagColorIndex", () => {
  it("decodes the observed live values", () => {
    expect(mailFlagColorIndex([B0, B1])).toBe(3);
    expect(mailFlagColorIndex([B2])).toBe(4);
    expect(mailFlagColorIndex([B0, B2])).toBe(5);
  });

  it("round-trips every palette index", () => {
    for (let i = 0; i <= 6; i++) {
      const { set } = mailFlagBitsFor(i);
      // index 0 sets no bits, so it is indistinguishable from "no color" on read
      expect(mailFlagColorIndex(set)).toBe(i === 0 ? undefined : i);
    }
  });

  it("returns undefined when no color bits are present", () => {
    expect(mailFlagColorIndex([])).toBeUndefined();
    expect(mailFlagColorIndex(["\\Seen", "\\Flagged"])).toBeUndefined();
    expect(mailFlagColorIndex(undefined)).toBeUndefined();
  });

  it("ignores unrelated flags alongside the color bits", () => {
    expect(mailFlagColorIndex(["\\Seen", B0, "\\Flagged", B1, "$NotJunk"])).toBe(3);
  });
});

describe("flagColorName (#286 read-back)", () => {
  it("names every palette index 0-6, matching FLAG_COLOR_NAMES", () => {
    expect(FLAG_COLOR_NAMES).toEqual([
      "red",
      "orange",
      "yellow",
      "green",
      "blue",
      "purple",
      "gray",
    ]);
    for (let i = 0; i <= 6; i++) {
      expect(flagColorName(i)).toBe(FLAG_COLOR_NAMES[i]);
    }
  });

  it("emits 'gray', never the 'grey' input alias", () => {
    expect(flagColorName(6)).toBe("gray");
  });

  it("returns undefined for an absent or out-of-range index", () => {
    expect(flagColorName(undefined)).toBeUndefined();
    expect(flagColorName(-1)).toBeUndefined();
    expect(flagColorName(7)).toBeUndefined();
  });

  it("round-trips mailFlagColorIndex's output for every color but red", () => {
    // index 0 (red) sets no bits, so it reads back as "no color" — the same
    // inherent ambiguity mailFlagColorIndex's own round-trip test documents.
    for (let i = 1; i <= 6; i++) {
      const { set } = mailFlagBitsFor(i);
      expect(flagColorName(mailFlagColorIndex(set))).toBe(FLAG_COLOR_NAMES[i]);
    }
  });
});
