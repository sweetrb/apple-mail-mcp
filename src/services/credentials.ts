import { gmailOAuth } from "./gmailOAuth.js";
import type { GoogleAccountBinding } from "./googleAccount.js";

export interface CredentialConfig {
  user: string;
  pass: string;
  googleAccount?: GoogleAccountBinding;
  host: string;
  port: number;
  secure: boolean;
  allowPlaintext?: boolean;
}
export function validateOAuthTransport(cfg: CredentialConfig, protocol: "imap" | "smtp"): void {
  if (!cfg.googleAccount) return;
  if (
    cfg.googleAccount.email !== cfg.user ||
    cfg.allowPlaintext ||
    cfg.host.toLowerCase() !== (protocol === "imap" ? "imap.gmail.com" : "smtp.gmail.com") ||
    (protocol === "imap"
      ? !(cfg.secure && cfg.port === 993)
      : !((cfg.secure && cfg.port === 465) || (!cfg.secure && cfg.port === 587)))
  ) {
    throw new Error(
      "Google OAuth requires the matching account and Google's TLS-only IMAP/SMTP endpoints."
    );
  }
}
export async function resolveCredential(
  cfg: CredentialConfig,
  protocol: "imap" | "smtp"
): Promise<{ user: string; pass: string } | { user: string; accessToken: string }> {
  validateOAuthTransport(cfg, protocol);
  return cfg.googleAccount
    ? { user: cfg.user, accessToken: await gmailOAuth.accessToken(cfg.googleAccount) }
    : { user: cfg.user, pass: cfg.pass };
}
