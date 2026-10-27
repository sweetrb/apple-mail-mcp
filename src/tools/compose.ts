/** Reply/forward routing, kept separate from server startup for regression tests. */
import { decodeImapId, type ImapMessageSource } from "@/services/imapClient.js";
import type { AppleMailManager } from "@/services/appleMailManager.js";
import type { SmtpConfig, SmtpSendOptions, SmtpSendResult } from "@/services/smtpMailer.js";
import {
  buildReplyOptions,
  buildForwardOptions,
  buildReplyBody,
  buildForwardBody,
  parseOriginalHeaders,
  type OriginalHeaders,
} from "@/services/replyForward.js";
import { extractTextBody } from "@/utils/mimeParse.js";
import { preflightAttachments } from "@/utils/attachmentMaterialize.js";
import type { AttachmentInput } from "@/types.js";
import { successResponse, errorResponse, type ToolResponse } from "@/tools/respond.js";

export interface ComposeDeps {
  mail: Pick<
    AppleMailManager,
    "getRawSource" | "getMessageContent" | "replyToMessage" | "forwardMessage"
  > &
    // Optional so test doubles needn't stub it; the real manager always has it.
    Partial<Pick<AppleMailManager, "consumeLastMessageLookupError">>;
  imapSource: (id: string) => Promise<ImapMessageSource>;
  numericId: (id: string) => Promise<{ numericId?: string; error?: string }>;
  smtpConfigured: () => boolean;
  smtpConfig: () => SmtpConfig;
  smtpSend: (opts: SmtpSendOptions, config: SmtpConfig) => Promise<SmtpSendResult>;
}

export interface ReplyArgs {
  id: string;
  body: string;
  replyAll: boolean;
  send: boolean;
  transport?: "smtp" | "applescript";
  composition?: "native-editor";
  /** Files to attach (#267) — same schema, limits and read roots as send-email. */
  attachments?: AttachmentInput[];
}

export interface ForwardArgs {
  id: string;
  to: string[];
  body?: string;
  send: boolean;
  transport?: "smtp" | "applescript";
  composition?: "native-editor";
  /** Files to attach (#267) — same schema, limits and read roots as send-email. */
  attachments?: AttachmentInput[];
}

type ComposeArgs = (ReplyArgs & { kind: "reply" }) | (ForwardArgs & { kind: "forward" });

/** Read composite IDs over IMAP; never pass them to a numeric AppleScript lookup. */
async function readOriginal(
  deps: ComposeDeps,
  id: string,
  cfg?: SmtpConfig,
  recoverReplyText = false
) {
  if (decodeImapId(id)) {
    const source = await deps.imapSource(id);
    // SMTP is a single configured identity. Do not activate the newly working
    // IMAP route by silently sending another account's mail from that identity.
    const identities =
      cfg && [cfg.user, cfg.from, ...(cfg.allowedFrom ?? [])].map((s) => s.trim().toLowerCase());
    if (identities && !identities.includes(source.accountUser.trim().toLowerCase())) {
      throw new Error(
        "The source IMAP account does not match the configured SMTP identity. Configure SMTP for that account or explicitly select transport=applescript."
      );
    }
    const original = parseOriginalHeaders(source.raw);
    // The IMAP envelope supplies the decoded subject, unlike the raw MIME header.
    if (source.subject !== undefined) original.subject = source.subject;
    return { original, plainText: extractTextBody(source.raw) };
  }
  const raw = deps.mail.getRawSource(id);
  if (!raw) {
    // Say WHY when the lookup knows (#270): a bounded scan that skipped a large
    // mailbox, an ambiguous id, a timeout — each has its own remedy.
    const why = deps.mail.consumeLastMessageLookupError?.();
    throw new Error(
      `Cannot read the original message source${why ? ` (${why})` : ""}. Re-list the intended mailbox and retry with its message id.`
    );
  }
  const content = deps.mail.getMessageContent(id);
  return {
    original: parseOriginalHeaders(raw),
    plainText: content?.plainText ?? (recoverReplyText ? extractTextBody(raw) : null),
  };
}

