#!/usr/bin/env node
import { loadFileConfig } from "./services/fileConfig.js";
import { gmailOAuth } from "./services/gmailOAuth.js";
import type { GoogleAccountBinding } from "./services/googleAccount.js";
import { publicAuthFailure } from "./services/authErrors.js";

loadFileConfig();
const [command, email] = process.argv.slice(2);
const ref: GoogleAccountBinding = {
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
  console.error(publicAuthFailure(error));
  process.exitCode = 1;
}
