/**
 * Materialize inline (base64) attachments to temp files (B4).
 *
 * The AppleScript send/draft path attaches files by POSIX path, so inline
 * base64 content is written to a throwaway temp dir first and cleaned up after
 * the operation. Plain string entries (existing absolute paths) pass through.
 *
 * @module utils/attachmentMaterialize
 */
import { writeFileSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AttachmentInput } from "@/types.js";

export interface MaterializedAttachments {
  /** Absolute file paths ready to hand to the AppleScript attachment builder. */
  paths: string[];
  /** Remove any temp files created; safe to call always. */
  cleanup: () => void;
}

export function materializeAttachments(attachments?: AttachmentInput[]): MaterializedAttachments {
  if (!attachments || attachments.length === 0) {
    return { paths: [], cleanup: () => undefined };
  }
  let dir: string | null = null;
  const paths = attachments.map((a) => {
    if (typeof a === "string") return a;
    if (!a.filename || !a.contentBase64) {
      throw new Error("Inline attachment requires both filename and contentBase64.");
    }
    if (!dir) dir = mkdtempSync(join(tmpdir(), "amcp-att-"));
    const safeName = a.filename.replace(/[/\\]/g, "_");
    const p = join(dir, safeName);
    writeFileSync(p, Buffer.from(a.contentBase64, "base64"));
    return p;
  });
  return {
    paths,
    cleanup: () => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}
