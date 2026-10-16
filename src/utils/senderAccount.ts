/**
 * Resolving the `account` argument of send-email / create-draft to the address
 * Mail.app will actually put in `From:`.
 *
 * Mail.app's `set sender of <outgoing message> to "<text>"` silently ignores any
 * text that is not a configured address (an account NAME such as
 * "me@gmail", a typo, an address Mail does not own): no error, and the message
 * keeps the default sender. A `send` after that goes out from the wrong
 * identity while the tool reports success. So the caller-supplied `account` is
 * resolved here to one exact address, and the compose script reads `sender`
 * back before it sends (see `senderGuardScript`).
 *
 * @module utils/senderAccount
 */
import type { Account } from "@/types.js";

type SenderResolution = { address: string } | { error: string };

/** `Name <a@b.c>` → `a@b.c`; a bare address is returned trimmed. */
export function extractAddress(sender: string): string {
  const angle = /<([^<>]*)>\s*$/.exec(sender);
  return (angle ? angle[1] : sender).trim();
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

function describe(accounts: Account[]): string {
  const usable = accounts.filter((a) => a.enabled && a.addresses.length > 0);
  if (usable.length === 0) return "No enabled Mail account with an address was found.";
  return `Available: ${usable.map((a) => `${a.name} <${a.addresses.join(", ")}>`).join("; ")}`;
}

/**
 * Map the caller's `account` (an exact address, `Name <address>`, or a Mail
 * account name) to exactly one address of an enabled account. Anything that
 * does not resolve to one address is an error — never a guess.
 */
export function pickSenderAddress(input: string, accounts: Account[]): SenderResolution {
  const wanted = extractAddress(input);
  const enabled = accounts.filter((a) => a.enabled);

  const address = enabled.flatMap((a) => a.addresses).find((addr) => same(addr, wanted));
  if (address) return { address };

  const byName = enabled.filter((a) => same(a.name, input));
  if (byName.length > 1) {
    return {
      error: `Account name "${input}" matches ${byName.length} accounts; pass the exact sender address instead. ${describe(accounts)}`,
    };
  }
  if (byName.length === 1) {
    const { addresses } = byName[0];
    if (addresses.length === 1) return { address: addresses[0] };
    return {
      error: `Account "${input}" has ${addresses.length === 0 ? "no address" : `${addresses.length} addresses`}; pass the exact sender address instead. ${describe(accounts)}`,
    };
  }

  return {
    error: `No enabled Mail account or address matches "${input}", so nothing was sent or saved. ${describe(accounts)}`,
  };
}

/**
 * AppleScript run after `set sender` and before `send`/save-as-draft: reads the
 * sender back and, unless it is exactly `address`, deletes the message and
 * returns `error:<reason>` without sending (the `error:` convention of the other
 * compose scripts). With no address
 * (caller gave no `account`) it only binds `actualSender` so the script can
 * report who the message will go out as.
 *
 * AppleScript string comparison is case-insensitive by default, which is what
 * addresses need.
 */
export function senderGuardScript(safeAddress: string | undefined): string {
  const check = safeAddress
    ? `
        if not (actualSender is "${safeAddress}" or actualSender ends with "<${safeAddress}>") then
          delete newMessage
          return "error:Mail.app would send as " & actualSender & " instead of ${safeAddress}, so nothing was sent or saved."
        end if`
    : "";
  return `
        set actualSender to sender of newMessage as text${check}`;
}
