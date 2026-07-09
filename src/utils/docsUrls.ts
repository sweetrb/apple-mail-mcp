/**
 * Absolute documentation URLs shared by error messages and the doctor tool.
 *
 * Errors that tell a user "X is not configured" must be actionable for someone
 * who installed from npm or a plugin marketplace and has never seen the repo —
 * so they end with an absolute setup-guide URL plus a pointer at the `doctor`
 * tool, instead of referencing files relative to a checkout they don't have.
 *
 * @module utils/docsUrls
 */

/** Step-by-step IMAP/SMTP setup walkthrough (app passwords, Keychain, env vs config.json). */
export const SETUP_GUIDE_URL =
  "https://github.com/sweetrb/apple-mail-mcp/blob/main/docs/IMAP-SETUP.md";

/** Standard tail for "not configured" errors: where to read + how to diagnose. */
export const SETUP_HINT = `Setup guide: ${SETUP_GUIDE_URL} — run the "doctor" tool to check your setup.`;
