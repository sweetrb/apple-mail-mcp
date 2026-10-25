#!/usr/bin/env node
import { loadFileConfig } from "./services/fileConfig.js";
import { gmailOAuth, type GoogleCredentialRef } from "./services/gmailOAuth.js";

loadFileConfig();
const [command, email] = process.argv.slice(2);
const ref: GoogleCredentialRef = {
  provider: "google",
  clientId: process.env.APPLE_MAIL_MCP_GOOGLE_CLIENT_ID ?? "",
  email: email ?? "",
};
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
try {
  switch (command) {
    case "connect":
    case "reconnect":
      console.error("Opening Google consent in your system browser. No mail will be sent.");
      await gmailOAuth.connect(ref, { signal: controller.signal });
      console.log(JSON.stringify(await gmailOAuth.status(ref)));
      break;
    case "status":
      console.log(JSON.stringify(await gmailOAuth.status(ref)));
      break;
    case "disconnect":
      await gmailOAuth.disconnect(ref);
      console.log(
        "Local Google credentials removed. Keep mail MCP instances stopped until this completes, then restart them. Revoke the app in your Google account to invalidate provider grants."
      );
      break;
    default:
      console.error(
        "Usage: apple-mail-auth connect|status|reconnect|disconnect account@example.com"
      );
      process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Google authorization failed.");
  process.exitCode = 1;
}
