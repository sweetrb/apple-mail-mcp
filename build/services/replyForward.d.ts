/**
 * Pure helpers that turn an existing message (its raw RFC 5322 source plus the
 * decoded plain-text body) into {@link SmtpSendOptions} for a **threaded reply**
 * or a **forward** sent over SMTP.
 *
 * This is the 2.5.0 "prefer-direct" path: when SMTP is configured we send
 * replies/forwards ourselves with correct `In-Reply-To`/`References` headers and
 * a clean MIME body, instead of driving Mail.app's `reply`/`forward` AppleScript
 * commands (which thread correctly but wrap the injected body in a `blockquote`
 * on macOS 15+). Kept separate from {@link sendViaSmtp} so the addressing,
 * subject-prefix, and quoting rules are unit-testable without a live SMTP server.
 */
import type { SmtpSendOptions } from "../services/smtpMailer.js";
/** The subset of an original message's headers we need to reply/forward. */
export interface OriginalHeaders {
    /** Raw `Message-ID` including angle brackets, e.g. `<abc@host>`. */
    messageId?: string;
    /** Thread chain: every `<id>` from `References` + `In-Reply-To`, in order. */
    references: string[];
    /** `From` address(es), bare (no display name). */
    from: string[];
    /** `Reply-To` address(es), bare. Preferred over {@link from} for replies. */
    replyTo: string[];
    /** `To` address(es), bare. */
    to: string[];
    /** `Cc` address(es), bare. */
    cc: string[];
    /** `Subject`, unfolded and trimmed (no `Re:`/`Fwd:` normalization). */
    subject: string;
    /** `Date` header verbatim, for the reply attribution line. */
    date?: string;
}
/**
 * Pull bare email addresses out of a header value such as
 * `"Alice <a@x.com>, bob@y.com"` → `["a@x.com", "bob@y.com"]`. Splits on commas
 * (address lists are comma-separated) and unwraps `<...>` when present. Anything
 * without an `@` is dropped, so group syntax / junk is ignored.
 */
export declare function extractAddresses(headerValue: string): string[];
/**
 * Parse the header block (everything before the first blank line) of a raw
 * message. Continuation lines (folded headers, leading WSP) are unfolded, and
 * header names are matched case-insensitively. Only the headers in
 * {@link OriginalHeaders} are extracted.
 */
export declare function parseOriginalHeaders(raw: string): OriginalHeaders;
/**
 * Ensure `subject` carries `prefix` exactly once. Existing `Re:`/`Fwd:`/`Fw:`
 * prefixes (any case) are treated as already-present so we never stack them.
 */
export declare function withSubjectPrefix(subject: string, prefix: "Re:" | "Fwd:"): string;
/** Prefix every line of the original body with `> ` for the quoted reply block. */
export declare function quoteBody(plainText: string): string;
/**
 * Build {@link SmtpSendOptions} for a threaded reply.
 *
 * - recipients: `Reply-To` if the original had one, else `From`; with
 *   `replyAll`, the original `To`+`Cc` (minus our own addresses and the primary
 *   recipients) become `Cc`.
 * - subject: `Re: ` prepended unless already present.
 * - threading: `In-Reply-To` = original `Message-ID`; `References` = original
 *   chain + that `Message-ID`.
 * - body: the new text, then an attribution line and the quoted original.
 */
export declare function buildReplyOptions(args: {
    original: OriginalHeaders;
    originalPlainText: string;
    body: string;
    replyAll: boolean;
    /** Our own addresses, excluded from a reply-all recipient set. */
    self: string[];
    /** From override (defaults to the SMTP identity at send time when omitted). */
    from?: string;
}): SmtpSendOptions;
/**
 * Build {@link SmtpSendOptions} for a forward to new recipients. A forward
 * starts a new thread, so no `In-Reply-To`/`References` are set — the win over
 * the AppleScript path is a clean, un-wrapped MIME body.
 */
export declare function buildForwardOptions(args: {
    original: OriginalHeaders;
    originalPlainText: string;
    to: string[];
    body?: string;
    from?: string;
}): SmtpSendOptions;
//# sourceMappingURL=replyForward.d.ts.map