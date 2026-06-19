import type { AttachmentInput } from "../types.js";
export interface MaterializedAttachments {
    /** Absolute file paths ready to hand to the AppleScript attachment builder. */
    paths: string[];
    /** Remove any temp files created; safe to call always. */
    cleanup: () => void;
}
export declare function materializeAttachments(attachments?: AttachmentInput[]): MaterializedAttachments;
//# sourceMappingURL=attachmentMaterialize.d.ts.map