/**
 * #234 §4 — body text must honour the part's declared charset, and fall back to
 * windows-1252 when bytes that claim (or default to) UTF-8 are not valid UTF-8.
 *
 * Legacy Entourage / Outlook for Mac mail carries 8bit ISO-8859-1 parts. The
 * decoder used to call `.toString("utf8")` on every part regardless of its
 * `charset=`, so every accented character became U+FFFD.
 */
import { describe, it, expect } from "vitest";
import { extractHtmlBody, extractTextBody } from "./mimeParse.js";

/** A raw source as a byte-preserving (latin1) string — how the IMAP path now hands it over. */
function src(parts: Buffer[]): string {
  return Buffer.concat(parts).toString("latin1");
}
const L = (s: string) => Buffer.from(s, "latin1");

describe("#234 §4 — MIME body charset", () => {
  it("decodes an 8bit ISO-8859-1 text/html part (the Entourage shape) without U+FFFD", () => {
    const s = src([
      L('Content-Type: multipart/mixed; boundary="OUTLOOK2MAC8473928"\r\n\r\n'),
      L("--OUTLOOK2MAC8473928\r\n"),
      L('Content-Type: text/html; charset="ISO-8859-1"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'),
      L("<p>Se\xf1or Jos\xe9: diferencial t\xe9rmico</p>\r\n"),
      L("--OUTLOOK2MAC8473928--\r\n"),
    ]);
    const html = extractHtmlBody(s);
    expect(html).toContain("Señor José: diferencial térmico");
    expect(html).not.toContain("�");
  });

  it("decodes a quoted-printable windows-1252 text/plain part", () => {
    const s = src([
      L(
        "Content-Type: text/plain; charset=windows-1252\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n"
      ),
      L("Se=F1or Jos=E9 =80 5\r\n"),
    ]);
    expect(extractTextBody(s)).toContain("Señor José € 5");
  });

  it("falls back to windows-1252 when a part with no charset is not valid UTF-8", () => {
    const s = src([
      L("Content-Type: text/plain\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"),
      L("Jos\xe9\r\n"),
    ]);
    expect(extractTextBody(s)).toContain("José");
  });

  it("still decodes genuine UTF-8 bytes as UTF-8", () => {
    const s = src([
      L("Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"),
      Buffer.from("José ✓\r\n", "utf8"),
    ]);
    expect(extractTextBody(s)).toContain("José ✓");
  });
});