function requireReplyText(plainText: string | null): string {
  if (plainText === null)
    throw new Error(
      "The original message has no readable plain-text body. Reply composition was stopped to avoid omitting its quoted content. Open the original in Mail.app and reply there."
    );
  return plainText;
}

/**
 * Fetch the original message's headers + plain text for the existing
 * AppleScript forward path — same sources as {@link readOriginal}, but
 * without the SMTP-identity check: nothing is being sent from an identity
 * here, the quote is just content inside a message Mail.app itself submits.
 * Returns null when the source can't be read, so the caller falls back to
 * the un-quoted body rather than failing an operation that used to succeed.
 */
async function readOriginalForForward(
  deps: ComposeDeps,
  id: string
): Promise<{ original: OriginalHeaders; plainText: string } | null> {
  if (decodeImapId(id)) {
    try {
      const source = await deps.imapSource(id);
      const original = parseOriginalHeaders(source.raw);
      if (source.subject !== undefined) original.subject = source.subject;
      return { original, plainText: extractTextBody(source.raw) ?? "" };
    } catch {
      return null;
    }
  }
  const raw = deps.mail.getRawSource(id);
  if (!raw) return null;
  const content = deps.mail.getMessageContent(id);
  return { original: parseOriginalHeaders(raw), plainText: content?.plainText ?? "" };
}

/** Never replace Mail's reply content when the original quote cannot be read. */
async function replyComposeBody(deps: ComposeDeps, id: string, body: string): Promise<string> {
  const source = await readOriginal(deps, id, undefined, true);
  return buildReplyBody(body, source.original, requireReplyText(source.plainText));
}

/**
 * Forward body for the AppleScript path: only rebuilds content when a body
 * was passed to prepend — matching the pre-fix behavior of leaving Mail's own
 * forward content untouched when there's nothing of ours to merge into it —
 * or when attachments are added (#267): Mail anchors an attachment after the
 * last paragraph of the plain-text `content`, which AppleScript cannot read
 * back from Mail's own forward rendering, so the forward block is built here
 * exactly as it is when a body is given.
 */
async function forwardComposeBody(
  deps: ComposeDeps,
  id: string,
  body: string | undefined,
  hasAttachments = false
): Promise<string | undefined> {
  if (!body && !hasAttachments) return body;
  const source = await readOriginalForForward(deps, id);
  return source ? buildForwardBody(source.original, source.plainText, body) : body;
}

