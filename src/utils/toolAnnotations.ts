import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

type EffectHints = Required<
  Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">
>;

const READ: EffectHints = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const ADD: EffectHints = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const CHANGE: EffectHints = { ...ADD, destructiveHint: true };
const SET: EffectHints = { ...CHANGE, idempotentHint: true };
const SEND: EffectHints = { ...CHANGE, openWorldHint: true };

/**
 * Effects of every mode of a public tool, not just its default arguments.
 *
 * Missing hints have conservative MCP defaults, so omitting them classified
 * ordinary mailbox reads like potential external writes. These describe the
 * operation; they do not grant permission or replace host/user authorization.
 * A private mail account is a closed world even when it uses remote IMAP.
 * Read caches and temporary downloads leave the user's mail/files unchanged.
 * Under MCP's definition, a non-additive update is destructive even when the
 * caller could reverse it (e.g. overwriting a message's read or flag state).
 */
export const MAIL_TOOL_ANNOTATIONS: Readonly<Record<string, EffectHints>> = {
  "search-messages": READ,
  "get-message": READ,
  "get-message-headers": READ,
  // savePath creates a persistent file; the inline-only mode cannot make the
  // whole tool read-only. Existing files are never overwritten.
  "get-message-rfc822": ADD,
  "get-thread": READ,
  "list-messages": READ,
  "send-email": SEND,
  "send-serial-email": SEND,
  "create-draft": ADD,
  // Both can send, including by default, even though send=false creates drafts.
  "reply-to-message": SEND,
  "forward-message": SEND,
  "mark-as-read": SET,
  "mark-as-unread": SET,
  "flag-message": SET,
  "unflag-message": SET,
  "delete-message": CHANGE,
  "move-message": CHANGE,
  "batch-delete-messages": CHANGE,
  "batch-move-messages": CHANGE,
  "batch-mark-as-read": SET,
  "batch-mark-as-unread": SET,
  "batch-flag-messages": SET,
  "batch-unflag-messages": SET,
  "resolve-message-id": READ,
  "list-attachments": READ,
  "save-attachment": ADD,
  "fetch-attachment": READ,
  "list-mailboxes": READ,
  "get-unread-count": READ,
  "create-mailbox": ADD,
  "delete-mailbox": CHANGE,
  "rename-mailbox": CHANGE,
  "list-smart-mailboxes": READ,
  "create-smart-mailbox": ADD,
  "delete-smart-mailbox": CHANGE,
  // dryRun=false writes, so the default preview does not make this read-only.
  "create-newsletter-smart-mailboxes": ADD,
  "list-accounts": READ,
  "list-rules": READ,
  // An existing rule may forward or reply externally, beyond the restricted
  // actions accepted by create-rule. Enabling it can activate those effects.
  "enable-rule": { ...SET, openWorldHint: true },
  "disable-rule": SET,
  "create-rule": CHANGE,
  "delete-rule": CHANGE,
  "search-contacts": READ,
  // With id, save-template replaces existing content; without id it adds one.
  "save-template": CHANGE,
  "list-templates": READ,
  "get-template": READ,
  "delete-template": CHANGE,
  "use-template": ADD,
  "health-check": READ,
  doctor: READ,
  "get-mail-stats": READ,
  "get-sync-status": READ,
};

/** Keep an unclassified future tool conservative until its effects are reviewed. */
export function mailToolAnnotations(name: string): EffectHints {
  return { ...(Object.hasOwn(MAIL_TOOL_ANNOTATIONS, name) ? MAIL_TOOL_ANNOTATIONS[name] : SEND) };
}
