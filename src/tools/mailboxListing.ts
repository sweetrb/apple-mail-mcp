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
 * the application, not off any `account`.
 *
 * Re-exported from `appleMailManager`, which owns the canonical list because it
 * is what actually routes a request to the local branch. Two copies would drift,
 * and the failure mode is silent: a name accepted by one and not the other.
 */
export { isLocalStoreLabel as isLocalStoreName } from "@/services/appleMailManager.js";
import { isLocalStoreLabel } from "@/services/appleMailManager.js";

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
  if (account && isLocalStoreLabel(account)) {
    parts.push(
      `"${account}" addresses Mail's LOCAL store, which IS listable — it is read at the ` +
        `application level rather than through an account, so this failure is not "no such ` +
        `account". Something went wrong reading the local store itself.`
    );
  }
  return parts.join("\n\n");
}
