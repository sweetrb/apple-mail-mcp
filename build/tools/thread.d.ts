/**
 * Thread / conversation grouping (B1).
 *
 * Mail.app's AppleScript bridge has no thread object and IMAP threading
 * (THREAD/REFERENCES) isn't uniformly available, so get-thread groups a
 * conversation by its normalized subject: strip the reply/forward prefixes and
 * gather every message sharing that base subject. Pragmatic and consistent
 * across both the AppleScript and IMAP backends.
 *
 * @module tools/thread
 */
/**
 * Strip leading reply/forward prefixes ("Re:", "Fwd:", "RE[2]:", localized
 * variants, repeated/stacked) to get the conversation's base subject.
 */
export declare function normalizeSubject(subject: string): string;
/** Pull the subject line out of an imapGetMessage "Subject: …\n\n<body>" result. */
export declare function subjectFromGetMessage(info: string): string | null;
//# sourceMappingURL=thread.d.ts.map