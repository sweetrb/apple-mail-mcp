/** Reply/forward routing, kept separate from server startup for regression tests. */
import { decodeImapId, type ImapMessageSource } from "@/services/imapClient.js";
import type { AppleMailManager } from "@/services/appleMailManager.js";
import {
  smtpDeliveryFields,
  smtpDeliveryNotice,
  unknownSmtpResult,
  type SmtpConfig,
  type SmtpSendOptions,
  type SmtpSendResult,
} from "@/services/smtpMailer.js";
import {
  buildReplyOptions,
  buildForwardOptions,
  buildReplyBody,
  buildForwardBody,
  parseOriginalHeaders,
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
    Partial<
      Pick<
        AppleMailManager,
        "consumeLastMessageLookupError" | "listAccountsChecked" | "getRawSourceWithLocation"
      >
    >;
  imapSource: (id: string) => Promise<ImapMessageSource>;
  numericId: (id: string) => Promise<{ numericId?: string; error?: string }>;
  smtpConfigured: () => boolean;
  smtpConfig: () => SmtpConfig;
  smtpSend: (opts: SmtpSendOptions, config: SmtpConfig) => Promise<SmtpSendResult>;
}

export interface ReplyArgs {
  id: string;
  account?: string;
  mailbox?: string;
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
  account?: string;
  mailbox?: string;
  to: string[];
  body?: string;
  send: boolean;
  transport?: "smtp" | "applescript";
  composition?: "native-editor";
  /** Files to attach (#267) — same schema, limits and read roots as send-email. */
  attachments?: AttachmentInput[];
}

type ComposeArgs = (ReplyArgs & { kind: "reply" }) | (ForwardArgs & { kind: "forward" });
type SourceScope = { account: string; mailbox: string };

/** Read composite IDs over IMAP; never pass them to a numeric AppleScript lookup. */
async function readOriginal(deps: ComposeDeps, id: string, cfg?: SmtpConfig, scope?: SourceScope) {
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
  let sourceScope = scope;
  let raw: string | null;
  if (cfg && !sourceScope) {
    // A numeric id does not carry its account. Read source + location together
    // through the strict resolver, then apply the same actual-From check as an
    // explicit scope. Never infer ownership from To/From headers or pick the
    // first metadata hit before the ambiguity check has run.
    const source = deps.mail.getRawSourceWithLocation?.(id);
    if (!source) {
      const why = deps.mail.consumeLastMessageLookupError?.();
      throw new Error(
        `Cannot read the original message source${why ? ` (${why})` : ""}. Its account and mailbox must be verified before SMTP composition. Re-list the intended mailbox or supply its account and mailbox.`
      );
    }
    sourceScope = { account: source.account, mailbox: source.mailbox };
    requireScopedSmtpIdentity(deps, sourceScope, cfg);
    raw = source.raw;
  } else {
    raw = sourceScope
      ? deps.mail.getRawSource(id, sourceScope, { requireScopedLocation: true })
      : deps.mail.getRawSource(id);
  }
  if (!raw) {
    // Say WHY when the lookup knows (#270): a bounded scan that skipped a large
    // mailbox, an ambiguous id, a timeout — each has its own remedy.
    const why = deps.mail.consumeLastMessageLookupError?.();
    throw new Error(
      `Cannot read the original message source${why ? ` (${why})` : ""}. Re-list the intended mailbox and retry with its message id.`
    );
  }
  const content = sourceScope
    ? deps.mail.getMessageContent(id, false, sourceScope, { requireScopedLocation: true })
    : deps.mail.getMessageContent(id);
  const original = parseOriginalHeaders(raw);
  if (sourceScope) {
    // The source and Mail's plain-text property are read separately. If the
    // numeric id was reused between reads, never combine different messages.
    const sourceId = original.messageId?.trim().replace(/^<|>$/g, "");
    const contentId = content?.rfcMessageId?.trim().replace(/^<|>$/g, "");
    const sameMessage = !!sourceId && sourceId === contentId;
    return {
      original,
      plainText:
        sameMessage && content?.plainText?.trim() ? content.plainText : extractTextBody(raw),
    };
  }
  return {
    original,
    // A blank native property can mean an undownloaded/unconverted HTML body.
    // Let actual MIME establish either readable text or a genuinely empty part.
    plainText: content?.plainText?.trim() ? content.plainText : extractTextBody(raw),
  };
}

