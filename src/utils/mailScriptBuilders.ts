export function escapeForAppleScript(text: string): string {
  if (!text) return "";
  // Escape backslash and double-quote for the AppleScript string literal, and
  // strip ASCII control characters. An AppleScript double-quoted literal cannot
  // contain a raw newline, so an interpolated value with a `\n` (or other
  // control char) would terminate the literal early and could inject a
  // statement; stripping them closes that gap (audit finding #10).
  return (
    text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, "")
  );
}

/**
 * Escape a message BODY for interpolation into an AppleScript string literal.
 *
 * Same injection defense as {@link escapeForAppleScript} (backslash then quote,
 * in that order), but instead of stripping line breaks it converts CRLF / CR /
 * LF to the two-character sequence `\n` (and tab to `\t`), which AppleScript
 * 2.0+ interprets as a linefeed/tab inside a double-quoted literal. No raw
 * control character ever reaches the emitted literal, so the audit finding #10
 * fix is preserved — but paragraph breaks survive in bodies instead of
 * collapsing into a wall of text. Any remaining control characters are
 * stripped exactly as in the single-line variant.
 *
 * Use ONLY for body/content values. Subjects, addresses, account/mailbox
 * names, paths, queries, and rule expressions must stay on
 * {@link escapeForAppleScript} so they remain single-line.
 */
export function escapeForAppleScriptBody(text: string): string {
  if (!text) return "";
  return (
    text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r\n|\r|\n/g, "\\n")
      .replace(/\t/g, "\\t")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, "")
  );
}

export function buildAppLevelScript(command: string): string {
  return `
    tell application "Mail"
      ${command}
    end tell
  `;
}
