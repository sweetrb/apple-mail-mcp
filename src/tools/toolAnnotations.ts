/**
 * MCP tool annotations for every tool, in one table.
 *
 * Until 2.20.54 only get-message-headers carried a hint, so a client could not
 * auto-approve reads while still gating writes: every tool looked equally
 * dangerous, which trains users to "always allow" all of them — including the
 * ones that send mail. Clients key approval UX on these hints, and email content
 * is attacker-authored input to the model, so honest hints are a real control
 * against prompt-injection-driven sends and deletes.
 *
 * - READ: no state change anywhere.
 * - WRITE: changes state but can be undone or only adds (flag, move, draft,
 *   a new file that never overwrites).
 * - DESTRUCTIVE: deletes, overwrites, or cannot be recalled once done.
 * - openWorldHint marks the tools whose effect leaves this machine and the
 *   user's own mailboxes: mail to third parties, and rules that can forward.
 *
 * `registerTool` refuses a tool that has no entry here, so a new tool cannot
 * ship unclassified.
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};
const IDEMPOTENT_WRITE: ToolAnnotations = { ...WRITE, idempotentHint: true };
const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
};
const SEND: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

export const TOOL_ANNOTATIONS: Readonly<Record<string, ToolAnnotations>> = {
  // Reads
  "search-messages": READ,
  "get-message": READ,
  "get-message-headers": READ,
  "get-thread": READ,
  "list-messages": READ,
  "resolve-message-id": READ,
  "list-attachments": READ,
  "fetch-attachment": READ,
  "list-mailboxes": READ,
  "get-unread-count": READ,
  "list-smart-mailboxes": READ,
  "list-accounts": READ,
  "list-rules": READ,
  "search-contacts": READ,
  "list-templates": READ,
  "get-template": READ,
  "health-check": READ,
  doctor: READ,
  "get-mail-stats": READ,
  "get-sync-status": READ,

  // Writes that add, or that can be undone
  "get-message-rfc822": WRITE, // optional savePath creates a file
  "save-attachment": WRITE, // creates a new file; never overwrites
  "create-draft": WRITE,
  "use-template": WRITE, // creates a draft
  "move-message": WRITE,
  "batch-move-messages": WRITE,
  "mark-as-read": IDEMPOTENT_WRITE,
  "mark-as-unread": IDEMPOTENT_WRITE,
  "flag-message": IDEMPOTENT_WRITE,
  "unflag-message": IDEMPOTENT_WRITE,
  "batch-mark-as-read": IDEMPOTENT_WRITE,
  "batch-mark-as-unread": IDEMPOTENT_WRITE,
  "batch-flag-messages": IDEMPOTENT_WRITE,
  "batch-unflag-messages": IDEMPOTENT_WRITE,
  "create-mailbox": WRITE,
  "rename-mailbox": WRITE,
  "create-smart-mailbox": WRITE,
  "create-newsletter-smart-mailboxes": WRITE,
  "disable-rule": IDEMPOTENT_WRITE,

  // Destructive or irreversible
  "delete-message": DESTRUCTIVE,
  "batch-delete-messages": DESTRUCTIVE,
  "delete-mailbox": DESTRUCTIVE,
  "delete-smart-mailbox": DESTRUCTIVE,
  "delete-rule": DESTRUCTIVE,
  "delete-template": DESTRUCTIVE,
  "save-template": DESTRUCTIVE, // passing an existing id overwrites that template
  "create-rule": { ...SEND, idempotentHint: false }, // a rule can delete or forward mail
  "enable-rule": { ...SEND, idempotentHint: true },

  // Outbound mail: leaves the machine and cannot be recalled
  "send-email": SEND,
  "send-serial-email": SEND,
  "reply-to-message": SEND, // sends by default (send: true)
  "forward-message": SEND, // sends by default (send: true)
};

/** The annotations for `name`, merged under any the registration supplies itself. */
export function annotationsFor(name: string, own?: ToolAnnotations): ToolAnnotations {
  const base = TOOL_ANNOTATIONS[name];
  if (!base) {
    throw new Error(
      `Tool "${name}" has no entry in src/tools/toolAnnotations.ts; classify it before registering.`
    );
  }
  return { ...base, ...own };
}
