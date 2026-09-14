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
  /**
   * Repairs applied to a malformed block, in plain words — present only when one
   * fired. `raw` is never rewritten; this says how `headers` differs from it.
   */
  warnings?: string[];
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
 * Non-English month/weekday abbreviations seen in legacy `Date:` headers.
 *
 * Entourage and Outlook for Mac wrote the *system locale's* abbreviations
 * instead of RFC 5322's English ones, so a mailbox migrated from them carries
 * dates like `jue ago 30 13:55:12 2007` (Spanish). `Date.parse` rejects those,
 * and the whole header date is then lost for every message in the mailbox.
 *
 * ⚠️ The failure is easy to miss because it is PARTIAL: months whose
 * abbreviation happens to match English parse fine. Spanish `oct` works while
 * `ago`/`ene`/`abr`/`dic` do not — which is why a spot check on one message can
 * report the mailbox healthy. Reported as #229 by @j5pu.
 *
 * Only the MONTH is load-bearing; the weekday is decorative and V8 ignores an
 * unrecognized leading token, so weekdays are stripped rather than mapped.
 */
const LOCALE_MONTHS: Record<string, string> = {
  // Spanish
  ene: "Jan",
  feb: "Feb",
  mar: "Mar",
  abr: "Apr",
  may: "May",
  jun: "Jun",
  jul: "Jul",
  ago: "Aug",
  sep: "Sep",
  set: "Sep",
  oct: "Oct",
  nov: "Nov",
  dic: "Dec",
  // French
  janv: "Jan",
  févr: "Feb",
  fevr: "Feb",
  avr: "Apr",
  mai: "May",
  juin: "Jun",
  juil: "Jul",
  août: "Aug",
  aout: "Aug",
  déc: "Dec",
  dec: "Dec",
  // German
  jan: "Jan",
  mär: "Mar",
  maer: "Mar",
  mrz: "Mar",
  okt: "Oct",
  dez: "Dec",
  // Italian / Portuguese
  gen: "Jan",
  giu: "Jun",
  lug: "Jul",
  ott: "Oct",
  out: "Oct",
  fev: "Feb",
};

/**
 * Parse a `Date:` header, tolerating the non-English abbreviations above.
 * Returns undefined rather than a fabricated date when the value is unusable —
 * a date is omitted, never invented (same contract as the IMAP rows in 2.19.2).
 */
export function parseDateHeader(value: string): Date | undefined {
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct;

  // Replace the first token that looks like a locale month abbreviation.
  // Case-insensitive, accent-tolerant, and anchored on word boundaries so it
  // cannot rewrite part of a timezone name or a day-of-month.
  let replaced = value;
  for (const [abbr, en] of Object.entries(LOCALE_MONTHS)) {
    const re = new RegExp(`\\b${abbr}\\.?\\b`, "i");
    if (re.test(replaced)) {
      replaced = replaced.replace(re, en);
      break;
    }
  }
  if (replaced !== value) {
    const viaMonth = new Date(replaced);
    if (!Number.isNaN(viaMonth.getTime())) return viaMonth;
  }
  return undefined;
}

/**
 * Header names Mail.app has been seen to pull up onto an empty `Date:` (#234).
 *
 * For a `Date:` value it cannot parse (legacy Entourage / Outlook for Mac
 * locale dates such as `jue ago 30 13:55:12 2007`), Mail's own `all headers of
 * msg` property DROPS the value and joins the following header onto the name:
 *
 *     Date: Subject: diferencial
 *
 * @j5pu isolated this to Mail itself by running `all headers of msg` in Script
 * Editor with no connector in the loop; the same message over IMAP has the
 * Date: line intact. Parsed naively, that reports "Subject: diferencial" as the
 * message's date and loses the Subject header entirely.
 *
 * Deliberately a closed list plus `X-`: a real `Date:` value never begins with
 * `Word:` (its colons sit between digits — `13:55:12`), but a closed list keeps
 * the repair from ever firing on something that merely looks like a name.
 */
const FUSABLE_HEADER_NAMES = new Set([
  "subject",
  "from",
  "to",
  "cc",
  "bcc",
  "sender",
  "reply-to",
  "message-id",
  "in-reply-to",
  "references",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "content-disposition",
  "return-path",
  "received",
  "importance",
  "priority",
  "thread-topic",
  "thread-index",
]);

/**
 * Undo the fusion described above, in place: the `Date:` entry keeps its
 * position with an EMPTY value (the date is unknown — it never arrived) and the
 * swallowed header is re-inserted right after it. Only `Date:` is examined; a
 * `Subject: From: the desk of X` is ordinary text and stays untouched. Returns
 * the swallowed header's name when a repair was made.
 */
