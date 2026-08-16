/**
 * Error text for a mailbox listing Mail refused. (#183)
 *
 * `listMailboxes` returns `[]` both when an account genuinely holds no
 * mailboxes and when Mail REFUSED the request — asking for an account that does
 * not exist raises `Can't get account "X"`. Reporting that empty list as a
 * success told the caller the opposite of the truth: "you have no mailboxes"
 * rather than "this store is not addressable".
 *
 * That is the same absent-vs-empty distinction the collateral diff enforces,
 * where an absent array means "not computable" and never "empty".
 *
 * Kept here rather than in `index.ts` so it is testable: importing `index.ts`
 * opens a stdio transport.
 *
 * @module tools/mailboxListing
 */

/**
 * Names for Mail's local store. It is NOT an account — its mailboxes hang off
 * the application, not off any `account` — so no `account` argument can ever
 * reach them, and an empty result is especially misleading for these.
 */
export const LOCAL_STORE_NAMES = ["on my mac", "on my computer", "local", "local folders"];

/** True when `name` is Mail's local store rather than a real account. */
export function isLocalStoreName(name: string): boolean {
  return LOCAL_STORE_NAMES.includes(name.trim().toLowerCase());
}

/**
 * Explain a refused mailbox listing, naming the accounts that DO exist so the
 * caller can correct the argument rather than concluding the mailbox is empty.
 */
export function unlistableStoreError(
  account: string | undefined,
  error: string | undefined,
  knownAccounts: string[]
): string {
  const scope = account ? ` for "${account}"` : "";
  const parts = [`Could not list mailboxes${scope}: ${error ?? "Mail declined the request"}`];
  if (knownAccounts.length > 0) {
    parts.push(`Accounts on this Mac: ${knownAccounts.join(", ")}.`);
  }
  if (account && isLocalStoreName(account)) {
    parts.push(
      `"${account}" is Mail's LOCAL store, not an account — its mailboxes are not children of ` +
        `any account, so they cannot be reached with an \`account\` argument. Enumerating them ` +
        `is not yet supported.`
    );
  }
  return parts.join("\n\n");
}
