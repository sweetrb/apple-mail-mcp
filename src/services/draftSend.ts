import nodemailer from "nodemailer";
import addressparser from "nodemailer/lib/addressparser/index.js";
import {
  imapAppendSentCopy,
  imapDeleteMessageById,
  imapGetMessageRfc822,
  MAX_RFC822_FILE_BYTES,
  type ImapRfc822Acquisition,
} from "@/services/imapClient.js";
import { resolveSmtpConfig, type SmtpConfig } from "@/services/smtpMailer.js";
import { parseHeaderBlock } from "@/utils/headers.js";
import { extractHtmlBody, extractTextBody, parseMimeAttachments } from "@/utils/mimeParse.js";

export interface SavedDraftInput {
  draftId: string;
  dryRun: boolean;
  /** Values returned by a fresh preview. Required before any send. */
  approvedSha256?: string;
  approvedUidValidity?: string;
}

export interface SavedDraftPreview {
  status: "preview";
  draftId: string;
  sha256: string;
  uidValidity: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  body: string;
  isHtml: boolean;
  htmlBody?: string;
  attachments: { name: string; mimeType: string; size: number }[];
}

export interface SavedDraftSubmission {
  status: "submitted";
  messageId?: string;
  sentCopy?: boolean;
  sentCopyError?: string;
  draftRemoved: boolean;
  draftRemovalError?: string;
}

type DraftAcquisition = Awaited<ReturnType<typeof imapGetMessageRfc822>>;
type SentCopy = Awaited<ReturnType<typeof imapAppendSentCopy>>;
type DeleteResult = Awaited<ReturnType<typeof imapDeleteMessageById>>;

export interface SavedDraftDeps {
  fetch?: (id: string) => Promise<DraftAcquisition>;
  smtpConfig?: () => SmtpConfig;
  submit?: (
    raw: Buffer,
    envelope: { from: string; to: string[] },
    config: SmtpConfig
  ) => Promise<{ messageId?: string }>;
  appendSent?: (smtpUser: string, raw: Buffer) => Promise<SentCopy>;
  removeDraft?: (id: string) => Promise<DeleteResult>;
}

const fetchDraft = (id: string): Promise<DraftAcquisition> =>
  imapGetMessageRfc822(id, { maxBytes: MAX_RFC822_FILE_BYTES, requireDraftMailbox: true });

function addressFields(
  headers: ReturnType<typeof parseHeaderBlock>["headers"],
  name: string
): string[] {
  const values = headers
    .filter((field) => field.name.toLowerCase() === name)
    .map((field) => field.value);
  const addresses = values.flatMap((value) =>
    addressparser(value, { flatten: true }).map((item) => item.address)
  );
  if (addresses.some((address) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) {
    throw new Error(`Draft has an invalid ${name} address; no send performed.`);
  }
  return addresses;
}

function cleanDraftHeaders(raw: Buffer, keepBcc: boolean): Buffer {
  const source = raw.toString("latin1");
  const match = /\r?\n\r?\n/.exec(source);
  if (!match || match.index === undefined)
    throw new Error("Draft has no MIME header/body boundary.");
  const separator = match[0];
  const lines = source.slice(0, match.index).split(/\r?\n/);
  const kept: string[] = [];
  let omit = false;
  for (const line of lines) {
    if (!/^[ \t]/.test(line)) {
      const name = line.slice(0, line.indexOf(":")).toLowerCase();
      omit =
        (!keepBcc && name === "bcc") ||
        name === "x-unsent" ||
        name.startsWith("x-apple-") ||
        name.startsWith("x-uniform-") ||
        name.startsWith("x-universally-");
    }
    if (!omit) kept.push(line);
  }
  return Buffer.from(
    kept.join(separator.startsWith("\r") ? "\r\n" : "\n") +
      separator +
      source.slice(match.index + separator.length),
    "latin1"
  );
}

function prepare(acquisition: ImapRfc822Acquisition, draftId: string) {
  if (!acquisition.uidValidity) {
    throw new Error("Draft mailbox did not report UIDVALIDITY; no send performed.");
  }
  const rawText = acquisition.bytes.toString("latin1");
  const parsed = parseHeaderBlock(rawText);
  if (parsed.headers.some((field) => field.name.toLowerCase().startsWith("resent-"))) {
    throw new Error("Draft contains Resent headers that are not shown in the preview.");
  }
  const from = addressFields(parsed.headers, "from");
  const to = addressFields(parsed.headers, "to");
  const cc = addressFields(parsed.headers, "cc");
  const bcc = addressFields(parsed.headers, "bcc");
  const replyTo = addressFields(parsed.headers, "reply-to");
  if (!acquisition.envelopeRecipients) {
    throw new Error("IMAP did not report draft envelope recipients; no send performed.");
  }
  const same = (left: string[], right: string[]) =>
    left
      .map((address) => address.toLowerCase())
      .sort()
      .join("\u0000") ===
    right
      .map((address) => address.toLowerCase())
      .sort()
      .join("\u0000");
  if (
    !same(to, acquisition.envelopeRecipients.to) ||
    !same(cc, acquisition.envelopeRecipients.cc) ||
    !same(bcc, acquisition.envelopeRecipients.bcc)
  ) {
    throw new Error("Draft MIME recipients differ from the IMAP envelope; no send performed.");
  }
  if (from.length !== 1 || to.length + cc.length + bcc.length === 0) {
    throw new Error("Draft needs exactly one From address and at least one recipient.");
  }
  const body = extractTextBody(rawText);
  const html = extractHtmlBody(rawText);
  if (body === null && html === null) {
    throw new Error("Draft body could not be shown for approval; no send performed.");
  }
  if ((body?.length ?? 0) > 100_000 || (html?.length ?? 0) > 100_000) {
    throw new Error("Draft body exceeds the Codex preview limit; no send performed.");
  }
  const preview: SavedDraftPreview = {
    status: "preview",
    draftId,
    sha256: acquisition.sha256,
    uidValidity: acquisition.uidValidity,
    from: from[0],
    to,
    cc,
    bcc,
    replyTo,
    subject: parsed.subject ?? "",
    body: body ?? html ?? "",
    isHtml: body === null,
    htmlBody: body !== null ? (html ?? undefined) : undefined,
    attachments: parseMimeAttachments(rawText),
  };
  return {
    preview,
    wire: cleanDraftHeaders(acquisition.bytes, false),
    sentCopy: cleanDraftHeaders(acquisition.bytes, true),
    accountUser: acquisition.accountUser,
  };
}

async function submitRaw(
  raw: Buffer,
  envelope: { from: string; to: string[] },
  config: SmtpConfig
): Promise<{ messageId?: string }> {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure && !config.allowPlaintext,
    auth: { user: config.user, pass: config.pass },
  });
  try {
    const result = await transporter.sendMail({ raw, envelope });
    return { messageId: result.messageId };
  } finally {
    transporter.close();
  }
}

