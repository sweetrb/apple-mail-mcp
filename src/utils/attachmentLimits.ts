/** Maximum decoded size of one inline attachment (25 MiB). */
export const MAX_INLINE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Maximum base64 length capable of representing the decoded byte limit. */
export const MAX_INLINE_ATTACHMENT_BASE64_CHARS = Math.ceil(MAX_INLINE_ATTACHMENT_BYTES / 3) * 4;

/**
 * Bound the raw input too, while allowing RFC-2045 line wrapping and other
 * decoder-ignored whitespace. The authoritative encoded-size check below
 * counts only non-whitespace characters.
 */
export const MAX_INLINE_ATTACHMENT_BASE64_INPUT_CHARS = MAX_INLINE_ATTACHMENT_BASE64_CHARS * 2;

/** True when raw and non-whitespace base64 lengths remain safely bounded. */
export function isInlineAttachmentBase64WithinLimit(contentBase64: string): boolean {
  if (contentBase64.length > MAX_INLINE_ATTACHMENT_BASE64_INPUT_CHARS) return false;

  let encodedChars = 0;
  for (const char of contentBase64) {
    if (!/\s/u.test(char) && ++encodedChars > MAX_INLINE_ATTACHMENT_BASE64_CHARS) return false;
  }
  return true;
}

/** Decode an inline attachment without allowing an unbounded buffer allocation. */
export function decodeInlineAttachment(contentBase64: string): Buffer {
  if (!isInlineAttachmentBase64WithinLimit(contentBase64)) {
    throw new Error("Inline attachment exceeds the 25 MiB decoded size limit.");
  }

  const content = Buffer.from(contentBase64, "base64");
  if (content.length > MAX_INLINE_ATTACHMENT_BYTES) {
    throw new Error("Inline attachment exceeds the 25 MiB decoded size limit.");
  }
  return content;
}
