/**
 * Mail account settings, read and written through AppleScript.
 *
 * Pure builders and a parser, kept apart from the manager so they can be tested
 * without Mail. Two deliberate limits:
 * - `password` (of the account and of its SMTP server) is never read, written
 *   or returned.
 * - Only settings that cannot lock the account out or redirect its mail are
 *   writable: servers, ports, user names, credentials and the account's email
 *   addresses (which decide the sender) are read-only here.
 *
 * @module utils/accountSettings
 */

const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

/** AppleScript property of an `account`, by the key it is reported under. */
const ACCOUNT_READS: ReadonlyArray<readonly [string, string]> = [
  ["fullName", "full name"],
  ["emailAddresses", "email addresses"],
  ["enabled", "enabled"],
  ["accountType", "account type"],
  ["userName", "user name"],
  ["serverName", "server name"],
  ["port", "port"],
  ["usesSsl", "uses ssl"],
  ["includeWhenGettingNewMail", "include when getting new mail"],
  ["moveDeletedMessagesToTrash", "move deleted messages to trash"],
  ["emptyTrashOnQuit", "empty trash on quit"],
  ["emptyJunkOnQuit", "empty junk messages on quit"],
  ["emptySentOnQuit", "empty sent messages on quit"],
  ["emptyTrashFrequency", "empty trash frequency"],
  ["emptyJunkFrequency", "empty junk messages frequency"],
  ["emptySentFrequency", "empty sent messages frequency"],
  // IMAP accounts only; a property an account does not have is skipped.
  ["storeDraftsOnServer", "store drafts on server"],
  ["storeJunkOnServer", "store junk mail on server"],
  ["storeSentOnServer", "store sent messages on server"],
  ["storeDeletedOnServer", "store deleted messages on server"],
  ["compactMailboxesWhenClosing", "compact mailboxes when closing"],
  ["messageCaching", "message caching"],
];

/** Properties of the account's outgoing (SMTP) server, reported as `smtp<Name>`. */
const SMTP_READS: ReadonlyArray<readonly [string, string]> = [
  ["smtpName", "name"],
  ["smtpServerName", "server name"],
  ["smtpPort", "port"],
  ["smtpUsesSsl", "uses ssl"],
  ["smtpUserName", "user name"],
  ["smtpEnabled", "enabled"],
];

/** The settings that can be changed, by key, with the AppleScript property. */
export const WRITABLE_ACCOUNT_SETTINGS = {
  enabled: "enabled",
  fullName: "full name",
  includeWhenGettingNewMail: "include when getting new mail",
  moveDeletedMessagesToTrash: "move deleted messages to trash",
  emptyTrashOnQuit: "empty trash on quit",
  emptyJunkOnQuit: "empty junk messages on quit",
  emptySentOnQuit: "empty sent messages on quit",
  storeDraftsOnServer: "store drafts on server",
  storeJunkOnServer: "store junk mail on server",
  storeSentOnServer: "store sent messages on server",
  storeDeletedOnServer: "store deleted messages on server",
  compactMailboxesWhenClosing: "compact mailboxes when closing",
} as const;

export type WritableAccountSetting = keyof typeof WRITABLE_ACCOUNT_SETTINGS;
export type AccountSettingsChanges = Partial<Record<WritableAccountSetting, boolean | string>>;
export type AccountSettings = Record<string, string | boolean | string[]>;

// Control characters go too: a newline would end the AppleScript literal early, and
// \x1e / \x1f are the separators the read-back splits on. (Not imported from the
// manager, which imports this module.)
const escape = (text: string): string =>
  text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "");

