/**
 * RFC 5322 header-block parsing for `get-message-headers` (#224).
 *
 * Both backends hand us the raw header text — IMAP via `FETCH (BODY.PEEK[HEADER])`
 * (imapflow's `headers: true`), AppleScript via Mail's `all headers` property.
 * This module turns that text into something an assistant can act on without
 * re-implementing header folding and RFC 2047 encoded-words itself:
 *
 *   • the raw block, untouched (the forensic record);
 *   • every header as an ordered `{ name, value }` pair, unfolded, duplicates kept
 *     (`Received:` legitimately repeats — it is the hop trace);
 *   • the handful of fields chronological and threading work actually needs,
 *     decoded and pulled out by name.
 *
 * Why this exists: Mail's `date received` (and IMAP's `INTERNALDATE`) is the time
 * the message ARRIVED in the mailbox, which a migration or re-import resets to the
 * migration moment. The `Date:` header is the author's send time and survives
 * such moves. A mailbox where `INTERNALDATE` is wrong by years is not hypothetical
 * — it is the reporter's (#224) — so `date` here is always sourced from the
 * `Date:` header, never from the backend's arrival timestamp.
 *
 * @module utils/headers
 */

export interface HeaderField {
  /** Header name as written (`Message-ID`, `received`, …) — case preserved. */
  name: string;
  /** Unfolded value with the leading space trimmed; RFC 2047 words NOT decoded. */
  value: string;
}

export interface ParsedHeaders {
  /** The raw header block exactly as received, body (if any) stripped. */
  raw: string;
  /** Every field in wire order, folded continuation lines joined. */
  headers: HeaderField[];
  /**
   * `Date:` header parsed to ISO 8601, or undefined when absent/unparseable. This
   * is the author's send time — the value that survives a migration or re-import
   * when the backend's arrival timestamp does not.
   */
  date?: string;
  /** `Date:` header verbatim (so an unparseable one is still visible). */
  dateHeader?: string;
  /** Bare RFC 5322 Message-ID, angle brackets stripped. */
  messageId?: string;
  /** RFC 2047-decoded `Subject:`. */
  subject?: string;
  /** RFC 2047-decoded `From:`. */
  from?: string;
  /** RFC 2047-decoded `To:`. */
  to?: string;
  /** RFC 2047-decoded `Cc:`. */
  cc?: string;
  /** RFC 2047-decoded `Reply-To:`. */
  replyTo?: string;
  /** Bare `In-Reply-To:` id (angle brackets stripped). */
  inReplyTo?: string;
  /** Bare `References:` ids, in order. */
  references: string[];
  /** Every `Received:` header, first-written (= last hop) first, unfolded. */
  received: string[];
}

/**
 * Decode RFC 2047 encoded-words (`=?charset?B|Q?text?=`) in a header value.
 * Adjacent encoded-words separated only by whitespace are concatenated, as the
 * RFC requires. Unknown charsets fall back to UTF-8 rather than throwing — a
 * header we cannot decode should still be returned, not turned into an error.
 */
export function decodeEncodedWords(value: string): string {
  if (!value.includes("=?")) return value;
  // Whitespace between two encoded-words is not part of the text (RFC 2047 §6.2).
  const joined = value.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return joined.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (whole, charset: string, enc: string, text: string) => {
      try {
        const bytes =
          enc.toUpperCase() === "B"
            ? Buffer.from(text, "base64")
            : Buffer.from(
                text
                  .replace(/_/g, " ")
                  .replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) =>
                    String.fromCharCode(parseInt(h, 16))
                  ),
                "latin1"
              );
        return new TextDecoder(normalizeCharset(charset)).decode(bytes);
      } catch {
        return whole;
      }
    }
  );
}

function normalizeCharset(charset: string): string {
  // RFC 2231 language suffix: `utf-8*en` → `utf-8`.
  const bare = charset.split("*")[0].trim().toLowerCase();
  try {
    // TextDecoder throws RangeError on labels it does not know.
    new TextDecoder(bare);
    return bare;
  } catch {
    return "utf-8";
  }
}

/** Strip angle brackets and whitespace from one message id. */
function bareId(raw: string): string {
  return raw.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
}

/** Split a `References:` value into bare ids, tolerating missing brackets. */
function splitIds(raw: string): string[] {
  const bracketed = raw.match(/<[^>]+>/g);
  if (bracketed) return bracketed.map(bareId).filter(Boolean);
  return raw
    .split(/[\s,]+/)
    .map(bareId)
    .filter(Boolean);
}

