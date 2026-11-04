/**
 * Attachment-name comparison that is insensitive to Unicode normalization
 * form (#370) — the attachment counterpart of the mailbox-name fix (#253, see
 * `mailboxName.ts`).
 *
 * Mail.app stores non-ASCII attachment filenames of messages sent from a Mac
 * decomposed (NFD — `ä` as `a` + U+0308), while a name a user or model passes
 * is almost always precomposed (NFC — U+00E4). The two render identically, so
 * an exact `===` reported "not found … Available: <the same-looking name>".
 *
 * Unlike mailbox names, attachment names are compared case-sensitively and
 * untrimmed: two attachments may legitimately differ only in case, and the
 * caller's spelling is the name the file is saved under.
 */
export function sameAttachmentName(
  stored: string | null | undefined,
  requested: string | null | undefined
): boolean {
  if (stored == null || requested == null) return false;
  return stored.normalize("NFC") === requested.normalize("NFC");
}

/**
 * The distinct spellings of a name to try where the comparison itself cannot
 * normalize (an AppleScript `is` test against Mail's stored name): the
 * caller's own spelling first, so an exact match still matches, then its NFC
 * and NFD forms — the two forms a stored name takes in practice.
 */
export function attachmentNameForms(name: string): string[] {
  return [...new Set([name, name.normalize("NFC"), name.normalize("NFD")])];
}
