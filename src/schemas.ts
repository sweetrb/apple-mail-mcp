/**
 * Shared MCP input schemas.
 *
 * Keep the schemas that define the public validation contract in one module so
 * security tests and the server's tool registrations cannot silently drift
 * apart.
 */
import { z } from "zod";
import {
  isInlineAttachmentBase64WithinLimit,
  MAX_INLINE_ATTACHMENT_BASE64_INPUT_CHARS,
} from "@/utils/attachmentLimits.js";

/** A single-message id is EITHER an AppleScript numeric id OR an IMAP composite
 *  token (`imap:<base64url>`, emitted by the IMAP read path). The IMAP form is
 *  base64url so it stays injection-safe; it never reaches AppleScript (it's
 *  decoded and routed to IMAP instead). */
export const MESSAGE_ID_SCHEMA = z
  .string()
  .regex(/^(\d+|imap:[A-Za-z0-9_-]+)$/, "Message ID must be numeric or an IMAP id (imap:…)");

/** Batch operations accept numeric (AppleScript) and/or imap: ids (I2) and are
 *  capped to prevent unbounded loops / DoS. Numeric ids run via AppleScript;
 *  imap: ids are grouped by mailbox and applied in a single UID command. */
export const BATCH_IDS_SCHEMA = z
  .array(MESSAGE_ID_SCHEMA)
  .min(1, "At least one message ID is required")
  .max(100, "Cannot process more than 100 messages in a single batch");

/** Date filter strings must look like natural-language dates (e.g. "March 1, 2026").
 *  Block characters that could escape an AppleScript `date "..."` literal. */
export const DATE_FILTER_SCHEMA = z
  .string()
  .regex(
    /^[a-zA-Z0-9 ,/\-:]+$/,
    "Date must contain only alphanumeric characters, spaces, commas, slashes, hyphens, and colons"
  )
  .refine((val) => !isNaN(new Date(val).getTime()), {
    message: "Date string must be a valid date (e.g., 'January 1, 2026' or '2026-03-15')",
  })
  .optional();

// Attachments: allowlisted absolute file paths and/or inline base64 content (B4).
export const ATTACHMENTS_SCHEMA = z
  .array(
    z.union([
      z.string().describe("Absolute path to an existing file in an allowed read root"),
      z.object({
        filename: z.string().min(1).max(255).describe("Filename to give the attachment"),
        contentBase64: z
          .string()
          .min(1)
          .max(
            MAX_INLINE_ATTACHMENT_BASE64_INPUT_CHARS,
            "Inline attachment exceeds the 25 MiB decoded size limit"
          )
          .refine(
            isInlineAttachmentBase64WithinLimit,
            "Inline attachment exceeds the 25 MiB decoded size limit"
          )
          .describe("Base64-encoded file content (maximum 25 MiB decoded)"),
      }),
    ])
  )
  .max(20, "Cannot attach more than 20 files")
  .optional()
  .describe(
    "Files to attach: absolute paths in the configured attachment read roots (e.g. " +
      "'/Users/me/Documents/report.pdf') and/or inline {filename, contentBase64} objects " +
      "up to 25 MiB decoded each."
  );

/**
 * One RFC 5322 `msg-id` token as it appears on the wire: `<left@right>`, no
 * whitespace, no nested angle brackets (#267). Deliberately strict — these
 * values are emitted verbatim into `In-Reply-To` / `References`, and a value a
 * MIME library has to "fix up" (wrap, encode) is exactly how threading silently
 * breaks on the recipient side.
 */
export const RFC_MESSAGE_ID_TOKEN = /^<[^<>\s@]+@[^<>\s@]+>$/;

const MESSAGE_ID_TOKEN_SCHEMA = z
  .string()
  .max(998, "Message-ID is longer than an RFC 5322 header line (998 chars)")
  .regex(
    RFC_MESSAGE_ID_TOKEN,
    "Must be an RFC 5322 Message-ID token including angle brackets, e.g. <abc123@mail.example.com>"
  );

/** Optional `In-Reply-To` for send-email / create-draft (#267). */
export const IN_REPLY_TO_SCHEMA = MESSAGE_ID_TOKEN_SCHEMA.optional().describe(
  "Thread this message as a reply: the parent's Message-ID token, angle brackets included " +
    "(e.g. '<abc123@mail.example.com>'). Emitted verbatim as In-Reply-To, never RFC 2047-encoded. " +
    "When `references` is omitted, References defaults to [inReplyTo]. Prefer reply-to-message, " +
    "which derives recipients, threading and the quote from the original for you."
);

/** Optional `References` chain for send-email / create-draft (#267). */
export const REFERENCES_SCHEMA = z
  .array(MESSAGE_ID_TOKEN_SCHEMA)
  .min(1, "references must contain at least one Message-ID")
  .max(100, "Cannot list more than 100 Message-IDs in references")
  .optional()
  .describe(
    "Thread chain, oldest first: the parent's own References followed by the parent's " +
      "Message-ID (each an angle-bracketed token). Emitted verbatim, never RFC 2047-encoded."
  );
