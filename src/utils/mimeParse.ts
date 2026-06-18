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

/**
 * Extract filename from Content-Disposition or Content-Type headers.
 */
function extractFilename(headers: string): string | null {
  // Try Content-Disposition filename first
  const dispHeader = getHeader(headers, "Content-Disposition");
  if (dispHeader) {
    const fnMatch = dispHeader.match(/filename="?([^";\r\n]+)"?/i);
    if (fnMatch) return fnMatch[1].trim();
  }
  // Fall back to Content-Type name parameter
  const ctHeader = getHeader(headers, "Content-Type");
  if (ctHeader) {
    const nameMatch = ctHeader.match(/name="?([^";\r\n]+)"?/i);
    if (nameMatch) return nameMatch[1].trim();
  }
  return null;
}

/**
 * Check if a MIME part has inline disposition (not a real attachment).
 */
function isInlineDisposition(headers: string): boolean {
  const dispHeader = getHeader(headers, "Content-Disposition");
  if (!dispHeader) return false;
  return dispHeader.toLowerCase().startsWith("inline");
}

/**
 * Extract size from Content-Disposition size parameter.
 */
function extractSize(headers: string): number {
  const dispHeader = getHeader(headers, "Content-Disposition");
  if (dispHeader) {
    const sizeMatch = dispHeader.match(/size=(\d+)/i);
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

/**
 * Estimate decoded size from base64 content length.
 */
function estimateBase64Size(base64Body: string): number {
  const cleaned = base64Body.replace(/[\s\r\n]/g, "");
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
 * Walk a multipart MIME block and return all non-multipart leaf parts,
 * descending into nested multipart/* containers (alternative, related, mixed).
 */
function walkLeafParts(source: string, boundary: string): MimePart[] {
  const result: MimePart[] = [];
  const parts = splitMimeParts(source, boundary);

  for (const part of parts) {
    const ct = getHeader(part.headers, "Content-Type");
    if (ct && /^multipart\//i.test(ct)) {
      const nestedBoundary = extractBoundary(ct);
      if (nestedBoundary) {
        result.push(...walkLeafParts(part.body, nestedBoundary));
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
 * Estimate body size for metadata when Content-Disposition size is absent.
 */
function estimateSize(body: string, encoding: string | null): number {
  const enc = (encoding || "").toLowerCase().trim();
  if (enc === "base64") return estimateBase64Size(body);
  // For other encodings the body length is a reasonable proxy
  return body.length;
}

/**
 * Parse MIME source and return metadata for all file attachments.
 * Skips inline dispositions (signature images, etc.). Descends into
 * nested multipart/* containers.
 *
 * @param source - Raw MIME source of the email
 * @returns Array of attachment metadata (name, mimeType, size)
 */
export function parseMimeAttachments(source: string): MimeAttachmentInfo[] {
  if (!source || !source.trim()) return [];

  const boundary = extractBoundary(source);
  if (!boundary) return [];

  const parts = walkLeafParts(source, boundary);
  const attachments: MimeAttachmentInfo[] = [];

  for (const part of parts) {
    const filename = extractFilename(part.headers);
    if (!filename) continue;

    if (isInlineDisposition(part.headers)) continue;

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
 * Content-Transfer-Encoding (base64 / quoted-printable / raw) and returned as
 * UTF-8 text.
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
        return decodeBody(part.body, encoding).toString("utf8");
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
  return decodeBody(body, encoding).toString("utf8");
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
        return decodeBody(part.body, encoding).toString("utf8");
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
  return decodeBody(body, encoding).toString("utf8");
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
