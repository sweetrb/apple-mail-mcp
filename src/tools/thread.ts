/**
 * Thread / conversation grouping (B1).
 *
 * Mail.app's AppleScript bridge has no thread object and IMAP threading
 * (THREAD/REFERENCES) isn't uniformly available, so get-thread groups a
 * conversation by its normalized subject: strip the reply/forward prefixes and
 * gather every message sharing that base subject. Pragmatic and consistent
 * across both the AppleScript and IMAP backends.
 *
 * @module tools/thread
 */

/**
 * Strip leading reply/forward prefixes ("Re:", "Fwd:", "RE[2]:", localized
 * variants, repeated/stacked) to get the conversation's base subject.
 */
export function normalizeSubject(subject: string): string {
  const prefix = /^\s*(?:(?:re|fwd?|fw|aw|wg|sv|vs|antw|antwort|enc|rif)\s*(?:\[\d+\])?\s*:\s*)+/i;
  let s = (subject ?? "").trim();
  // Apply repeatedly in case of mixed-language stacked prefixes the single pass
  // doesn't fully collapse.
  let prev: string;
  do {
    prev = s;
    s = s.replace(prefix, "").trim();
  } while (s !== prev && s.length > 0);
  return s || subject.trim();
}

/** Pull the subject line out of an imapGetMessage "Subject: …\n\n<body>" result. */
export function subjectFromGetMessage(info: string): string | null {
  const m = info.match(/^Subject:\s*(.*)$/m);
  return m ? m[1].trim() : null;
}
