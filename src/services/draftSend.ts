import { createHash } from "node:crypto";
import addressparser from "nodemailer/lib/addressparser/index.js";
import {
  imapAppendSentCopy,
  imapTrashSavedDraft,
  imapGetMessageRfc822,
  MAX_RFC822_FILE_BYTES,
  type ImapRfc822Acquisition,
} from "@/services/imapClient.js";
import {
  resolveSmtpConfig,
  resolveSmtpFrom,
  submitRawViaSmtp,
  unknownSmtpResult,
  smtpDeliveryFields,
  type SmtpConfig,
  type SmtpSendResult,
} from "@/services/smtpMailer.js";
import { previewSavedDraftMime } from "@/services/savedDraftMime.js";
import { decodeHeaderBytes, parseHeaderBlock } from "@/utils/headers.js";
import type {
  SendSavedDraftInput,
  SendSavedDraftPreview,
  SendSavedDraftSubmission,
  SendSavedDraftResult,
  SavedDraftCleanupResult,
} from "@/types.js";

export type { SendSavedDraftInput as SavedDraftInput } from "@/types.js";

type Revision = { sha256: string; uidValidity: string };
type Attempts = Map<string, SendSavedDraftSubmission | null>;
const attemptedRevisions: Attempts = new Map();

export interface SavedDraftDeps {
  fetch?: (id: string) => ReturnType<typeof imapGetMessageRfc822>;
  smtpConfig?: (from: string) => SmtpConfig;
  submit?: (
    raw: Buffer,
    envelope: { from: string; to: string[] },
    config: SmtpConfig
  ) => Promise<SmtpSendResult>;
  appendSent?: (
    smtpUser: string,
    raw: Buffer,
    smtpHost: string
  ) => ReturnType<typeof imapAppendSentCopy>;
  removeDraft?: (id: string, approved: Revision) => Promise<SavedDraftCleanupResult>;
  /** Isolated test history. Production remembers attempted revisions for this process. */
  attempts?: Attempts;
}

const fetchDraft = (id: string) =>
  imapGetMessageRfc822(id, { maxBytes: MAX_RFC822_FILE_BYTES, requireDraftMailbox: true });

function addressFields(
  headers: ReturnType<typeof parseHeaderBlock>["headers"],
  name: string
): string[] {
  const values = headers.filter((field) => field.name.toLowerCase() === name);
  const addresses = values.flatMap((field) =>
    addressparser(field.value, { flatten: true }).map((item) => item.address)
  );
  if (addresses.some((address) => !/^[^\s@<>]+@[^\s@<>]+$/.test(address)))
    throw new Error("Draft has an invalid " + name + " address; no send performed.");
  return addresses;
}

