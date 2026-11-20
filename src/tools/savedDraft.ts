import { z } from "zod";
import { ATTACHMENTS_SCHEMA, MESSAGE_ID_SCHEMA } from "@/schemas.js";
import type { UpdateSavedDraftInput, UpdateSavedDraftResult } from "@/types.js";
import type { SendSavedDraftInput, SendSavedDraftResult } from "@/types.js";
import { smtpDeliveryNotice } from "@/services/smtpMailer.js";
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

export const SEND_SAVED_DRAFT_INPUT = {
  draftId: UPDATE_SAVED_DRAFT_INPUT.draftId,
  dryRun: z
    .boolean()
    .default(true)
    .describe(
      "Preview without sending by default; false submits the approved current revision once."
    ),
  approvedSha256: UPDATE_SAVED_DRAFT_INPUT.approvedSha256,
  approvedUidValidity: UPDATE_SAVED_DRAFT_INPUT.approvedUidValidity,
};

export const SEND_SAVED_DRAFT_OUTPUT = {
  status: z
    .enum(["preview", "submitted", "partial", "submission_unknown", "not_submitted"])
    .optional(),
  success: z.boolean().optional(),
  alreadyAttempted: z.boolean().optional(),
  draftId: z.string().optional(),
  uid: z.number().optional(),
  uidValidity: z.string().optional(),
  sha256: z.string().optional(),
  from: content.from.optional(),
  to: content.to.optional(),
  cc: content.cc.optional(),
  bcc: content.bcc.optional(),
  replyTo: z.array(z.string()).optional(),
  subject: content.subject.optional(),
  body: content.body.optional(),
  isHtml: content.isHtml.optional(),
  htmlBody: content.htmlBody,
  attachments: content.attachments.optional(),
  messageId: z.string().optional(),
  error: z.string().optional(),
  deliveryUnknown: z.boolean().optional(),
  partial: z.boolean().optional(),
  accepted: z.array(z.string()).optional(),
  rejected: z.array(z.string()).optional(),
  sentCopy: z.boolean().optional(),
  sentCopyError: z.string().optional(),
  sentCopyAlreadyFiled: z.boolean().optional(),
  draftRemoved: z.boolean().optional(),
  draftCleanupStatus: z
    .enum(["not_attempted", "verified", "unverified", "failed", "unknown"])
    .optional(),
  draftRemovalError: z.string().optional(),
  draftRemovalVerification: z
    .discriminatedUnion("verdict", [
      z.object({ verdict: z.literal("verified"), how: z.string() }),
      z.object({ verdict: z.literal("unverified"), why: z.string() }),
    ])
    .optional(),
};

export async function runSendSavedDraft(
  input: SendSavedDraftInput,
  send: (input: SendSavedDraftInput) => Promise<SendSavedDraftResult>
): Promise<ToolResponse> {
  const result = await send(input);
  if (result.status === "preview")
    return successResponse(
      "Current stored draft for approval; nothing sent.\n\n" + JSON.stringify(result, null, 2),
      { ...result }
    );
  const notice = smtpDeliveryNotice(result);
  const text =
    (notice ||
      (result.status === "submitted"
        ? "SMTP accepted the complete approved recipient set."
        : result.error || "SMTP did not submit the draft.")) +
    " Sent-copy and draft cleanup are separate outcomes. Cleanup: " +
    result.draftCleanupStatus +
    (result.alreadyAttempted
      ? " This is the prior attempt's result; no submission or cleanup was repeated."
      : "");
  if (result.status === "submission_unknown" || result.status === "not_submitted")
    return errorResponse(text, { ...result });
  return successResponse(text, { ...result });
}
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