/**
 * Parse a raw RFC 5322 header block. Accepts CRLF, LF, or bare-CR line endings
 * and a block that still carries a body (everything after the first blank line
 * is dropped). Lines that are neither a `Name: value` field nor a folded
 * continuation are skipped rather than aborting the parse — Mail's `all
 * headers` can carry a trailing blank line and real-world mail is not always
 * well-formed.
 *
 * Bare CR (`\r` with no following `\n`) is a real, previously-unhandled case
 * (#226): Mail's `all headers of msg` AppleScript property is a multi-line
 * text value, and this codebase already normalizes `\r\n|\r|\n` uniformly on
 * the *write* side for exactly this quirk (see `escapeForAppleScriptBody`) —
 * nothing did the equivalent on read-back. Left unhandled, a bare-CR block
 * silently produced ZERO headers: `.split("\n")` never splits it (there is no
 * `\n` to split on), so the whole block is treated as one "line", and JS's
 * regex `.` does not match `\r` either, so the per-line header regex fails to
 * match at all and every field is dropped — not merged, just gone.
 */
export function parseHeaderBlock(input: string): ParsedHeaders {
  const text = (input ?? "").replace(/\r\n|\r/g, "\n");
  const blank = text.search(/\n\n/);
  const raw = (blank === -1 ? text : text.slice(0, blank)).replace(/\n+$/, "");

  const headers: HeaderField[] = [];
  for (const line of raw.split("\n")) {
    if (/^[ \t]/.test(line) && headers.length) {
      // Folded continuation: RFC 5322 §2.2.3 — unfold to a single space.
      headers[headers.length - 1].value += " " + line.trim();
      continue;
    }
    const m = /^([!-9;-~]+):[ \t]?(.*)$/.exec(line);
    if (!m) continue;
    headers.push({ name: m[1], value: m[2].trim() });
  }

  const first = (name: string): string | undefined =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
  const all = (name: string): string[] =>
    headers.filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.value);
  const decoded = (name: string): string | undefined => {
    const v = first(name);
    return v === undefined ? undefined : decodeEncodedWords(v);
  };

  const dateHeader = first("Date");
  let date: string | undefined;
  if (dateHeader) {
    // RFC 5322 allows a trailing `(comment)` zone name, which Date.parse rejects.
    const parsed = new Date(dateHeader.replace(/\s*\([^)]*\)\s*$/, ""));
    if (!Number.isNaN(parsed.getTime())) date = parsed.toISOString();
  }

  const messageIdRaw = first("Message-ID") ?? first("Message-Id");
  const inReplyToRaw = first("In-Reply-To");
  const referencesRaw = first("References");

  return {
    raw,
    headers,
    date,
    dateHeader,
    messageId: messageIdRaw ? bareId(messageIdRaw) || undefined : undefined,
    subject: decoded("Subject"),
    from: decoded("From"),
    to: decoded("To"),
    cc: decoded("Cc"),
    replyTo: decoded("Reply-To"),
    inReplyTo: inReplyToRaw ? bareId(inReplyToRaw) || undefined : undefined,
    references: referencesRaw ? splitIds(referencesRaw) : [],
    received: all("Received"),
  };
}

/**
 * The `structuredContent` payload for `get-message-headers`: the parsed block
 * plus the backend's own arrival timestamp, when it supplied one, so a caller
 * can see the two dates side by side — which is the whole diagnostic for a
 * migrated mailbox (#224).
 */
export function headersStructured(
  id: string,
  parsed: ParsedHeaders,
  dateReceived?: Date | string
): Record<string, unknown> {
  const received =
    dateReceived instanceof Date
      ? Number.isNaN(dateReceived.getTime())
        ? undefined
        : dateReceived.toISOString()
      : dateReceived || undefined;
  return {
    id,
    raw: parsed.raw,
    headers: parsed.headers,
    headerCount: parsed.headers.length,
    ...(parsed.date !== undefined ? { date: parsed.date } : {}),
    ...(parsed.dateHeader !== undefined ? { dateHeader: parsed.dateHeader } : {}),
    ...(received !== undefined ? { dateReceived: received } : {}),
    ...(parsed.messageId !== undefined ? { messageId: parsed.messageId } : {}),
    ...(parsed.subject !== undefined ? { subject: parsed.subject } : {}),
    ...(parsed.from !== undefined ? { from: parsed.from } : {}),
    ...(parsed.to !== undefined ? { to: parsed.to } : {}),
    ...(parsed.cc !== undefined ? { cc: parsed.cc } : {}),
    ...(parsed.replyTo !== undefined ? { replyTo: parsed.replyTo } : {}),
    ...(parsed.inReplyTo !== undefined ? { inReplyTo: parsed.inReplyTo } : {}),
    references: parsed.references,
    received: parsed.received,
  };
}

/** ISO 8601 for a Date that may be absent or invalid; undefined otherwise. */
export function isoOrUndefined(d: Date | string | undefined): string | undefined {
  if (d === undefined || d === "") return undefined;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