function requireReplyText(plainText: string | null): string {
  if (plainText === null)
    throw new Error(
      "The original message has no readable plain-text body. Reply composition was stopped to avoid omitting its quoted content. Open the original in Mail.app and reply there."
    );
  return plainText;
}

function requireForwardText(plainText: string | null): string {
  if (plainText === null)
    throw new Error(
      "The original message has no readable plain-text body. Forward composition was stopped to avoid omitting its content."
    );
  return plainText;
}

/** Never replace Mail's reply content when the original quote cannot be read. */
async function replyComposeBody(deps: ComposeDeps, id: string, body: string): Promise<string> {
  const source = await readOriginal(deps, id);
  return buildReplyBody(body, source.original, requireReplyText(source.plainText));
}

function requireScopedSmtpIdentity(deps: ComposeDeps, scope: SourceScope, cfg: SmtpConfig): void {
  const checked = deps.mail.listAccountsChecked?.();
  if (!checked || checked.failed) {
    throw new Error("Cannot verify the source Mail account against the SMTP identity.");
  }
  const accounts = checked.accounts.filter(
    (account) => account.name === scope.account && account.enabled
  );
  if (accounts.length !== 1) {
    throw new Error("The source Mail account is unavailable or ambiguous; no SMTP reply was sent.");
  }
  const addresses = new Set(accounts[0].addresses.map((address) => address.trim().toLowerCase()));
  // SMTP authentication usernames can be service logins (for example,
  // "apikey") rather than email addresses. The visible From must be bound to
  // the selected Mail account; the login is not a sender identity.
  if (!addresses.has(cfg.from.trim().toLowerCase())) {
    throw new Error("The source Mail account does not match the configured SMTP identity.");
  }
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
  const source = await readOriginal(deps, id);
  return buildForwardBody(source.original, requireForwardText(source.plainText), body);
}

