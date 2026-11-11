import { z } from "zod";
import { ATTACHMENTS_SCHEMA, MESSAGE_ID_SCHEMA } from "@/schemas.js";
import type { UpdateSavedDraftInput, UpdateSavedDraftResult } from "@/types.js";
import { preflightAttachments } from "@/utils/attachmentMaterialize.js";
import { successResponse, errorResponse, type ToolResponse } from "@/tools/respond.js";

const header = z
  .string()
  .max(10_000)
  .regex(/^[^\r\n\0]*$/, "Headers cannot contain CR, LF or NUL");
const recipients = z.array(header.min(1)).max(100);
export const SAVED_DRAFT_CHANGES_SCHEMA = z
  .object({
    subject: header.optional(),
    to: recipients.optional(),
    cc: recipients.optional(),
    bcc: recipients.optional(),
    body: z
      .string()
      .max(100_000)
      .optional()
      .describe("Replace the existing text/plain body. If HTML exists, also supply htmlBody."),
    htmlBody: z
      .string()
      .max(100_000)
      .optional()
      .describe("Replace the existing text/html body. If plain text exists, also supply body."),
    addAttachments: ATTACHMENTS_SCHEMA,
    removeAttachments: z
      .array(z.string().regex(/^(0|[1-9]\d*(\.[1-9]\d*)*)$/))
      .max(100)
      .optional()
      .describe(
        "MIME partId values from this revision's preview; embedded CID images cannot be removed."
      ),
  })
  .strict()
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    "Supply at least one changed field"
  );

export const UPDATE_SAVED_DRAFT_INPUT = {
  draftId: MESSAGE_ID_SCHEMA.describe(
    "An imap: ID freshly listed in the account's SPECIAL-USE Drafts mailbox. Numeric IDs are refused."
  ),
  dryRun: z
    .boolean()
    .default(true)
    .describe("Preview only by default. false applies the changes; never sends mail."),
  approvedSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional()
    .describe("Current stored MIME SHA-256 from preview, required to apply changes."),
  approvedUidValidity: z
    .string()
    .regex(/^[1-9]\d*$/)
    .optional()
    .describe("Current mailbox UIDVALIDITY from preview, required to apply changes."),
  changes: SAVED_DRAFT_CHANGES_SCHEMA.optional().describe(
    "Partial patch. Omitted fields are preserved; [] clears To/Cc/Bcc. Adding/removing attachments is explicit."
  ),
};

const content = {
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  isHtml: z.boolean(),
  htmlBody: z.string().optional(),
  attachments: z.array(
    z.object({
      partId: z.string(),
      name: z.string(),
      mimeType: z.string(),
      size: z.number(),
      removable: z.boolean(),
    })
  ),
};
export const UPDATE_SAVED_DRAFT_OUTPUT = {
  ok: z.boolean().optional(),
  status: z
    .enum(["preview", "updated", "unchanged", "append_failed", "append_unknown", "cleanup_failed"])
    .optional(),
  sourceDraftId: z.string().optional(),
  draftId: z.string().optional(),
  sourceRemoved: z
    .boolean()
    .optional()
    .describe("true only after confirmed removal; omitted if cleanup's outcome is uncertain."),
  error: z.string().optional(),
  preview: z
    .object({
      ...content,
      draftId: z.string(),
      uid: z.number(),
      uidValidity: z.string(),
      sha256: z.string(),
    })
    .optional(),
  proposed: z.object(content).optional(),
};

export async function runUpdateSavedDraft(
  input: UpdateSavedDraftInput,
  update: (input: UpdateSavedDraftInput) => Promise<UpdateSavedDraftResult>
): Promise<ToolResponse> {
  preflightAttachments(input.changes?.addAttachments);
  const result = await update(input);
  if (!result.ok)
    return errorResponse(result.error ?? "Draft update requires inspection before retrying.", {
      ...result,
    });
  const text =
    result.status === "preview"
      ? "Stored draft preview; no mailbox changes. Use preview.sha256 and preview.uidValidity to approve the source revision."
      : result.status === "unchanged"
        ? "Draft is unchanged; no replacement was appended."
        : "Updated draft saved and old revision removed. Nothing was sent. Use the new draftId and revision for subsequent operations.";
  return successResponse(
    text + "\n\n" + JSON.stringify({ preview: result.preview, proposed: result.proposed }, null, 2),
    { ...result }
  );
}
