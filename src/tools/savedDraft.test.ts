import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  SAVED_DRAFT_CHANGES_SCHEMA,
  UPDATE_SAVED_DRAFT_INPUT,
  UPDATE_SAVED_DRAFT_OUTPUT,
  runUpdateSavedDraft,
} from "@/tools/savedDraft.js";
import { annotationsFor } from "@/tools/toolAnnotations.js";

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
