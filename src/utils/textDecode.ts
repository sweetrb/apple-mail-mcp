/**
 * Charset decoding that does not trust the runtime's windows-1252 decoder.
 *
 * Some Node releases (22.22.0 among them) decode windows-1252 as plain
 * ISO-8859-1, so 0x80–0x9F come back as C1 control characters instead of
 * `€`, `“`, `”`, `–` and friends — the very bytes Outlook / Entourage mail is
 * full of. WHATWG maps every latin1 / iso-8859-1 / ascii label to windows-1252,
 * so the defect reaches every 8-bit fallback path. Decoding that one encoding
 * by table makes the result independent of the Node build.
 *
 * @module utils/textDecode
 */

/** WHATWG windows-1252 code points for bytes 0x80–0x9F (index = byte - 0x80). */
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/** Decodes bytes as windows-1252 by table; never throws. */
export function decodeWindows1252(bytes: Uint8Array): string {
  let out = "";
  // Chunked so a large body never builds one huge argument list.
  const CHUNK = 8192;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, bytes.length);
    const codes = new Array<number>(end - start);
    for (let i = start; i < end; i++) {
      const b = bytes[i];
      codes[i - start] = b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b;
    }
    out += String.fromCharCode(...codes);
  }
  return out;
}

/**
 * Drop-in for `new TextDecoder(label).decode(bytes)`: throws RangeError on an
 * unknown label exactly as TextDecoder does, but decodes any label that
 * resolves to windows-1252 by table.
 */
export function decodeText(bytes: Uint8Array, label: string): string {
  const decoder = new TextDecoder(label);
  return decoder.encoding === "windows-1252" ? decodeWindows1252(bytes) : decoder.decode(bytes);
}
