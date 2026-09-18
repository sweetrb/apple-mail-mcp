import { executeAppleScript } from "@/utils/applescript.js";
import {
  buildAppLevelScript,
  escapeForAppleScript,
  escapeForAppleScriptBody,
} from "@/utils/appleScriptText.js";

export interface SavedDraftSendInput {
  account: string;
  draftId: string;
  composeId: string;
  sender: string;
  recipient: string;
  subject: string;
  signature: string;
  body: string;
  dryRun: boolean;
}

// Mail represents signature spacing differently in the composer and saved MIME.
// Ignore whitespace only; word tokenization would hide punctuation-only edits.
export const DRAFT_TEXT_NORMALIZER = `
on compactDraftText(valueText)
  set priorDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to {space, tab, return, linefeed, character id 160, character id 8239}
  set textParts to text items of valueText
  set AppleScript's text item delimiters to ""
  set compactValue to textParts as text
  set AppleScript's text item delimiters to priorDelimiters
  return compactValue
end compactDraftText
`;

/** Only sends an existing, verified composer while its saved draft still exists. */
export function buildSavedDraftSendScript(input: SavedDraftSendInput): string {
  if (!/^\d+$/.test(input.draftId) || !/^\d+$/.test(input.composeId))
    throw new Error("Invalid draft identifiers");
  const e = escapeForAppleScript;
  return (
    DRAFT_TEXT_NORMALIZER +
    buildAppLevelScript(`
    set sourceAccount to account "${e(input.account)}"
    set sourceMessage to first message of mailbox "Drafts" of sourceAccount whose id is ${input.draftId}
    if subject of sourceMessage is not "${e(input.subject)}" then error "Stored draft subject mismatch"
    if (address of every to recipient of sourceMessage) is not {"${e(input.recipient)}"} then error "Stored draft recipient mismatch"
    if sender of sourceMessage is not "${e(input.sender)}" then error "Stored draft sender mismatch"
    set candidateMessages to every outgoing message whose id is ${input.composeId}
    if (count of candidateMessages) is not 1 then error "Original composer unavailable; no send performed"
    set targetMessage to item 1 of candidateMessages
    if subject of targetMessage is not "${e(input.subject)}" then error "Composer subject mismatch"
    if sender of targetMessage is not "${e(input.sender)}" then error "Composer sender mismatch"
    if (address of every to recipient of targetMessage) is not {"${e(input.recipient)}"} then error "Composer recipient mismatch"
    if (count of cc recipients of targetMessage) is not 0 or (count of bcc recipients of targetMessage) is not 0 then error "Unexpected CC/BCC"
    if (count of attachments of content of targetMessage) is not 0 then error "Unexpected attachment"
    if message signature of targetMessage is missing value then error "Missing signature"
    if name of message signature of targetMessage is not "${e(input.signature)}" then error "Signature mismatch"
    set expectedBody to "${escapeForAppleScriptBody(input.body)}"
    set composeBody to content of targetMessage as text
    set storedBody to content of sourceMessage as text
    considering case, diacriticals, punctuation
    if my compactDraftText(composeBody) is not my compactDraftText(expectedBody) then error "Composer body differs from approved content"
    set expectedFullText to expectedBody & return & (content of message signature of targetMessage as text)
    if my compactDraftText(storedBody) is not my compactDraftText(expectedFullText) then error "Stored body differs from approved content"
    end considering
    ${input.dryRun ? 'return "validated"' : 'if send targetMessage then\n      return "submitted"\n    else\n      error "Mail did not confirm submission; inspect Sent before retrying"\n    end if'}
  `)
  );
}

export function sendSavedDraft(input: SavedDraftSendInput): { status: string } {
  const result = executeAppleScript(buildSavedDraftSendScript(input), {
    timeoutMs: 60000,
    maxRetries: 1,
  });
  if (!result.success)
    throw new Error(result.error ?? "Unknown send outcome; inspect Sent before retrying");
  const expected = input.dryRun ? "validated" : "submitted";
  if (result.output !== expected)
    throw new Error("Unknown send outcome; inspect Sent before retrying");
  return { status: expected };
}
