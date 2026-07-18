/** Maximum decoded size of one inline attachment (25 MiB). */
export const MAX_INLINE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Maximum base64 length capable of representing the decoded byte limit. */
export const MAX_INLINE_ATTACHMENT_BASE64_CHARS = Math.ceil(MAX_INLINE_ATTACHMENT_BYTES / 3) * 4;

/** Decode an inline attachment without allowing an unbounded buffer allocation. */
export function decodeInlineAttachment(contentBase64: string): Buffer {
  if (contentBase64.length > MAX_INLINE_ATTACHMENT_BASE64_CHARS) {
    throw new Error("Inline attachment exceeds the 25 MiB decoded size limit.");
  }

  const content = Buffer.from(contentBase64, "base64");
  if (content.length > MAX_INLINE_ATTACHMENT_BYTES) {
    throw new Error("Inline attachment exceeds the 25 MiB decoded size limit.");
  }
  return content;
}