/**
 * A preview exposes the current stored MIME in Codex. Sending rereads the
 * same IMAP UID and requires its byte hash and UIDVALIDITY to match that preview.
 * No fallback transport and no retry are attempted after an uncertain send.
 */
export async function sendSavedDraft(
  input: SavedDraftInput,
  deps: SavedDraftDeps = {}
): Promise<SavedDraftPreview | SavedDraftSubmission> {
  if (!input.draftId.startsWith("imap:")) {
    throw new Error('Use an imap: id from list-messages on Drafts (transport: "imap").');
  }
  if (
    !input.dryRun &&
    (!/^[a-f0-9]{64}$/i.test(input.approvedSha256 ?? "") || !input.approvedUidValidity)
  ) {
    throw new Error("A fresh preview sha256 and uidValidity are required before sending.");
  }
  const result = await (deps.fetch ?? fetchDraft)(input.draftId);
  if (!result.success) throw new Error(result.error);
  const prepared = prepare(result.acquisition, input.draftId);
  if (input.dryRun) return prepared.preview;
  if (
    prepared.preview.sha256 !== input.approvedSha256 ||
    prepared.preview.uidValidity !== input.approvedUidValidity
  ) {
    throw new Error("Draft changed since the Codex preview; review the current draft again.");
  }

  const cfg = (deps.smtpConfig ?? resolveSmtpConfig)();
  const allowed = new Set(
    [cfg.user, cfg.from, ...(cfg.allowedFrom ?? [])].map((address) => address.toLowerCase())
  );
  if (
    result.acquisition.accountUser.toLowerCase() !== cfg.user.toLowerCase() ||
    !allowed.has(prepared.preview.from.toLowerCase())
  ) {
    throw new Error("Draft account or From address does not match the configured SMTP identity.");
  }
  const envelope = {
    from: prepared.preview.from,
    to: [...prepared.preview.to, ...prepared.preview.cc, ...prepared.preview.bcc],
  };
  const submitted = await (deps.submit ?? submitRaw)(prepared.wire, envelope, cfg);
  let sentCopy: boolean | undefined;
  let sentCopyError: string | undefined;
  try {
    const copy = await (deps.appendSent ?? imapAppendSentCopy)(cfg.user, prepared.sentCopy);
    if (copy.attempted) {
      sentCopy = copy.success ?? false;
      if (!copy.success) sentCopyError = copy.error;
    }
  } catch (error) {
    sentCopy = false;
    sentCopyError = error instanceof Error ? error.message : String(error);
  }
  try {
    const removed = await (deps.removeDraft ?? imapDeleteMessageById)(input.draftId);
    return {
      status: "submitted",
      messageId: submitted.messageId,
      sentCopy,
      sentCopyError,
      draftRemoved: removed.success,
      draftRemovalError: removed.success ? undefined : removed.error,
    };
  } catch (error) {
    return {
      status: "submitted",
      messageId: submitted.messageId,
      sentCopy,
      sentCopyError,
      draftRemoved: false,
      draftRemovalError: error instanceof Error ? error.message : String(error),
    };
  }
}
