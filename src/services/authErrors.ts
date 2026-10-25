/** Only fixed messages cross CLI/log boundaries. Never forward provider,
 * subprocess, filesystem, or arbitrary Error.message content to those sinks. */
export type AuthFailureCode =
  "configuration" | "keychain" | "storage-busy" | "authorization" | "reconnect";

export class AuthOperationError extends Error {
  constructor(
    readonly code: AuthFailureCode,
    message: string
  ) {
    super(message);
    this.name = "AuthOperationError";
  }
}

export function publicAuthFailure(error: unknown): string {
  if (error instanceof AuthOperationError) {
    switch (error.code) {
      case "configuration":
        return "Configure a valid Google Desktop client ID and the expected account email.";
      case "keychain":
        return "Google credentials could not be accessed securely. Unlock the login Keychain and retry.";
      case "storage-busy":
        return "Google credential storage is busy. Stop mail MCP/auth processes and follow the stale-lock recovery instructions in docs/GMAIL-OAUTH.md.";
      case "authorization":
        return "Google authorization failed or was canceled. Check client registration, consent, and the selected account, then retry connect.";
      case "reconnect":
        return "Google credentials are unavailable or expired. Reconnect the account; no password fallback was attempted.";
    }
  }
  return "Google authorization operation failed. Check the account configuration and Keychain access; see docs/GMAIL-OAUTH.md for recovery.";
}