async function runCompose(deps: ComposeDeps, args: ComposeArgs): Promise<ToolResponse> {
  const { id, send, transport, attachments } = args;
  const verb = args.kind === "reply" ? "reply to" : "forward";
  const nativeEditor = args.composition === "native-editor";
  const hasScope = args.account !== undefined || args.mailbox !== undefined;
  if (hasScope && (!args.account?.trim() || !args.mailbox?.trim())) {
    return errorResponse(
      "Source account and mailbox must be supplied together and cannot be empty."
    );
  }
  if (hasScope && id.startsWith("imap:")) {
    return errorResponse(
      "IMAP ids already encode their account and mailbox; omit account and mailbox."
    );
  }
  const scope = hasScope ? { account: args.account!, mailbox: args.mailbox! } : undefined;
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
  // Validate explicit numeric-id scope before any compose, including a forward
  // with no prepended body. Reuse the same original for every transport.
  let scopedOriginal: Awaited<ReturnType<typeof readOriginal>> | undefined;
  if (scope) {
    try {
      scopedOriginal = await readOriginal(deps, id, undefined, scope);
    } catch (error) {
      return errorResponse(
        `Failed to ${verb} message "${id}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  let mutationScope: (SourceScope & { messageId: string }) | undefined;
  if (scope && !smtp) {
    // Numeric Mail ids can be reused. Pin the source's RFC Message-ID too so
    // the compose script refuses if a different message takes that id between
    // the scoped read and the native/AppleScript reply or forward.
    const idMatch = scopedOriginal?.original.messageId?.match(/^<([^<>\s]+)>$|^([^<>\s]+)$/);
    const messageId = idMatch?.[1] ?? idMatch?.[2];
    if (!messageId) {
      return errorResponse(
        "The source has no usable Message-ID; cannot safely pin a scoped reply or forward."
      );
    }
    mutationScope = { ...scope, messageId };
  }
  if (smtp) {
    try {
      const cfg = deps.smtpConfig();
      if (scope) requireScopedSmtpIdentity(deps, scope, cfg);
      const { original, plainText } = scopedOriginal ?? (await readOriginal(deps, id, cfg));
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
      const result = await Promise.resolve()
        .then(() => deps.smtpSend(opts, cfg))
        .catch(unknownSmtpResult);
      if (result.deliveryUnknown) {
        return successResponse(smtpDeliveryNotice(result), {
          ok: false,
          id,
          transport: "smtp",
          ...smtpDeliveryFields(result),
        });
      }
      if (!result.success)
        return errorResponse(
          `Failed to ${verb} message "${id}" via SMTP: ${result.error ?? "unknown SMTP error"}`,
          { ok: false, sent: false, transport: "smtp", ...smtpDeliveryFields(result) }
        );
      return successResponse(
        result.partial
          ? smtpDeliveryNotice(result)
          : args.kind === "reply"
            ? `Reply sent via SMTP${withFiles}`
            : `Message forwarded via SMTP to ${args.to.join(", ")}${withFiles}`,
        {
          ok: !result.partial,
          sent: true,
          id,
          transport: "smtp",
          messageId: result.messageId,
          attachmentCount,
          ...smtpDeliveryFields(result),
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
    if (scope && resolved.numericId !== id) {
      return errorResponse(
        `Failed to ${verb} message "${id}": the numeric message id changed during resolution.`
      );
    }
    // Mail retains the original HTML and reply headers in native-editor mode.
    // Read the source first, but never replace its body with reconstructed text.
    if (nativeEditor && !scopedOriginal) await readOriginal(deps, id);
    let outcome: { success: boolean; error?: string };
    if (nativeEditor && args.kind === "reply") {
      outcome = mutationScope
        ? deps.mail.replyToMessage(
            resolved.numericId,
            args.body,
            args.replyAll,
            send,
            attachments,
            true,
            mutationScope
          )
        : deps.mail.replyToMessage(
            resolved.numericId,
            args.body,
            args.replyAll,
            send,
            attachments,
            true
          );
    } else if (nativeEditor && args.kind === "forward") {
      outcome = mutationScope
        ? deps.mail.forwardMessage(
            resolved.numericId,
            args.to,
            args.body,
            send,
            attachments,
            true,
            mutationScope
          )
        : deps.mail.forwardMessage(resolved.numericId, args.to, args.body, send, attachments, true);
    } else if (args.kind === "reply") {
      const body = scopedOriginal
        ? buildReplyBody(
            args.body,
            scopedOriginal.original,
            requireReplyText(scopedOriginal.plainText)
          )
        : await replyComposeBody(deps, id, args.body);
      const files = attachmentCount ? attachments : undefined;
      outcome = mutationScope
        ? deps.mail.replyToMessage(
            resolved.numericId,
            body,
            args.replyAll,
            send,
            files,
            false,
            mutationScope
          )
        : deps.mail.replyToMessage(resolved.numericId, body, args.replyAll, send, files);
    } else {
      const body =
        scopedOriginal && (args.body || attachmentCount)
          ? buildForwardBody(
              scopedOriginal.original,
              requireForwardText(scopedOriginal.plainText),
              args.body
            )
          : await forwardComposeBody(deps, id, args.body, attachmentCount > 0);
      const files = attachmentCount ? attachments : undefined;
      outcome = mutationScope
        ? deps.mail.forwardMessage(
            resolved.numericId,
            args.to,
            body,
            send,
            files,
            false,
            mutationScope
          )
        : deps.mail.forwardMessage(resolved.numericId, args.to, body, send, files);
    }
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