/** Remove only recipient-hidden/draft metadata; keep body bytes and other headers. */
function cleanDraftHeaders(raw: Buffer, keepBcc: boolean): Buffer {
  const source = raw.toString("latin1");
  const match = /\r?\n\r?\n/.exec(source);
  if (!match) throw new Error("Draft has no MIME header/body boundary.");
  const separator = match[0];
  const lines = source.slice(0, match.index).split(/\r?\n/);
  const kept: string[] = [];
  let omit = false;
  for (const line of lines) {
    if (!/^[ \t]/.test(line)) {
      const name = line.slice(0, line.indexOf(":")).toLowerCase();
      omit =
        (!keepBcc && name === "bcc") ||
        [
          "x-unsent",
          "x-apple-mail-draft",
          "x-uniform-type-identifier",
          "x-universally-unique-identifier",
        ].includes(name);
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

const normalized = (addresses: string[]) =>
  [...new Set(addresses.map((x) => x.toLowerCase()))].sort().join("\0");

function prepare(acquisition: ImapRfc822Acquisition, draftId: string) {
  if (
    !/^[1-9]\d*$/.test(acquisition.uidValidity ?? "") ||
    !acquisition.flags.includes("\\Draft") ||
    acquisition.flags.includes("\\Deleted")
  )
    throw new Error("A current active draft with UIDVALIDITY is required; no send performed.");
  const sha256 = createHash("sha256").update(acquisition.bytes).digest("hex");
  if (
    sha256 !== acquisition.sha256 ||
    acquisition.bytes.length > MAX_RFC822_FILE_BYTES ||
    (acquisition.size !== undefined &&
      Math.abs(acquisition.size - acquisition.bytes.length) > 1024 + acquisition.size * 0.02)
  )
    throw new Error("Draft MIME acquisition is incomplete or inconsistent; no send performed.");
  const content = previewSavedDraftMime(acquisition.bytes);
  const parsed = parseHeaderBlock(decodeHeaderBytes(acquisition.bytes));
  const sender = addressFields(parsed.headers, "sender");
  if (
    sender.length &&
    (sender.length !== 1 || sender[0].toLowerCase() !== content.from.toLowerCase())
  )
    throw new Error("A different Sender identity cannot be approved by this version.");
  const messageIds = parsed.headers.filter((field) => field.name.toLowerCase() === "message-id");
  if (messageIds.length !== 1 || !/^<[^<>\s]+@[^<>\s]+>$/.test(messageIds[0].value.trim()))
    throw new Error("Stored draft needs an unambiguous Message-ID; no send performed.");
  const envelope = acquisition.envelopeRecipients;
  if (!envelope)
    throw new Error("IMAP did not report draft envelope recipients; no send performed.");
  if (
    ["to", "cc", "bcc"].some((field) => {
      const name = field as "to" | "cc" | "bcc";
      return normalized(content[name]) !== normalized(envelope[name]);
    })
  )
    throw new Error("Draft MIME recipients differ from the IMAP envelope; no send performed.");
  if (!content.to.length && !content.cc.length && !content.bcc.length)
    throw new Error("Draft needs at least one recipient; no send performed.");
  const preview: SendSavedDraftPreview = {
    ...content,
    status: "preview",
    draftId,
    uid: acquisition.uid,
    sha256,
    uidValidity: acquisition.uidValidity!,
    replyTo: addressFields(parsed.headers, "reply-to"),
  };
  return {
    preview,
    // nodemailer's info.messageId for a raw send is its own generated id, never on the
    // wire; the stored header is what recipients and the Sent copy actually carry.
    messageId: messageIds[0].value.trim(),
    wire: cleanDraftHeaders(acquisition.bytes, false),
    sentCopy: cleanDraftHeaders(acquisition.bytes, true),
  };
}

/** One explicit, revision-approved SMTP submission. Never retry or switch transport.
 * Process-local history prevents concurrent/repeated calls for an attempted revision.
 * After server restart, reconcile with the provider before retrying an uncertain send.
 */
export async function sendSavedDraft(
  input: SendSavedDraftInput,
  deps: SavedDraftDeps = {}
): Promise<SendSavedDraftResult> {
  if (!input.draftId.startsWith("imap:"))
    throw new Error('Use an imap: id from list-messages on Drafts (transport: "imap").');
  if (
    !input.dryRun &&
    (!/^[a-f0-9]{64}$/i.test(input.approvedSha256 ?? "") ||
      !/^[1-9]\d*$/.test(input.approvedUidValidity ?? ""))
  )
    throw new Error("A fresh preview sha256 and uidValidity are required before sending.");
  const attempts = deps.attempts ?? attemptedRevisions;
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        input.draftId,
        input.approvedUidValidity,
        input.approvedSha256?.toLowerCase(),
      ])
    )
    .digest("hex");
  const previous = input.dryRun ? undefined : attempts.get(key);
  if (previous === null)
    throw new Error("Submission for this revision is already in progress; do not resend.");
  if (previous) return { ...previous, alreadyAttempted: true };
  const fetched = await (deps.fetch ?? fetchDraft)(input.draftId);
  if (!fetched.success) throw new Error(fetched.error);
  const prepared = prepare(fetched.acquisition, input.draftId);
  if (input.dryRun) return prepared.preview;
  if (
    prepared.preview.sha256 !== input.approvedSha256?.toLowerCase() ||
    prepared.preview.uidValidity !== input.approvedUidValidity
  )
    throw new Error("Draft changed since the approved preview; review the current draft again.");
  const cfg = (deps.smtpConfig ?? ((from: string) => resolveSmtpConfig(process.env, from)))(
    prepared.preview.from
  );
  resolveSmtpFrom(prepared.preview.from, cfg);
  if (fetched.acquisition.accountUser?.toLowerCase() !== cfg.user.toLowerCase())
    throw new Error("Draft account or From address does not match the configured SMTP identity.");
  const envelope = {
    from: prepared.preview.from,
    to: [...new Set([...prepared.preview.to, ...prepared.preview.cc, ...prepared.preview.bcc])],
  };
  // Recheck after asynchronous acquisition: another call may have started submission.
  if (attempts.has(key))
    throw new Error(
      "This revision has already been attempted; inspect its submission before retrying."
    );
  if (attempts.size >= 10_000)
    throw new Error("Submission history limit reached; provider reconciliation is required.");
  attempts.set(key, null);
  let submitted: SmtpSendResult;
  try {
    submitted = await (deps.submit ?? submitRawViaSmtp)(prepared.wire, envelope, cfg);
  } catch (error) {
    submitted = unknownSmtpResult(error);
  }
  const partial =
    submitted.partial === true || (!!submitted.accepted?.length && !!submitted.rejected?.length);
  const full =
    submitted.success &&
    !submitted.deliveryUnknown &&
    !partial &&
    submitted.accepted !== undefined &&
    submitted.rejected?.length === 0 &&
    normalized(submitted.accepted) === normalized(envelope.to);
  const unknown = !!submitted.deliveryUnknown || (submitted.success && !full && !partial);
  const result: SendSavedDraftSubmission = {
    status: unknown
      ? "submission_unknown"
      : partial
        ? "partial"
        : full
          ? "submitted"
          : "not_submitted",
    success: submitted.success,
    messageId: prepared.messageId,
    ...smtpDeliveryFields(submitted),
    ...(partial ? { partial: true } : {}),
    ...(unknown ? { deliveryUnknown: true } : {}),
    error:
      submitted.error ??
      (unknown
        ? "SMTP acceptance for the entire approved recipient set is unconfirmed; do not resend automatically."
        : undefined),
    draftRemoved: false,
    draftCleanupStatus: "not_attempted",
  };
  // A known SMTP rejection is not an attempted delivery; a user can explicitly retry after fixing it.
  if (!submitted.success && !unknown && !partial) {
    attempts.delete(key);
    return result;
  }
  if (unknown) {
    attempts.set(key, result);
    return result;
  }
  try {
    const copy = await (
      deps.appendSent ?? ((user, raw, smtpHost) => imapAppendSentCopy(user, raw, {}, { smtpHost }))
    )(cfg.user, prepared.sentCopy, cfg.host);
    if (copy.attempted) {
      result.sentCopy = copy.success ?? false;
      if (!copy.success) result.sentCopyError = copy.error;
      if (copy.alreadyFiled) result.sentCopyAlreadyFiled = true;
    }
  } catch (error) {
    result.sentCopy = false;
    result.sentCopyError = error instanceof Error ? error.message : String(error);
  }
  if (full) {
    try {
      const removed = await (deps.removeDraft ?? imapTrashSavedDraft)(input.draftId, {
        sha256: prepared.preview.sha256,
        uidValidity: prepared.preview.uidValidity,
      });
      result.draftRemovalVerification = removed.verification;
      result.draftRemovalError = removed.error;
      result.draftRemoved =
        removed.removed === true && removed.verification?.verdict === "verified"
          ? true
          : removed.removed === false
            ? false
            : undefined;
      result.draftCleanupStatus =
        result.draftRemoved === true
          ? "verified"
          : removed.success
            ? "unverified"
            : removed.removed === false
              ? "failed"
              : "unknown";
    } catch (error) {
      result.draftRemoved = undefined;
      result.draftCleanupStatus = "unknown";
      result.draftRemovalError = error instanceof Error ? error.message : String(error);
    }
  }
  attempts.set(key, result);
  return result;
}
