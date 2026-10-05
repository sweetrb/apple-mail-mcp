/**
 * Caller-supplied threading headers (`inReplyTo` / `references`) on send-email
 * and create-draft (#267).
 *
 * Mail.app's AppleScript `outgoing message` exposes no header property, so the
 * AppleScript transport can never emit these headers. Rather than silently
 * dropping them (the message would leave unthreaded while the call reports
 * success), every transport that cannot honor them refuses the call:
 *
 * - send-email: threading requires the SMTP transport.
 * - create-draft: the draft is composed here (same nodemailer builder as the
 *   SMTP send) and filed over IMAP into the account's Drafts mailbox, flagged
 *   `\Draft`; without a usable IMAP account the call is refused.
 *
 * @module tools/threading
 */
import type { AttachmentInput } from "@/types.js";
import type { SmtpSendOptions } from "@/services/smtpMailer.js";
import type { DraftAppendResult } from "@/services/imapClient.js";
import { preflightAttachments } from "@/utils/attachmentMaterialize.js";
import { successResponse, errorResponse, type ToolResponse } from "@/tools/respond.js";

export interface ThreadingArgs {
  inReplyTo?: string;
  references?: string[];
}

/**
 * Normalize caller threading input, or `undefined` when none was given. When
 * only `inReplyTo` is supplied, `References` defaults to `[inReplyTo]` — RFC
 * 5322 §3.6.4's rule for a parent that carries no References of its own.
 */
export function threadingHeaders(
  args: ThreadingArgs
): { inReplyTo?: string; references?: string[] } | undefined {
  const inReplyTo = args.inReplyTo?.trim() || undefined;
  const references = args.references?.length ? args.references : undefined;
  if (!inReplyTo && !references) return undefined;
  return { inReplyTo, references: references ?? (inReplyTo ? [inReplyTo] : undefined) };
}

/** Refusal text for send-email when threading was requested but SMTP is not the transport. */
export const SEND_THREADING_NEEDS_SMTP =
  "inReplyTo/references require the SMTP transport: Mail.app's AppleScript cannot set " +
  "In-Reply-To or References, so the message would go out unthreaded. Configure SMTP " +
  "(and do not pass transport=applescript or a Mail.app account label), or use " +
  "reply-to-message, which threads on both transports.";

/**
 * send-email's threading gate: the normalized headers to pass to the SMTP
 * send, or the refusal when threading was requested on a transport that would
 * drop it. `useSmtp` is the already-made transport decision (shouldUseSmtp).
 */
export function sendEmailThreading(
  args: ThreadingArgs,
  useSmtp: boolean
):
  | { ok: true; headers?: { inReplyTo?: string; references?: string[] } }
  | { ok: false; error: string } {
  const headers = threadingHeaders(args);
  if (headers && !useSmtp) return { ok: false, error: SEND_THREADING_NEEDS_SMTP };
  return { ok: true, headers };
}

export interface ThreadedDraftDeps {
  /** Pick the IMAP account (label + login) the draft is filed under; throws when it can't. */
  resolveAccount: (
    account: string | undefined,
    smtpUser: string | undefined
  ) => { label: string; user: string };
  /** SMTP identity from config, without touching the Keychain. */
  smtpIdentity: () => { user?: string; from?: string };
  compose: (opts: SmtpSendOptions, from: string) => Promise<Buffer>;
  append: (account: string, raw: Buffer) => Promise<DraftAppendResult>;
}

export interface ThreadedDraftArgs extends ThreadingArgs {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  account?: string;
  attachments?: AttachmentInput[];
}

/** Message-ID of a composed raw message, for the caller to reference later. */
function messageIdOf(raw: Buffer): string | undefined {
  const head = raw.toString("utf8").split(/\r?\n\r?\n/)[0] ?? "";
  return head.replace(/\r?\n[ \t]+/g, " ").match(/^Message-ID:\s*(<[^>\s]+>)/im)?.[1];
}

/**
 * create-draft with threading headers: compose with the SMTP builder and file
 * the result into the account's Drafts mailbox over IMAP.
 */
export async function runThreadedDraft(
  deps: ThreadedDraftDeps,
  args: ThreadedDraftArgs
): Promise<ToolResponse> {
  const threading = threadingHeaders(args);
  if (!threading) throw new Error("runThreadedDraft called without threading headers");
  const fail = (e: unknown) =>
    errorResponse(
      `Failed to create threaded draft: ${e instanceof Error ? e.message : String(e)} ` +
        "Nothing was filed; no Mail.app fallback was attempted (it would drop the threading headers)."
    );

  try {
    preflightAttachments(args.attachments);
    const smtp = deps.smtpIdentity();
    const acct = deps.resolveAccount(args.account, smtp.user);
    // Same identity convention as the Sent copy: when SMTP is this account,
    // its configured From (e.g. a domain alias) is the author.
    const from =
      smtp.user && smtp.user.toLowerCase() === acct.user.toLowerCase() && smtp.from
        ? smtp.from
        : acct.user;
    const raw = await deps.compose(
      {
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        body: args.body,
        attachments: args.attachments,
        inReplyTo: threading.inReplyTo,
        references: threading.references,
      },
      from
    );
    const filed = await deps.append(acct.label, raw);
    const attachmentCount = args.attachments?.length ?? 0;
    const attachInfo = attachmentCount ? ` with ${attachmentCount} attachment(s)` : "";
    const messageId = messageIdOf(raw);
    return successResponse(
      `Threaded draft for ${args.to.join(", ")}${attachInfo} filed over IMAP in ` +
        `"${filed.mailbox}" (account ${filed.account}). Review and send it from Mail.app.`,
      {
        ok: true,
        recipients: args.to,
        attachmentCount,
        transport: "imap",
        account: filed.account,
        mailbox: filed.mailbox,
        ...(messageId ? { messageId } : {}),
        ...(threading.inReplyTo ? { inReplyTo: threading.inReplyTo } : {}),
        references: threading.references,
      }
    );
  } catch (e) {
    return fail(e);
  }
}
