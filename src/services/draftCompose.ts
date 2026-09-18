import { executeAppleScript } from "@/utils/applescript.js";
import { buildAppLevelScript, escapeForAppleScript } from "@/utils/appleScriptText.js";

export interface DraftOptions {
  sender?: string;
  signature?: string;
}

export type DraftResult =
  | { success: true; composeId: string; sender: string; signature: string }
  | { success: false; error: string };

interface DraftScriptInput extends DraftOptions {
  account?: string;
  recipientCommands: string;
  safeSubject: string;
  safeBody: string;
  attachmentCommands: string;
}

const RECEIPT_SEPARATOR = "\u001f";

/** Preflight selections before creating anything; never retry a compose mutation. */
export function buildDraftScript(input: DraftScriptInput): string {
  const account = escapeForAppleScript(input.account ?? "");
  const sender = escapeForAppleScript(input.sender ?? "");
  const signature = escapeForAppleScript(input.signature ?? "");
  const acquireMessage = `
    if selectedSender is "" then
      set newMessage to make new outgoing message with properties {subject:"${input.safeSubject}", visible:false}
    else
      set newMessage to make new outgoing message with properties {subject:"${input.safeSubject}", sender:selectedSender, visible:false}
    end if
  `;
  return buildAppLevelScript(`
    set requestedAccount to "${account}"
    set requestedSender to "${sender}"
    set requestedSignatureName to "${signature}"
    set selectedSignature to missing value
    if requestedSignatureName is not "" then
      set matchingSignatures to every signature whose name is requestedSignatureName
      if (count of matchingSignatures) is not 1 then error "Signature missing or ambiguous: " & requestedSignatureName
      set selectedSignature to item 1 of matchingSignatures
    end if

    set selectedSender to ""
    if requestedAccount is not "" or requestedSender is not "" then
      set matchingAccounts to {}
      repeat with candidate in accounts
        if enabled of candidate then
          set candidateAddresses to email addresses of candidate
          set accountMatches to (requestedAccount is "" or name of candidate is requestedAccount or candidateAddresses contains requestedAccount)
          set senderMatches to (requestedSender is "" or candidateAddresses contains requestedSender)
          if accountMatches and senderMatches then set end of matchingAccounts to contents of candidate
        end if
      end repeat
      if (count of matchingAccounts) is not 1 then error "Account/sender missing, disabled, mismatched or ambiguous"
      set selectedAccount to item 1 of matchingAccounts
      set selectedAddresses to email addresses of selectedAccount
      if (count of selectedAddresses) is 0 then error "Selected account has no sender address"
      if requestedSender is not "" then
        set selectedSender to requestedSender
      else if selectedAddresses contains requestedAccount then
        set selectedSender to requestedAccount
      else
        set selectedSender to item 1 of selectedAddresses
      end if
    end if

    set desiredBody to "${input.safeBody}"
    ${acquireMessage}
    tell newMessage
      ${input.recipientCommands}
      set message signature to missing value
      set content to desiredBody
      ${input.attachmentCommands}
    end tell
    if selectedSignature is not missing value then set message signature of newMessage to selectedSignature
    save newMessage

    set actualSender to sender of newMessage
    if selectedSender is not "" then
      if actualSender is not selectedSender and actualSender does not end with ("<" & selectedSender & ">") then error "Draft sender verification failed; inspect Drafts before retrying"
    end if
    set actualSignature to ""
    if message signature of newMessage is not missing value then set actualSignature to name of message signature of newMessage
    if actualSignature is not requestedSignatureName then error "Draft signature verification failed; inspect Drafts before retrying"
    set savedBody to content of newMessage as text
    repeat with bodyParagraph in paragraphs of desiredBody
      if (bodyParagraph as text) is not "" and savedBody does not contain (bodyParagraph as text) then error "Draft body verification failed; inspect Drafts before retrying"
    end repeat
    set composeId to id of newMessage as text
    close newMessage saving yes
    return "saved" & ASCII character 31 & composeId & ASCII character 31 & actualSender & ASCII character 31 & actualSignature
  `);
}

export function createSavedDraft(input: DraftScriptInput): DraftResult {
  const result = executeAppleScript(buildDraftScript(input), { timeoutMs: 60000, maxRetries: 1 });
  if (!result.success) {
    return {
      success: false,
      error: `${result.error ?? "Draft creation failed"}. A draft may already exist; inspect Drafts before retrying.`,
    };
  }
  const [status, composeId, sender, signature = "", ...extra] =
    result.output.split(RECEIPT_SEPARATOR);
  if (status !== "saved" || !/^\d+$/.test(composeId ?? "") || !sender || extra.length) {
    return { success: false, error: "Invalid draft receipt; inspect Drafts before retrying." };
  }
  return { success: true, composeId, sender, signature };
}

export function listMailSignatures(): string[] {
  const result = executeAppleScript(
    buildAppLevelScript(`
    set signatureNames to name of every signature
    set AppleScript's text item delimiters to ASCII character 31
    return signatureNames as text
  `)
  );
  if (!result.success) throw new Error(result.error ?? "Could not read Mail signatures");
  return result.output ? result.output.split(RECEIPT_SEPARATOR) : [];
}
