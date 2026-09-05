/** Reply/forward routing, kept separate from server startup for regression tests. */
import { decodeImapId, type ImapMessageSource } from "@/services/imapClient.js";
import type { AppleMailManager } from "@/services/appleMailManager.js";
import type { SmtpConfig, SmtpSendOptions, SmtpSendResult } from "@/services/smtpMailer.js";
import {
  buildReplyOptions,
  buildForwardOptions,
  parseOriginalHeaders,
} from "@/services/replyForward.js";
import { extractTextBody } from "@/utils/mimeParse.js";
import { successResponse, errorResponse, type ToolResponse } from "@/tools/respond.js";

export interface ComposeDeps {
  mail: Pick<
    AppleMailManager,
    "getRawSource" | "getMessageContent" | "replyToMessage" | "forwardMessage"
  >;
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
}

export interface ForwardArgs {
  id: string;
  to: string[];
  body?: string;
  send: boolean;
  transport?: "smtp" | "applescript";
}

type ComposeArgs = (ReplyArgs & { kind: "reply" }) | (ForwardArgs & { kind: "forward" });

/** Read composite IDs over IMAP; never pass them to a numeric AppleScript lookup. */
async function readOriginal(deps: ComposeDeps, id: string, cfg: SmtpConfig) {
  if (decodeImapId(id)) {
    const source = await deps.imapSource(id);
    // SMTP is a single configured identity. Do not activate the newly working
    // IMAP route by silently sending another account's mail from that identity.
    const identities = [cfg.user, cfg.from, ...(cfg.allowedFrom ?? [])].map((s) =>
      s.trim().toLowerCase()
    );
    if (!identities.includes(source.accountUser.trim().toLowerCase())) {
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
  if (!raw)
    throw new Error(
      "Cannot read the original message source. Re-list the intended mailbox and retry with its message id."
    );
  const content = deps.mail.getMessageContent(id);
  return { original: parseOriginalHeaders(raw), plainText: content?.plainText ?? null };
}

async function runCompose(deps: ComposeDeps, args: ComposeArgs): Promise<ToolResponse> {
  const { id, send, transport } = args;
  const verb = args.kind === "reply" ? "reply to" : "forward";
  if (!send && transport === "smtp") {
    return errorResponse(
      "SMTP cannot save a Mail.app draft. Omit transport or use transport=applescript with send=false."
    );
  }
  const smtp =
    send && transport !== "applescript" && (transport === "smtp" || deps.smtpConfigured());
  if (smtp) {
    try {
      const cfg = deps.smtpConfig();
      const { original, plainText } = await readOriginal(deps, id, cfg);
      if (args.kind === "forward" && plainText === null)
        throw new Error(
          "The original message has no readable plain-text body. SMTP forwarding would omit its content; explicitly select transport=applescript to forward it with Mail.app."
        );
      if (args.kind === "reply") {
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
      const result = await deps.smtpSend(opts, cfg);
      if (!result.success)
        return errorResponse(
          `Failed to ${verb} message "${id}" via SMTP: ${result.error ?? "unknown SMTP error"}`
        );
      return successResponse(
        args.kind === "reply"
          ? "Reply sent via SMTP"
          : `Message forwarded via SMTP to ${args.to.join(", ")}`,
        {
          ok: true,
          sent: true,
          id,
          transport: "smtp",
          messageId: result.messageId,
          ...(args.kind === "forward" ? { recipients: args.to } : {}),
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

  const resolved = await deps.numericId(id);
  if (!resolved.numericId)
    return errorResponse(
      `Failed to ${verb} message "${id}": ${resolved.error ?? "message not found"}`
    );
  const outcome =
    args.kind === "reply"
      ? deps.mail.replyToMessage(resolved.numericId, args.body, args.replyAll, send)
      : deps.mail.forwardMessage(resolved.numericId, args.to, args.body, send);
  if (!outcome.success)
    return errorResponse(
      `Failed to ${verb} message "${id}": ${outcome.error ?? "Mail.app compose failed"}`
    );
  const text =
    args.kind === "reply"
      ? send
        ? "Reply sent via AppleScript"
        : "Reply saved as draft"
      : send
        ? `Message forwarded to ${args.to.join(", ")}`
        : "Forward saved as draft";
  return successResponse(text, {
    ok: true,
    sent: send,
    id,
    transport: "applescript",
    ...(args.kind === "forward" ? { recipients: args.to } : {}),
  });
}

export function runReply(deps: ComposeDeps, args: ReplyArgs): Promise<ToolResponse> {
  return runCompose(deps, { ...args, kind: "reply" });
}

export function runForward(deps: ComposeDeps, args: ForwardArgs): Promise<ToolResponse> {
  return runCompose(deps, { ...args, kind: "forward" });
}