/** AppleScript body (inside `tell application "Mail"`) that reads one account's settings. */
export function buildAccountSettingsReadScript(accountName: string): string {
  const reads = ACCOUNT_READS.map(
    ([key, prop]) => `
      try
        set end of out to "${key}${FIELD_SEP}" & ((${prop} of a) as text)
      end try`
  ).join("");
  const smtp = SMTP_READS.map(
    ([key, prop]) => `
        try
          set end of out to "${key}${FIELD_SEP}" & ((${prop} of d) as text)
        end try`
  ).join("");
  return `
      set a to account "${escape(accountName)}"
      set out to {}
      set AppleScript's text item delimiters to ", "
      ${reads}
      try
        set d to delivery account of a
        ${smtp}
      end try
      set AppleScript's text item delimiters to "${RECORD_SEP}"
      return out as text
    `;
}

/** Turns the read script's output into an object; booleans become booleans. */
export function parseAccountSettings(output: string): AccountSettings {
  const settings: AccountSettings = {};
  for (const record of output.split(RECORD_SEP)) {
    const at = record.indexOf(FIELD_SEP);
    if (at < 0) continue;
    const key = record.slice(0, at);
    const value = record.slice(at + 1);
    if (value === "true" || value === "false") settings[key] = value === "true";
    else if (key === "emailAddresses") settings[key] = value.split(", ").filter(Boolean);
    else settings[key] = value;
  }
  return settings;
}

/**
 * AppleScript body that applies `changes`. Each `set` is guarded, so one the
 * account does not support is reported instead of aborting the rest. Returns
 * `ok`, or the failures joined by the record separator.
 */
export function buildAccountSettingsWriteScript(
  accountName: string,
  changes: AccountSettingsChanges
): string {
  const sets = (Object.keys(changes) as WritableAccountSetting[])
    .map((key) => {
      const prop = WRITABLE_ACCOUNT_SETTINGS[key];
      const raw = changes[key];
      const value = typeof raw === "boolean" ? String(raw) : `"${escape(String(raw))}"`;
      return `
      try
        set ${prop} of a to ${value}
      on error errMsg
        set end of fails to "${key}: " & errMsg
      end try`;
    })
    .join("");
  return `
      set a to account "${escape(accountName)}"
      set fails to {}${sets}
      if (count of fails) is 0 then return "ok"
      set AppleScript's text item delimiters to "${RECORD_SEP}"
      return fails as text
    `;
}

/** One `key: value` line per setting, as `get-account-settings` and `set-account-settings` show them. */
export function describeAccountSettings(settings: AccountSettings): string {
  return Object.entries(settings)
    .map(([key, value]) => `  ${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
    .join("\n");
}

/**
 * Splits the settings asked for into those Mail took and those it refused.
 * `refused` holds `key: reason` entries (see buildAccountSettingsWriteScript).
 */
export function splitAppliedSettings(
  changes: Record<string, unknown>,
  refused: readonly string[]
): { applied: string[]; refusedKeys: string[] } {
  const refusedKeys = refused.map((entry) => entry.split(":")[0].trim());
  const applied = Object.keys(changes).filter(
    (key) => changes[key] !== undefined && !refusedKeys.includes(key)
  );
  return { applied, refusedKeys };
}

/** Validates `changes`: at least one known setting, boolean unless it is `fullName`. */
export function validateAccountSettingsChanges(changes: Record<string, unknown>): void {
  const keys = Object.keys(changes).filter((k) => changes[k] !== undefined);
  if (keys.length === 0) {
    throw new Error(
      `Nothing to change. Pass at least one of: ${Object.keys(WRITABLE_ACCOUNT_SETTINGS).join(", ")}.`
    );
  }
  for (const key of keys) {
    if (!(key in WRITABLE_ACCOUNT_SETTINGS)) {
      throw new Error(
        `"${key}" cannot be changed here. Changeable: ${Object.keys(WRITABLE_ACCOUNT_SETTINGS).join(", ")}.`
      );
    }
    const value = changes[key];
    if (key === "fullName") {
      if (typeof value !== "string" || !value.trim()) throw new Error("fullName must be text.");
    } else if (typeof value !== "boolean") {
      throw new Error(`${key} must be true or false.`);
    }
  }
}
