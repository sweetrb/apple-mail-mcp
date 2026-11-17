/**
 * windows-1252 must decode by the WHATWG table whatever the Node build does:
 * Node 22.22.0 decodes it as ISO-8859-1, turning 0x80–0x9F into C1 controls.
 */
import { describe, it, expect } from "vitest";
import { decodeText, decodeWindows1252 } from "./textDecode.js";

describe("decodeWindows1252", () => {
  it("maps 0x80–0x9F to the WHATWG code points, not C1 controls", () => {
    const bytes = Buffer.from([0x80, 0x85, 0x91, 0x92, 0x93, 0x94, 0x96, 0x97, 0x99, 0x9f]);
    expect(decodeWindows1252(bytes)).toBe("€…‘’“”–—™Ÿ");
  });

  it("keeps the five undefined bytes as their C1 code points", () => {
    const bytes = Buffer.from([0x81, 0x8d, 0x8f, 0x90, 0x9d]);
    expect(decodeWindows1252(bytes)).toBe("\u0081\u008d\u008f\u0090\u009d");
  });

  it("decodes ASCII and 0xA0–0xFF as latin-1", () => {
    expect(decodeWindows1252(Buffer.from("Se\xf1or Jos\xe9 \xa0\xff", "latin1"))).toBe(
      "Señor José  ÿ"
    );
  });

  it("handles input longer than one chunk", () => {
    const bytes = Buffer.alloc(20000, 0x80);
    expect(decodeWindows1252(bytes)).toBe("€".repeat(20000));
  });
});

describe("decodeText", () => {
  it.each(["windows-1252", "iso-8859-1", "latin1", "us-ascii", "cp1252"])(
    "decodes the %s label by the windows-1252 table",
    (label) => {
      expect(decodeText(Buffer.from([0x80, 0x93, 0x94]), label)).toBe("€“”");
    }
  );

  it("leaves other encodings to TextDecoder", () => {
    expect(decodeText(Buffer.from("€", "utf8"), "utf-8")).toBe("€");
    expect(decodeText(Buffer.from([0xa4]), "iso-8859-15")).toBe("€");
  });

  it("throws RangeError on an unknown label, like TextDecoder", () => {
    expect(() => decodeText(Buffer.from("x"), "no-such-charset")).toThrow(RangeError);
  });
});
