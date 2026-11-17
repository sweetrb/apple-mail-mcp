/**
 * Server-side tool gate, set by APPLE_MAIL_MCP_MODE.
 *
 * Tool descriptions asking the model to "confirm with the user" are advisory: a
 * prompt injection carried in an email body can still call `send-email` or
 * `batch-delete-messages`. The mode removes those tools from the server, so a
 * caller cannot reach them at all.
 *
 * - `full` (default): every tool, as upstream.
 * - `no_send`: everything except the tools that send mail or can make Mail send
 *   on its own (enabling a forward/redirect/auto-reply rule).
 * - `read_only`: only the tools in READ_ONLY_TOOLS. It is an allow-list, so a
 *   tool added upstream stays out until someone classifies it.
 *
 * Every tool is classified in exactly one of the three sets below;
 * toolMode.test.ts fails when src/index.ts registers a tool that is not.
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export const TOOL_MODE_ENV = "APPLE_MAIL_MCP_MODE";

export type ToolMode = "full" | "no_send" | "read_only";

const TOOL_MODES: readonly ToolMode[] = ["full", "no_send", "read_only"];

/** Tools that put a message on the wire, or let Mail do it unattended. */
export const SENDING_TOOLS = new Set([
  "send-email",
  "send-serial-email",
  "reply-to-message",
  "forward-message",
  // A disabled rule can forward, redirect or auto-reply once enabled.
  "enable-rule",
]);

/** Tools that change nothing in Mail, on disk or in the template store. */
export const READ_ONLY_TOOLS = new Set([
  "search-messages",
  "get-message",
  "get-message-headers",
  "get-thread",
  "list-messages",
  "resolve-message-id",
  "list-attachments",
  "fetch-attachment",
  "list-mailboxes",
  "get-unread-count",
  "list-smart-mailboxes",
  "list-accounts",
  "get-account-settings",
  "list-rules",
  "search-contacts",
  "list-templates",
  "get-template",
  "health-check",
  "doctor",
  "get-mail-stats",
  "get-sync-status",
]);

/** Tools that write without sending. get-message-rfc822 writes a file when given savePath. */
export const WRITING_TOOLS = new Set([
  "get-message-rfc822",
  "create-draft",
  "update-saved-draft",
  "mark-as-read",
  "mark-as-unread",
  "flag-message",
  "unflag-message",
  "delete-message",
  "move-message",
  "batch-delete-messages",
  "batch-move-messages",
  "batch-mark-as-read",
  "batch-mark-as-unread",
  "batch-flag-messages",
  "batch-unflag-messages",
  "save-attachment",
  "create-mailbox",
  "delete-mailbox",
  "rename-mailbox",
  "set-account-settings",
  "restart-mail",
  "create-smart-mailbox",
  "delete-smart-mailbox",
  "create-newsletter-smart-mailboxes",
  "disable-rule",
  "create-rule",
  "delete-rule",
  "save-template",
  "delete-template",
  "use-template",
]);

/** Tools whose effect cannot be taken back from inside Mail. */
const DESTRUCTIVE_TOOLS = new Set([
  ...SENDING_TOOLS,
  "delete-message",
  "batch-delete-messages",
  "delete-mailbox",
  "delete-smart-mailbox",
  "create-rule",
  "delete-rule",
  "delete-template",
  // It can switch an account off, which stops its mail fetching and sending.
  "set-account-settings",
]);

/** Parse the mode; an unknown value is a configuration error, never a silent `full`. */
export function parseToolMode(raw: string | undefined): ToolMode {
  const value = (raw ?? "").trim().toLowerCase() || "full";
  if ((TOOL_MODES as readonly string[]).includes(value)) return value as ToolMode;
  throw new Error(`${TOOL_MODE_ENV} must be one of ${TOOL_MODES.join(", ")}; got "${raw}".`);
}

/**
 * Resolve the mode after loadFileConfig(). `configText` is the raw config file,
 * or undefined when there is none. loadFileConfig tolerates a corrupt file and
 * skips non-string values; if that left the mode unset although the file names
 * it, the user asked for a mode the server could not read — stop rather than
 * run as `full`. `unreadable` is why the file could not be read at all (a
 * missing file is not that): the mode it may set is then unknown, so the same
 * applies.
 */
export function resolveToolMode(
  env: NodeJS.ProcessEnv,
  configText: string | undefined,
  unreadable?: string
): ToolMode {
  const raw = env[TOOL_MODE_ENV];
  if ((raw === undefined || raw === "") && unreadable !== undefined) {
    throw new Error(
      `The config file could not be read (${unreadable}), so ${TOOL_MODE_ENV} may be set in it ` +
        `and not applied. Fix the file's permissions; the server will not fall back to "full".`
    );
  }
  if ((raw === undefined || raw === "") && configText?.includes(TOOL_MODE_ENV)) {
    throw new Error(
      `The config file mentions ${TOOL_MODE_ENV} but it was not applied (invalid JSON, a nested ` +
        `block, or a non-string value). Fix the file; the server will not fall back to "full".`
    );
  }
  return parseToolMode(raw);
}

/** True when `name` may be offered under `mode`. */
export function isToolAllowed(name: string, mode: ToolMode): boolean {
  if (mode === "full") return true;
  if (mode === "read_only") return READ_ONLY_TOOLS.has(name);
  return !SENDING_TOOLS.has(name);
}

/** Mark sending and deleting tools destructive and read-only tools read-only. */
export function withSafetyAnnotations(
  name: string,
  annotations: ToolAnnotations | undefined
): ToolAnnotations | undefined {
  if (DESTRUCTIVE_TOOLS.has(name)) return { ...annotations, destructiveHint: true };
  if (READ_ONLY_TOOLS.has(name)) return { ...annotations, readOnlyHint: true };
  return annotations;
}