async function runCompose(deps: ComposeDeps, args: ComposeArgs): Promise<ToolResponse> {
  const { id, send, transport, attachments } = args;
  const verb = args.kind === "reply" ? "reply to" : "forward";
  const nativeEditor = args.composition === "native-editor";
  if (nativeEditor && transport === "smtp") {
    return errorResponse(
      "Native-editor composition uses Mail.app and cannot be combined with SMTP."
    );
  }
  if (!send && transport === "smtp") {
    return errorResponse(
      "SMTP cannot save a Mail.app draft. Omit transport or use transport=applescript with send=false."
    );
  }
  // #267: reject a bad attachment with send-email's own error text, before the
  // original is fetched or anything is composed — on either transport.
  try {
    preflightAttachments(attachments);
  } catch (error) {
    return errorResponse(
      `Failed to ${verb} message "${id}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const attachmentCount = attachments?.length ?? 0;
  const withFiles = attachmentCount ? ` with ${attachmentCount} attachment(s)` : "";
  const smtp =
    !nativeEditor &&
    send &&
    transport !== "applescript" &&
    (transport === "smtp" || deps.smtpConfigured());
  if (smtp) {
    try {
      const cfg = deps.smtpConfig();
      const { original, plainText } = await readOriginal(deps, id, cfg, args.kind === "reply");
      if (args.kind === "forward" && plainText === null)
        throw new Error(
          "The original message has no readable plain-text body. SMTP forwarding would omit its content; explicitly select transport=applescript to forward it with Mail.app."
        );
      if (args.kind === "reply") {
        requireReplyText(plainText);
        if (!original.messageId)
          throw new Error(
            "The original message has no Message-ID; a threaded SMTP reply cannot be constructed."
          );
        if (!original.replyTo.length && !original.from.length)
          throw new Error("The original message has no reply address.");
      }
      const opts =
        args.kind === "reply"
          ? buildReplyOptions({
              original,
              originalPlainText: plainText ?? "",
              body: args.body,
              replyAll: args.replyAll,
              self: [cfg.from, cfg.user, ...(cfg.allowedFrom ?? [])],
              from: cfg.from,
            })
          : buildForwardOptions({
              original,
              originalPlainText: plainText ?? "",
              to: args.to,
              body: args.body,
              from: cfg.from,
            });
      // Same attachment path as send-email: sendViaSmtp's builder, so the wire
      // message and the Sent-folder copy both carry the files (#267).
      if (attachmentCount) opts.attachments = attachments;
      const result = await deps.smtpSend(opts, cfg);
      if (!result.success)
        return errorResponse(
          `Failed to ${verb} message "${id}" via SMTP: ${result.error ?? "unknown SMTP error"}`
        );
      return successResponse(
        args.kind === "reply"
          ? `Reply sent via SMTP${withFiles}`
          : `Message forwarded via SMTP to ${args.to.join(", ")}${withFiles}`,
        {
          ok: true,
          sent: true,
          id,
          transport: "smtp",
          messageId: result.messageId,
          attachmentCount,
          ...(args.kind === "forward" ? { recipients: args.to } : {}),
          // Best-effort Sent-folder copy (issue #220) — same field shape as
          // send-email, since it's the same sendViaSmtp underneath.
          ...(result.sentCopy !== undefined ? { sentCopy: result.sentCopy } : {}),
          ...(result.sentCopyError !== undefined ? { sentCopyError: result.sentCopyError } : {}),
          ...(result.sentCopyAlreadyFiled ? { sentCopyAlreadyFiled: true } : {}),
        }
      );
    } catch (error) {
      // Once SMTP is selected, failures must not change the sender/format or
      // risk a second delivery through a different transport.
      return errorResponse(
        `Failed to ${verb} message "${id}" via SMTP: ${error instanceof Error ? error.message : String(error)} No AppleScript fallback was attempted.`
      );
    }
  }

  try {
    const resolved = await deps.numericId(id);
    if (!resolved.numericId)
      return errorResponse(
        `Failed to ${verb} message "${id}": ${resolved.error ?? "message not found"}`
      );
    // Mail retains the original HTML and reply headers in native-editor mode.
    // Read the source first, but never replace its body with reconstructed text.
    if (nativeEditor) await readOriginal(deps, id, undefined, true);
    const outcome = nativeEditor
      ? args.kind === "reply"
        ? deps.mail.replyToMessage(
            resolved.numericId,
            args.body,
            args.replyAll,
            send,
            attachments,
            true
          )
        : deps.mail.forwardMessage(resolved.numericId, args.to, args.body, send, attachments, true)
      : args.kind === "reply"
        ? deps.mail.replyToMessage(
            resolved.numericId,
            await replyComposeBody(deps, id, args.body),
            args.replyAll,
            send,
            attachmentCount ? attachments : undefined
          )
        : deps.mail.forwardMessage(
            resolved.numericId,
            args.to,
            await forwardComposeBody(deps, id, args.body, attachmentCount > 0),
            send,
            attachmentCount ? attachments : undefined
          );
    if (!outcome.success)
      return errorResponse(
        `Failed to ${verb} message "${id}": ${outcome.error ?? "Mail.app compose failed"}`
      );
    const text =
      (args.kind === "reply"
        ? send
          ? "Reply sent via AppleScript"
          : "Reply saved as draft"
        : send
          ? `Message forwarded to ${args.to.join(", ")}`
          : "Forward saved as draft") + withFiles;
    return successResponse(text, {
      ok: true,
      sent: send,
      id,
      transport: "applescript",
      attachmentCount,
      ...(args.kind === "forward" ? { recipients: args.to } : {}),
    });
  } catch (error) {
    return errorResponse(
      `Failed to ${verb} message "${id}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function runReply(deps: ComposeDeps, args: ReplyArgs): Promise<ToolResponse> {
  return runCompose(deps, { ...args, kind: "reply" });
}

export function runForward(deps: ComposeDeps, args: ForwardArgs): Promise<ToolResponse> {
  return runCompose(deps, { ...args, kind: "forward" });
}