function splitFusedDate(headers: HeaderField[]): string | undefined {
  const i = headers.findIndex((h) => h.name.toLowerCase() === "date");
  if (i === -1) return undefined;
  const m = /^([A-Za-z][A-Za-z0-9-]*):[ \t]?(.*)$/.exec(headers[i].value);
  if (!m) return undefined;
  const name = m[1];
  if (!FUSABLE_HEADER_NAMES.has(name.toLowerCase()) && !/^x-/i.test(name)) return undefined;
  headers.splice(i, 1, { name: headers[i].name, value: "" }, { name, value: m[2].trim() });
  return name;
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

  const warnings: string[] = [];
  const fused = splitFusedDate(headers);
  if (fused) {
    warnings.push(
      `The Date: header arrived with no value and the ${fused}: header joined onto it ` +
        "(Mail.app's all-headers property does this for a Date: it cannot parse). " +
        `Split back into Date: and ${fused}:; the send date is unknown from this source.`
    );
  }

  const first = (name: string): string | undefined =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
  const all = (name: string): string[] =>
    headers.filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.value);
  const decoded = (name: string): string | undefined => {
    const v = first(name);
    return v === undefined ? undefined : decodeEncodedWords(v);
  };

  // Empty (a repaired fusion, or a bare `Date:` line) means absent, not "".
  const dateHeader = first("Date") || undefined;
  let date: string | undefined;
  if (dateHeader) {
    // RFC 5322 allows a trailing `(comment)` zone name, which Date.parse rejects.
    const parsed = parseDateHeader(dateHeader.replace(/\s*\([^)]*\)\s*$/, ""));
    if (parsed) date = parsed.toISOString();
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
    ...(warnings.length ? { warnings } : {}),
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
  dateReceived?: Date | string,
  /** Which backend produced the block — so a backend-specific defect is visible (#234). */
  backend?: "imap" | "applescript"
): Record<string, unknown> {
  const received =
    dateReceived instanceof Date
      ? Number.isNaN(dateReceived.getTime())
        ? undefined
        : dateReceived.toISOString()
      : dateReceived || undefined;
  return {
    id,
    ...(backend ? { backend } : {}),
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
    ...(parsed.warnings?.length ? { warnings: parsed.warnings } : {}),
  };
}

/**
 * How far a send time may run AHEAD of arrival before it is treated as invented
 * rather than skewed (#234 §2b).
 *
 * A message cannot be sent after it arrived, but `Date:` is stamped by the
 * sender's clock, so small inversions are routine: a clock minutes or hours
 * fast, a local time written with the wrong zone offset (the whole UTC-12 to
 * UTC+14 spread is 26 hours), a machine that went a day or two without a time
 * sync. Seven days clears all of that with margin.
 *
 * What the guard exists to catch is on another scale entirely: Mail.app's own
 * `date sent` for a `Date:` header it could not parse is a timestamp of Mail's
 * choosing — 2024-08-24 against a 2014-01-14 arrival for a 2007 message in
 * @j5pu's mailbox, 2025 against 2022 for another. Those are years. An
 * inversion between a week and years has no benign explanation either, so
 * nothing real is lost at this boundary.
 */
export const MAX_SENT_AFTER_RECEIVED_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The send time, or undefined when it cannot be real: absent, invalid, or later
 * than the arrival time by more than {@link MAX_SENT_AFTER_RECEIVED_MS}.
 *
 * Cause-agnostic on purpose — it does not matter whether Mail substituted the
 * value or a sender's clock said 2037; either way it is not when the message
 * was sent, and the contract is parsed if possible, omitted if not, never
 * invented. With no valid arrival time to compare against, the send time is
 * kept: the check needs two independent timestamps and never guesses from one.
 */
export function plausibleDateSent(
  sent: Date | undefined,
  received: Date | undefined
): Date | undefined {
  if (!sent || Number.isNaN(sent.getTime())) return undefined;
  if (!received || Number.isNaN(received.getTime())) return sent;
  return sent.getTime() - received.getTime() > MAX_SENT_AFTER_RECEIVED_MS ? undefined : sent;
}

/**
 * The header block of a raw message: the bytes before the first blank line.
 * When there is no blank line, `whole` says whether `source` is the complete
 * message (then it is all header) or a truncated window (then the block did not
 * fit and undefined is returned).
 */
export function headerBlockBytes(source: Buffer, whole: boolean): Buffer | undefined {
  const cuts = [source.indexOf("\r\n\r\n"), source.indexOf("\n\n")].filter((i) => i !== -1);
  if (cuts.length) return source.subarray(0, Math.min(...cuts));
  return whole ? source : undefined;
}

/**
 * Decode raw header bytes to text, one line at a time: strict UTF-8 where the
 * line is valid UTF-8, windows-1252 where it is not (#234 §4).
 *
 * Legacy mail (Entourage, Outlook for Mac, old webmail) wrote accented display
 * names and subjects as bare 8-bit latin-1 — no RFC 2047 encoded-word, no
 * charset anywhere. That is illegal but common, and a UTF-8 decode turns every
 * such byte into U+FFFD. windows-1252 is the WHATWG decoder for the latin1 /
 * iso-8859-1 labels and a superset of both, and an invalid-UTF-8 line has no
 * better-evidenced reading. Per line, not per block, because one message can
 * mix a UTF-8 header with a latin-1 one.
 */
export function decodeHeaderBytes(bytes: Buffer): string {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const cp1252 = new TextDecoder("windows-1252");
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] !== 0x0a) continue;
    const line = bytes.subarray(start, i);
    try {
      lines.push(utf8.decode(line));
    } catch {
      lines.push(cp1252.decode(line));
    }
    start = i + 1;
  }
  return lines.join("\n");
}

/** ISO 8601 for a Date that may be absent or invalid; undefined otherwise. */
export function isoOrUndefined(d: Date | string | undefined): string | undefined {
  if (d === undefined || d === "") return undefined;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
