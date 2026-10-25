/** Public account routing metadata. Never add passwords, access tokens, refresh
 * tokens, authorization codes, or client secrets to this interface. Secrets are
 * represented separately by GoogleGrant and resolved only at connection time. */
export interface GoogleAccountBinding {
  provider: "google";
  clientId: string;
  email: string;
}

/** Creates a non-secret binding from configuration; never accesses credentials. */
export function googleReference(
  auth: string | undefined,
  email: string,
  clientId: string | undefined
): GoogleAccountBinding | undefined {
  if (!auth || auth === "password") return undefined;
  if (auth !== "google") throw new Error("Unsupported authentication provider.");
  if (!clientId?.trim())
    throw new Error("Set APPLE_MAIL_MCP_GOOGLE_CLIENT_ID to your Google Desktop client ID.");
  return { provider: "google", email, clientId: clientId.trim() };
}
