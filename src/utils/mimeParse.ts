/**
 * MIME Source Parser for Attachment Extraction
 *
 * Parses raw email MIME source to extract attachment metadata and content.
 * Used as a fallback when AppleScript's `mail attachments` returns empty
 * (which happens across all account types: iCloud, Google, Exchange).
 *
 * @module utils/mimeParse
 */

export interface MimeAttachmentInfo {
  /** Filename from Content-Disposition or Content-Type name parameter */
  name: string;
  /** MIME type from Content-Type header */
  mimeType: string;
  /** Size in bytes from Content-Disposition size parameter, or estimated from body */
  size: number;
}

export interface MimeAttachmentData extends MimeAttachmentInfo {
  /** Decoded binary content */
  data: Buffer;
}

interface MimePart {
  headers: string;
  body: string;
}

/**
 * Extract the boundary string from a Content-Type header value
 * (or from any string containing a boundary= parameter).
 */
function extractBoundary(source: string): string | null {
  const match = source.match(/boundary="?([^";\s\r\n]+)"?/i);
  return match ? match[1] : null;
}

/**
 * Extract a header value from a MIME part header block.
 * Handles folded headers (continuation lines starting with whitespace).
 */
function getHeader(headers: string, name: string): string | null {
  const regex = new RegExp(`^${name}:\\s*(.+(?:\\r?\\n[ \\t]+.+)*)`, "im");
  const match = headers.match(regex);
  if (!match) return null;
  // Unfold: replace newline+whitespace with single space
  return match[1].replace(/\r?\n[ \t]+/g, " ").trim();
}

/** Decodes bytes in `charset`, UTF-8 when the label is unknown. */
function decodeBytes(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset.trim().toLowerCase()).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

