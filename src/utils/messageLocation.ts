/**
 * Where a listed message is, in the text lines the read tools print
 * (`search-messages`, `list-messages`, `get-thread`).
 *
 * The structured result has always carried each message's `mailbox` and
 * `account`, but the text did not, and some clients show a model only the
 * text. A search that spans mailboxes then lists copies it can't tell apart:
 * the message that was sent, in Sent Items, and the earlier drafts of it that
 * Exchange keeps in Deleted Items, all under one subject.
 *
 * @module utils/messageLocation
 */

/** The fields of a message row that say where it is. */
export interface MessageLocation {
  mailbox?: unknown;
  account?: unknown;
}

/**
 * ` | in "Deleted Items" (Exchange)`, for the end of a message's line, or ""
 * when its mailbox is unknown. The account is left out when it is empty.
 */
export function locationSuffix(mailbox: unknown, account: unknown): string {
  if (typeof mailbox !== "string" || mailbox === "") return "";
  const owner = typeof account === "string" && account !== "" ? ` (${account})` : "";
  return ` | in "${mailbox}"${owner}`;
}

/** Whether `rows` come from more than one mailbox or more than one account. */
export function spansLocations(rows: readonly MessageLocation[]): boolean {
  return rows.some((r) => r.mailbox !== rows[0].mailbox || r.account !== rows[0].account);
}
