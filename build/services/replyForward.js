/**
 * Pull bare email addresses out of a header value such as
 * `"Alice <a@x.com>, bob@y.com"` → `["a@x.com", "bob@y.com"]`. Splits on commas
 * (address lists are comma-separated) and unwraps `<...>` when present. Anything
 * without an `@` is dropped, so group syntax / junk is ignored.
 */
export function extractAddresses(headerValue) {
    if (!headerValue.trim())
        return [];
    return headerValue
        .split(",")
        .map((part) => {
        const angle = part.match(/<([^>]+)>/);
        return (angle ? angle[1] : part).trim();
    })
        .filter((addr) => addr.includes("@"));
}
/**
 * Parse the header block (everything before the first blank line) of a raw
 * message. Continuation lines (folded headers, leading WSP) are unfolded, and
 * header names are matched case-insensitively. Only the headers in
 * {@link OriginalHeaders} are extracted.
 */
export function parseOriginalHeaders(raw) {
    const headerBlock = raw.split(/\r?\n\r?\n/)[0] ?? "";
    // Unfold: any line starting with a space/tab continues the previous header.
    const lines = [];
    for (const line of headerBlock.split(/\r?\n/)) {
        if (/^[ \t]/.test(line) && lines.length > 0) {
            lines[lines.length - 1] += " " + line.trim();
        }
        else {
            lines.push(line);
        }
    }
    const get = (name) => {
        const prefix = `${name.toLowerCase()}:`;
        const found = lines.find((l) => l.toLowerCase().startsWith(prefix));
        return found ? found.slice(found.indexOf(":") + 1).trim() : undefined;
    };
    const rawMessageId = get("Message-ID");
    const messageId = rawMessageId?.match(/<[^>]+>/)?.[0] ?? rawMessageId ?? undefined;
    const references = `${get("References") ?? ""} ${get("In-Reply-To") ?? ""}`.match(/<[^>]+>/g) ?? [];
    return {
        messageId,
        references,
        from: extractAddresses(get("From") ?? ""),
        replyTo: extractAddresses(get("Reply-To") ?? ""),
        to: extractAddresses(get("To") ?? ""),
        cc: extractAddresses(get("Cc") ?? ""),
        subject: get("Subject") ?? "",
        date: get("Date"),
    };
}
/** Case-insensitive de-dupe that preserves first-seen order and casing. */
function dedupe(addrs) {
    const seen = new Set();
    const out = [];
    for (const a of addrs) {
        const k = a.toLowerCase();
        if (!seen.has(k)) {
            seen.add(k);
            out.push(a);
        }
    }
    return out;
}
/**
 * Ensure `subject` carries `prefix` exactly once. Existing `Re:`/`Fwd:`/`Fw:`
 * prefixes (any case) are treated as already-present so we never stack them.
 */
export function withSubjectPrefix(subject, prefix) {
    const s = subject.trim();
    const present = prefix === "Re:" ? /^re:/i : /^(fwd?|fw):/i;
    return present.test(s) ? s : `${prefix} ${s}`;
}
/** Prefix every line of the original body with `> ` for the quoted reply block. */
export function quoteBody(plainText) {
    return plainText
        .replace(/\s+$/, "")
        .split(/\r?\n/)
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
}
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
export function buildReplyOptions(args) {
    const { original, originalPlainText, body, replyAll, self, from } = args;
    const selfSet = new Set(self.filter(Boolean).map((s) => s.toLowerCase()));
    const to = dedupe((original.replyTo.length ? original.replyTo : original.from).filter(Boolean));
    const toSet = new Set(to.map((t) => t.toLowerCase()));
    let cc;
    if (replyAll) {
        const extra = dedupe([...original.to, ...original.cc].filter((a) => !selfSet.has(a.toLowerCase()) && !toSet.has(a.toLowerCase())));
        cc = extra.length ? extra : undefined;
    }
    const attribution = buildAttribution(original);
    const quoted = originalPlainText.trim()
        ? `\n\n${attribution}${quoteBody(originalPlainText)}`
        : "";
    const references = dedupe(original.messageId ? [...original.references, original.messageId] : original.references);
    return {
        to,
        cc,
        subject: withSubjectPrefix(original.subject, "Re:"),
        body: `${body}${quoted}`,
        inReplyTo: original.messageId,
        references: references.length ? references : undefined,
        from,
    };
}
/** "On <date>, <sender> wrote:\n" — omits the date clause when unknown. */
function buildAttribution(original) {
    const who = original.from[0] ?? original.replyTo[0] ?? "the sender";
    return original.date ? `On ${original.date}, ${who} wrote:\n` : `${who} wrote:\n`;
}
/**
 * Build {@link SmtpSendOptions} for a forward to new recipients. A forward
 * starts a new thread, so no `In-Reply-To`/`References` are set — the win over
 * the AppleScript path is a clean, un-wrapped MIME body.
 */
export function buildForwardOptions(args) {
    const { original, originalPlainText, to, body, from } = args;
    const headerBlock = [
        "---------- Forwarded message ----------",
        original.from.length ? `From: ${original.from.join(", ")}` : "",
        original.date ? `Date: ${original.date}` : "",
        `Subject: ${original.subject}`,
        original.to.length ? `To: ${original.to.join(", ")}` : "",
        original.cc.length ? `Cc: ${original.cc.join(", ")}` : "",
    ]
        .filter(Boolean)
        .join("\n");
    const prefix = body?.trim() ? `${body}\n\n` : "";
    return {
        to: dedupe(to),
        subject: withSubjectPrefix(original.subject, "Fwd:"),
        body: `${prefix}${headerBlock}\n\n${originalPlainText}`,
        from,
    };
}