/** The parameters of a header value (after the first `;`), quotes removed, names lower-cased. */
function parseParams(value: string): Map<string, string> {
  const pieces: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && quoted && i + 1 < value.length) {
      current += ch + value[++i];
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) {
      pieces.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  pieces.push(current);
  const params = new Map<string, string>();
  for (const piece of pieces.slice(1)) {
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    let val = piece.slice(eq + 1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    params.set(piece.slice(0, eq).trim().toLowerCase(), val);
  }
  return params;
}

/** RFC 2047 encoded words (`=?UTF-8?B?...?=`, `=?ISO-8859-1?Q?...?=`) decoded in place. */
function decodeEncodedWords(text: string): string {
  return text
    .replace(/(\?=)\s+(?==\?)/g, "$1") // whitespace between adjacent encoded words is dropped
    .replace(
      /=\?([^?\s]+)\?([bq])\?([^?]*)\?=/gi,
      (_all, charset: string, kind: string, body: string) => {
        const bytes =
          kind.toLowerCase() === "b"
            ? Buffer.from(body, "base64")
            : Buffer.from(
                body
                  .replace(/_/g, " ")
                  .replace(/=([0-9a-f]{2})/gi, (_m, hex: string) =>
                    String.fromCharCode(parseInt(hex, 16))
                  ),
                "latin1"
              );
        return decodeBytes(bytes, charset.split("*")[0]);
      }
    );
}

/**
 * RFC 2231 value: `charset'lang'%XX...` in the first segment, percent-encoded
 * when the segment is flagged, plain otherwise, joined in order.
 */
function decodeExtendedValue(segments: Array<{ value: string; encoded: boolean }>): string {
  let charset = "utf-8";
  const chunks: Buffer[] = [];
  segments.forEach((segment, index) => {
    let value = segment.value;
    if (!segment.encoded) {
      chunks.push(Buffer.from(value, "utf8"));
      return;
    }
    if (index === 0) {
      const head = value.match(/^([^']*)'[^']*'([\s\S]*)$/);
      if (head) {
        charset = head[1] || charset;
        value = head[2];
      }
    }
    chunks.push(
      Buffer.from(
        value.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) =>
          String.fromCharCode(parseInt(hex, 16))
        ),
        "latin1"
      )
    );
  });
  return decodeBytes(Buffer.concat(chunks), charset);
}

/** A parameter's value: RFC 2231 (`name*=`, `name*0*=`), else plain with RFC 2047 words decoded. */
function paramValue(params: Map<string, string>, name: string): string | null {
  const extended = params.get(`${name}*`);
  if (extended !== undefined) return decodeExtendedValue([{ value: extended, encoded: true }]);
  const segments: Array<{ value: string; encoded: boolean }> = [];
  for (let i = 0; ; i++) {
    const encoded = params.get(`${name}*${i}*`);
    const plain = params.get(`${name}*${i}`);
    if (encoded !== undefined) segments.push({ value: encoded, encoded: true });
    else if (plain !== undefined) segments.push({ value: plain, encoded: false });
    else break;
  }
  if (segments.length > 0) return decodeExtendedValue(segments);
  const value = params.get(name);
  return value === undefined ? null : decodeEncodedWords(value);
}

/**
 * Extract filename from Content-Disposition or Content-Type headers, decoding
 * RFC 2231 parameters (`filename*=UTF-8''caf%C3%A9.pdf`) and RFC 2047 words.
 */
function extractFilename(headers: string): string | null {
  // Try Content-Disposition filename first
  const dispHeader = getHeader(headers, "Content-Disposition");
  if (dispHeader) {
    const filename = paramValue(parseParams(dispHeader), "filename")?.trim();
    if (filename) return filename;
  }
  // Fall back to Content-Type name parameter
  const ctHeader = getHeader(headers, "Content-Type");
  if (ctHeader) {
    const name = paramValue(parseParams(ctHeader), "name")?.trim();
    if (name) return name;
  }
  return null;
}

/**
 * Check if a MIME part has inline disposition.
 */
function isInlineDisposition(headers: string): boolean {
  const dispHeader = getHeader(headers, "Content-Disposition");
  if (!dispHeader) return false;
  return dispHeader.toLowerCase().startsWith("inline");
}

/** The part's Content-ID without angle brackets, lower-cased, or null. */
function extractContentId(headers: string): string | null {
  const raw = getHeader(headers, "Content-ID");
  if (!raw) return null;
  const id = raw.replace(/^<+/, "").replace(/>+$/, "").trim().toLowerCase();
  return id || null;
}

/**
 * Whether an inline part is a resource embedded in the HTML body (a signature
 * logo, a pasted picture) rather than a file the sender attached.
 *
 * Apple Mail writes the files it attaches as `Content-Disposition: inline`
 * with a `filename`, and in a draft or a related-multipart it adds a
 * `Content-ID` too, so neither the disposition nor the Content-ID tells an
 * attachment from an embedded image. What does: the HTML body points at the
 * embedded one with `cid:<id>`. An inline part nothing refers to is a file.
 */
function isEmbeddedResource(headers: string, referenced: () => ReadonlySet<string>): boolean {
  if (!isInlineDisposition(headers)) return false;
  const cid = extractContentId(headers);
  if (!cid) return false;
  return referenced().has(cid);
}

/**
 * The Content-IDs an HTML body points at with `cid:`, lower-cased and
 * percent-decoded (`cid:logo%40x` names `logo@x`). A reference ends at a quote,
 * whitespace, a bracket or a parenthesis, so `cid:logo` is not found in `cid:logo2`.
 */
export function cidReferences(html: string): Set<string> {
  const refs = new Set<string>();
  for (const match of html.matchAll(/cid:([^\s"'<>()]+)/gi)) {
    let ref = match[1];
    try {
      ref = decodeURIComponent(ref);
    } catch {
      // Not valid percent-encoding: take it as written.
    }
    refs.add(ref.trim().toLowerCase());
  }
  return refs;
}

/** The `cid:` references of every text/html leaf part. */
function collectCidReferences(parts: MimePart[]): Set<string> {
  const refs = new Set<string>();
  for (const part of parts) {
    if (extractMimeType(part.headers) !== "text/html") continue;
    const encoding = getHeader(part.headers, "Content-Transfer-Encoding");
    const html = decodePartText(decodeBody(part.body, encoding), extractCharset(part.headers));
    for (const ref of cidReferences(html)) refs.add(ref);
  }
  return refs;
}

/**
 * Extract size from Content-Disposition size parameter.
 */
function extractSize(headers: string): number {
  const dispHeader = getHeader(headers, "Content-Disposition");
  if (dispHeader) {
    // Anchored to a parameter boundary so `file-size=` / `x-size=` can't match.
    const sizeMatch = dispHeader.match(/(?:^|;)\s*size\s*=\s*"?(\d+)/i);
    if (sizeMatch) return parseInt(sizeMatch[1], 10);
  }
  return 0;
}

/**
 * Extract MIME type from Content-Type header.
 */
function extractMimeType(headers: string): string {
  const ctHeader = getHeader(headers, "Content-Type");
  if (!ctHeader) return "application/octet-stream";
  const typeMatch = ctHeader.match(/^([^;\s]+)/);
  return typeMatch ? typeMatch[1].toLowerCase() : "application/octet-stream";
}

/** The `charset` parameter of a part's Content-Type, lower-cased, or null. */
function extractCharset(headers: string): string | null {
  const ct = getHeader(headers, "Content-Type");
  const m = ct?.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Turn a text part's decoded bytes into a string, honouring its declared
 * charset (#234 §4).
 *
 * This used to be `.toString("utf8")` for every part whatever its `charset=`,
 * so an 8bit ISO-8859-1 body — the normal shape of legacy Entourage / Outlook
 * for Mac mail — came back with U+FFFD for every accented character. A known
 * non-UTF-8 label is decoded with that label. UTF-8, US-ASCII, no label, or a
 * label TextDecoder does not know are tried as strict UTF-8, and bytes that are
 * not valid UTF-8 fall back to windows-1252: mislabelled or unlabelled 8-bit
 * text is overwhelmingly latin-1, and U+FFFD is never a better answer.
 */
function decodePartText(bytes: Buffer, charset: string | null): string {
  if (charset && !["utf-8", "utf8", "us-ascii", "ascii"].includes(charset)) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // Unknown label: fall through to the UTF-8 / windows-1252 heuristic.
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/**
 * Decoded size of a complete base64 body. Exact: each non-pad alphabet
 * character carries 6 bits, so `=` padding, line breaks and any other
 * whitespace drop out (40 chars with one `=` → 29 bytes, not 30). #270
 */
export function base64DecodedSize(base64Body: string): number {
  const cleaned = base64Body.replace(/[^A-Za-z0-9+/]/g, "");
  return Math.floor((cleaned.length * 3) / 4);
}

/**
 * Split a MIME block into parts using the given boundary.
 * Does not recurse — call walkLeafParts for recursive traversal.
 */
function splitMimeParts(source: string, boundary: string): MimePart[] {
  const parts: MimePart[] = [];
  const boundaryDelim = `--${boundary}`;

  const sections = source.split(boundaryDelim);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed || trimmed.startsWith("--")) continue;

    // Split headers from body at first blank line
    const blankLineIdx = trimmed.search(/\r?\n\r?\n/);
    if (blankLineIdx === -1) continue;

    const headers = trimmed.substring(0, blankLineIdx);
    const body = trimmed.substring(blankLineIdx).replace(/^\r?\n\r?\n/, "");

    parts.push({ headers, body });
  }

  return parts;
}

/**
 * Maximum nesting depth for multipart MIME traversal. Bounds recursion so a
 * pathologically (or maliciously) deeply nested multipart tree can't blow the
 * stack — past this depth we stop descending and treat the container as a leaf.
 * Real mail nests only a few levels (e.g. mixed → related → alternative).
 */
const MAX_MIME_DEPTH = 20;

/**
 * Walk a multipart MIME block and return all non-multipart leaf parts,
 * descending into nested multipart/* containers (alternative, related, mixed).
 *
 * Descent is bounded by MAX_MIME_DEPTH; once reached, deeper multipart
 * containers are returned as-is (as leaf parts) rather than recursed into,
 * yielding what's parsed so far instead of overflowing the stack.
 */
function walkLeafParts(source: string, boundary: string, depth = 0): MimePart[] {
  const result: MimePart[] = [];
  const parts = splitMimeParts(source, boundary);

  for (const part of parts) {
    const ct = getHeader(part.headers, "Content-Type");
    if (ct && /^multipart\//i.test(ct) && depth < MAX_MIME_DEPTH) {
      const nestedBoundary = extractBoundary(ct);
      if (nestedBoundary) {
        result.push(...walkLeafParts(part.body, nestedBoundary, depth + 1));
        continue;
      }
    }
    result.push(part);
  }

  return result;
}

/**
 * Decode a MIME part body to bytes based on its transfer encoding.
 * Supports base64, quoted-printable, and 7bit/8bit/binary (raw).
 */
function decodeBody(body: string, encoding: string | null): Buffer {
  const enc = (encoding || "").toLowerCase().trim();
  if (enc === "base64") {
    return Buffer.from(body.replace(/[\s\r\n]/g, ""), "base64");
  }
  if (enc === "quoted-printable") {
    return decodeQuotedPrintable(body);
  }
  // 7bit, 8bit, binary, or unspecified — treat as raw bytes
  return Buffer.from(body, "binary");
}

/**
 * Decode quoted-printable-encoded body to bytes.
 * Handles soft line breaks (=<CRLF>) and =XX hex escapes per RFC 2045 §6.7.
 */
function decodeQuotedPrintable(body: string): Buffer {
  // Remove soft line breaks: `=` immediately followed by CRLF or LF
  const noSoft = body.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < noSoft.length; i++) {
    const c = noSoft[i];
    if (c === "=" && i + 2 < noSoft.length) {
      const hex = noSoft.substring(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(c.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

/**
 * Decoded body size for metadata when Content-Disposition size is absent.
 * base64 and quoted-printable are decoded-counted exactly (the whole body is
 * in hand here); other encodings are identity.
 */
function estimateSize(body: string, encoding: string | null): number {
  const enc = (encoding || "").toLowerCase().trim();
  if (enc === "base64") return base64DecodedSize(body);
  if (enc === "quoted-printable") return decodeQuotedPrintable(body).length;
  return body.length;
}

/**
 * Parse MIME source and return metadata for all file attachments.
 * Skips resources embedded in the HTML body (an inline part the HTML refers to
 * with `cid:`), but NOT inline parts in general: Apple Mail writes the files it
 * attaches as `Content-Disposition: inline`. Descends into nested multipart/*
 * containers.
 *
 * @param source - Raw MIME source of the email
 * @returns Array of attachment metadata (name, mimeType, size)
 */
export function parseMimeAttachments(source: string): MimeAttachmentInfo[] {
  if (!source || !source.trim()) return [];

  const boundary = extractBoundary(source);
  if (!boundary) return [];

  const parts = walkLeafParts(source, boundary);
  // Decoded only when a named inline part with a Content-ID makes it necessary.
  let refs: Set<string> | undefined;
  const referenced = (): Set<string> => (refs ??= collectCidReferences(parts));
  const attachments: MimeAttachmentInfo[] = [];

  for (const part of parts) {
    const filename = extractFilename(part.headers);
    if (!filename) continue;

    if (isEmbeddedResource(part.headers, referenced)) continue;

    const encoding = getHeader(part.headers, "Content-Transfer-Encoding");

    attachments.push({
      name: filename,
      mimeType: extractMimeType(part.headers),
      size: extractSize(part.headers) || estimateSize(part.body, encoding),
    });
  }

  return attachments;
}

/**
 * Extract the decoded `text/html` body from raw MIME source.
 *
 * Used by get-message's `preferHtml` path so it returns the actual HTML body
 * rather than the entire raw MIME blob (headers + base64 attachments), which is
 * both wrong and enormous (#32). Handles both multipart messages (walks leaf
 * parts, descending into nested multipart/* containers) and a non-multipart
 * message whose top-level Content-Type is text/html. Bodies are decoded per
 * Content-Transfer-Encoding (base64 / quoted-printable / raw) and then to text
 * by the part's declared charset (see decodePartText). Pass a byte-preserving
 * source — a latin1 string of the raw bytes — or 8bit parts are already lost.
 *
 * @param source - Raw MIME source of the email
 * @returns The decoded HTML body, or null if the message has no text/html part
 */
export function extractHtmlBody(source: string): string | null {
  if (!source || !source.trim()) return null;

  const boundary = extractBoundary(source);

  if (boundary) {
    for (const part of walkLeafParts(source, boundary)) {
      if (extractMimeType(part.headers) === "text/html") {
        const encoding = getHeader(part.headers, "Content-Transfer-Encoding");
        return decodePartText(decodeBody(part.body, encoding), extractCharset(part.headers));
      }
    }
    return null;
  }

  // Non-multipart: split top headers from body and check the top Content-Type.
  const blankLineIdx = source.search(/\r?\n\r?\n/);
  if (blankLineIdx === -1) return null;
  const headers = source.substring(0, blankLineIdx);
  if (extractMimeType(headers) !== "text/html") return null;
  const body = source.substring(blankLineIdx).replace(/^\r?\n\r?\n/, "");
  const encoding = getHeader(headers, "Content-Transfer-Encoding");
  return decodePartText(decodeBody(body, encoding), extractCharset(headers));
}

/**
 * Extract the decoded `text/plain` body from raw MIME source. Mirror of
 * extractHtmlBody; used by the IMAP get-message path (#43 Phase 3) to render a
 * message fetched by UID. Returns null when there's no text/plain part.
 */
export function extractTextBody(source: string): string | null {
  if (!source || !source.trim()) return null;

  const boundary = extractBoundary(source);
  if (boundary) {
    for (const part of walkLeafParts(source, boundary)) {
      if (extractMimeType(part.headers) === "text/plain") {
        const encoding = getHeader(part.headers, "Content-Transfer-Encoding");
        return decodePartText(decodeBody(part.body, encoding), extractCharset(part.headers));
      }
    }
    return null;
  }

  // Non-multipart: treat as text/plain unless the Content-Type says otherwise.
  const blankLineIdx = source.search(/\r?\n\r?\n/);
  if (blankLineIdx === -1) return null;
  const headers = source.substring(0, blankLineIdx);
  const ct = extractMimeType(headers);
  if (ct !== "text/plain" && getHeader(headers, "Content-Type") !== null) return null;
  const body = source.substring(blankLineIdx).replace(/^\r?\n\r?\n/, "");
  const encoding = getHeader(headers, "Content-Transfer-Encoding");
  return decodePartText(decodeBody(body, encoding), extractCharset(headers));
}

/**
 * Extract the RFC 5322 `Message-ID` header from raw MIME source, normalized to
 * bare form (surrounding angle brackets stripped). Only the header block (before
 * the first blank line) is scanned, so a `Message-ID:`-looking string inside the
 * body can't be mistaken for the header. Returns "" when absent — e.g. when
 * handed a subject+body blob that carries no headers, which is harmless.
 *
 * @param source - Raw MIME source (or any text) that may contain a header block
 * @returns The bare Message-ID, or "" if none is present
 */
export function extractRfcMessageIdFromSource(source: string): string {
  if (!source || !source.trim()) return "";
  const blankLineIdx = source.search(/\r?\n\r?\n/);
  const headers = blankLineIdx === -1 ? source : source.substring(0, blankLineIdx);
  const raw = getHeader(headers, "Message-ID") ?? getHeader(headers, "Message-Id");
  if (!raw) return "";
  return raw.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
}

/**
 * Extract and decode a specific attachment from MIME source by filename.
 * Supports base64, quoted-printable, and 7bit/8bit/binary transfer encodings.
 * Descends into nested multipart/* containers.
 *
 * @param source - Raw MIME source of the email
 * @param attachmentName - Filename to extract
 * @returns Decoded attachment data, or null if not found
 */
export function extractMimeAttachment(
  source: string,
  attachmentName: string
): MimeAttachmentData | null {
  if (!source || !source.trim()) return null;

  const boundary = extractBoundary(source);
  if (!boundary) return null;

  const parts = walkLeafParts(source, boundary);

  for (const part of parts) {
    const filename = extractFilename(part.headers);
    if (filename !== attachmentName) continue;

    const encoding = getHeader(part.headers, "Content-Transfer-Encoding");
    const data = decodeBody(part.body, encoding);

    return {
      name: filename,
      mimeType: extractMimeType(part.headers),
      size: extractSize(part.headers) || data.length,
      data,
    };
  }

  return null;
}
