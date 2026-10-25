import { gmailOAuth, type GoogleCredentialRef } from "./gmailOAuth.js";

export function googleReference(
  auth: string | undefined,
  email: string,
  clientId: string | undefined
): GoogleCredentialRef | undefined {
  if (!auth || auth === "password") return undefined;
  if (auth !== "google") throw new Error("Unsupported authentication provider.");
  if (!clientId?.trim())
    throw new Error("Set APPLE_MAIL_MCP_GOOGLE_CLIENT_ID to your Google Desktop client ID.");
  return { provider: "google", email, clientId: clientId.trim() };
}

export interface CredentialConfig {
  user: string;
  pass: string;
  oauth?: GoogleCredentialRef;
  host: string;
  port: number;
  secure: boolean;
  allowPlaintext?: boolean;
}
export function validateOAuthTransport(cfg: CredentialConfig, protocol: "imap" | "smtp"): void {
  if (!cfg.oauth) return;
  if (
    cfg.oauth.email !== cfg.user ||
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
  return cfg.oauth
    ? { user: cfg.user, accessToken: await gmailOAuth.accessToken(cfg.oauth) }
    : { user: cfg.user, pass: cfg.pass };
}
