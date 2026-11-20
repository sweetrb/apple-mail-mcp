import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  SAVED_DRAFT_CHANGES_SCHEMA,
  UPDATE_SAVED_DRAFT_INPUT,
  UPDATE_SAVED_DRAFT_OUTPUT,
  runUpdateSavedDraft,
  SEND_SAVED_DRAFT_INPUT,
  SEND_SAVED_DRAFT_OUTPUT,
  runSendSavedDraft,
} from "@/tools/savedDraft.js";
import { annotationsFor } from "@/tools/toolAnnotations.js";
import { isToolAllowed } from "@/utils/toolMode.js";

describe("update-saved-draft public contract", () => {
  it("defaults to preview and refuses unknown edit/sending fields", () => {
    expect(z.object(UPDATE_SAVED_DRAFT_INPUT).parse({ draftId: "imap:YWJj" }).dryRun).toBe(true);
    expect(() => SAVED_DRAFT_CHANGES_SCHEMA.parse({ send: true })).toThrow();
    expect(() => SAVED_DRAFT_CHANGES_SCHEMA.parse({})).toThrow();
    expect(() =>
      SAVED_DRAFT_CHANGES_SCHEMA.parse({ subject: "Hi\r\nBcc: hidden@example.test" })
    ).toThrow();
    expect(SAVED_DRAFT_CHANGES_SCHEMA.parse({ cc: [], body: "" })).toEqual({ cc: [], body: "" });
  });
  it("is annotated as an overwrite without third-party send effects", () => {
    expect(annotationsFor("update-saved-draft")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });
  it("preserves the separately actionable cleanup failure and both IDs in structured output", async () => {
    const result = await runUpdateSavedDraft({ draftId: "imap:YWJj", dryRun: false }, async () => ({
      ok: false,
      status: "cleanup_failed",
      sourceDraftId: "imap:YWJj",
      draftId: "imap:bmV3",
      sourceRemoved: false,
      error: "Removal failed",
    }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "cleanup_failed",
      sourceDraftId: "imap:YWJj",
      draftId: "imap:bmV3",
    });
    expect(z.object(UPDATE_SAVED_DRAFT_OUTPUT).safeParse(result.structuredContent).success).toBe(
      true
    );
  });
  it("rejects invalid file paths before fetching a draft", async () => {
    const update = vi.fn();
    await expect(
      runUpdateSavedDraft(
        { draftId: "imap:YWJj", dryRun: true, changes: { addAttachments: ["/etc/passwd"] } },
        update
      )
    ).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("send-saved-draft public contract", () => {
  it("defaults to preview and classifies the entire tool as outbound", () => {
    expect(z.object(SEND_SAVED_DRAFT_INPUT).parse({ draftId: "imap:YWJj" }).dryRun).toBe(true);
    expect(
      z.object(SEND_SAVED_DRAFT_INPUT).safeParse({ draftId: "imap:YWJj", approvedUidValidity: "0" })
        .success
    ).toBe(false);
    expect(annotationsFor("send-saved-draft")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(isToolAllowed("send-saved-draft", "full")).toBe(true);
    expect(isToolAllowed("send-saved-draft", "no_send")).toBe(false);
    expect(isToolAllowed("send-saved-draft", "read_only")).toBe(false);
  });

  it("returns actionable partial acceptance without converting it to an ordinary failure", async () => {
    const result = await runSendSavedDraft({ draftId: "imap:YWJj", dryRun: false }, async () => ({
      status: "partial",
      success: true,
      partial: true,
      accepted: ["accepted@example.test"],
      rejected: ["rejected@example.test"],
      draftRemoved: false,
      draftCleanupStatus: "not_attempted",
    }));
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      partial: true,
      accepted: ["accepted@example.test"],
      rejected: ["rejected@example.test"],
      draftRemoved: false,
    });
    expect(JSON.stringify(result.content)).toContain("Do not resend to accepted recipients");
    expect(z.object(SEND_SAVED_DRAFT_OUTPUT).safeParse(result.structuredContent).success).toBe(
      true
    );
  });

  it("exposes uncertain submission explicitly without implying a safe resend", async () => {
    const result = await runSendSavedDraft({ draftId: "imap:YWJj", dryRun: false }, async () => ({
      status: "submission_unknown",
      success: false,
      deliveryUnknown: true,
      error: "Lost DATA acknowledgment",
      draftRemoved: false,
      draftCleanupStatus: "not_attempted",
    }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "submission_unknown",
      deliveryUnknown: true,
    });
    expect(JSON.stringify(result.content)).toContain("Do not resend automatically");
    expect(z.object(SEND_SAVED_DRAFT_OUTPUT).safeParse(result.structuredContent).success).toBe(
      true
    );
  });

  it("retains an unverified cleanup independently from a successful SMTP submission", async () => {
    const result = await runSendSavedDraft({ draftId: "imap:YWJj", dryRun: false }, async () => ({
      status: "submitted",
      success: true,
      sentCopy: false,
      sentCopyError: "Archive unavailable",
      draftCleanupStatus: "unverified",
      draftRemovalVerification: { verdict: "unverified", why: "No readback" },
    }));
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "submitted",
      sentCopy: false,
      draftCleanupStatus: "unverified",
      draftRemovalVerification: { verdict: "unverified" },
    });
    expect(result.structuredContent?.draftRemoved).toBeUndefined();
    expect(z.object(SEND_SAVED_DRAFT_OUTPUT).safeParse(result.structuredContent).success).toBe(
      true
    );
  });
});
