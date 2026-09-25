/**
 * Mailbox-name comparison that is insensitive to case AND to Unicode
 * normalization form (#253).
 *
 * The same visible name can be stored two ways: precomposed (NFC — `é` is
 * U+00E9) or decomposed (NFD — `e` + U+0301 COMBINING ACUTE ACCENT). iCloud
 * keeps whatever form the client that created the mailbox sent, so a folder
 * made on a Mac is often NFD (`Me&AwE-xico` in modified UTF-7), while a name a
 * user or model types is almost always NFC (`M&AOk-xico`). Both render
 * identically, so a plain `===` / `toLowerCase()` comparison silently fails to
 * find the mailbox, and sending the typed form to the server gets
 * `NO [NONEXISTENT]`.
 *
 * Compare with `mailboxNameKey`, but always address the server with the path
 * it actually LISTed — never the caller's spelling.
 */
export function mailboxNameKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}

/** Trimmed NFC form — normalization-insensitive but case-preserving. */
export function nfc(name: string): string {
  return name.trim().normalize("NFC");
}
