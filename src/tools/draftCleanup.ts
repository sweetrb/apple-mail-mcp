/**
 * Draft clean-up after `send-email` with `draftId`.
 *
 * The rules are pure: the caller passes what the mail backend reported, so the
 * decision can be tested without Mail.app. A draft is deleted only when it is
 * still a draft with the same subject before the send, and a copy of the sent
 * message with that subject turns up in a Sent mailbox after the send started.
 *
 * ponytail: shortcut: a draft is matched by exact subject in a Drafts mailbox, not by body or recipients, and the sent copy is matched the same way; upgrade when two drafts or two sends share a subject.
 *
 * @module tools/draftCleanup
 */
import type { Message } from "@/types.js";

/** Clock skew allowed between the send start and the sent copy's timestamp. */
export const SEND_CLOCK_SLACK_MS = 60_000;

/** How long to wait for Mail.app to file the Sent copy, and how often to look. */
export const SENT_COPY_WAIT_MS = 50_000;
export const SENT_COPY_POLL_MS = 2_000;

/**
 * Polls `check` until it returns true or `timeoutMs` has passed on the clock.
 * Mail.app files the Sent copy a moment after `send`, so a single look right
 * after the send misses it. Always checks at least once. The deadline counts
 * the time `check` itself takes (a synchronous Mail.app search can run for
 * seconds), not just the sleeps: otherwise a slow search stretches the wait far
 * past the timeout and the caller's own deadline reports a delivered mail as lost.
 */
export async function pollUntil(
  check: () => boolean,
  timeoutMs: number = SENT_COPY_WAIT_MS,
  intervalMs: number = SENT_COPY_POLL_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => number = Date.now
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (now() + intervalMs > deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * A whole word in any script (`\b` only knows ASCII letters), so "Presentations"
 * or "Consent" never read as Sent. Names are matched with accents removed.
 */
const word = (alternatives: string): RegExp =>
  new RegExp(`(?<!\\p{L})(?:${alternatives})(?!\\p{L})`, "u");

// Mail names its special mailboxes in the language of macOS, and a server may
// name them in its own: the common names below, accents folded away.
const DRAFTS = word(
  "drafts?|borradore?s?|esborranys?|entwurfe?|brouillons?|bozze|bozza|rascunhos?|concepten|concept" +
    "|utkast|kladder|kladde|luonnokset|luonnos|szkice|szkic"
);
const SENT = word(
  "sent|enviados?|enviadas?|enviats?|gesendet\\p{L}*|envoyes?|inviat[ie]|verzonden|skickat\\p{L}*" +
    "|sendte?|lahetetyt|wyslane"
);

const fold = (name: string): string => name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** True for a Drafts mailbox, including Gmail's `[Gmail]/Drafts` and localized names. */
export function isDraftMailbox(mailbox: string): boolean {
  return DRAFTS.test(fold(mailbox));
}

/** True for a Sent mailbox ("Sent Messages", "Sent", "[Gmail]/Sent Mail", "Enviados"). */
export function isSentMailbox(mailbox: string): boolean {
  return SENT.test(fold(mailbox));
}

/** The draft exists, is still in a Drafts mailbox and carries the subject being sent. */
export function isDraftForSend(
  draft: Pick<Message, "subject" | "mailbox"> | null,
  subject: string
): boolean {
  return draft !== null && draft.subject === subject && isDraftMailbox(draft.mailbox);
}

/**
 * The one draft to use when the `draftId` the caller passed no longer exists.
 * A server-side account re-saves a draft and gives it a new numeric id within
 * seconds, so the id from an earlier listing can already be gone. Only an
 * unambiguous match by subject in a Drafts mailbox stands in for it; with none
 * or several, nothing is guessed and the caller says so.
 */
export function pickCurrentDraft(
  drafts: readonly Pick<Message, "id" | "subject" | "mailbox">[],
  subject: string
): { id: string } | { none: true } | { several: number } {
  const same = drafts.filter((d) => isDraftForSend(d, subject));
  if (same.length === 1) return { id: same[0].id };
  return same.length === 0 ? { none: true } : { several: same.length };
}

/** A message with this subject sits in a Sent mailbox, dated at or after `sentAfter`. */
export function hasSentCopy(
  hits: readonly Pick<Message, "subject" | "mailbox" | "dateReceived" | "dateSent">[],
  subject: string,
  sentAfter: Date
): boolean {
  return hits.some((m) => {
    if (m.subject !== subject || !isSentMailbox(m.mailbox)) return false;
    const when = m.dateSent ?? m.dateReceived;
    return when.getTime() >= sentAfter.getTime() - SEND_CLOCK_SLACK_MS;
  });
}
