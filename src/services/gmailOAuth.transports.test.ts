import { afterEach, beforeEach, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import { gmailOAuth, KeychainGrantStore, type GoogleAccountBinding } from "./gmailOAuth.js";
import { imapHealthCheck, resolveImapConfig, __resetPool } from "./imapClient.js";
import { ImapIdleWatcher } from "./imapIdle.js";
import { resolveSmtpConfig, sendViaSmtp } from "./smtpMailer.js";

const imap = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  clients: [] as { close: ReturnType<typeof vi.fn>; logout: ReturnType<typeof vi.fn> }[],
}));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    close = vi.fn();
    logout = vi.fn(async () => {});
    constructor(options: Record<string, unknown>) {
      imap.options.push(options);
      imap.clients.push(this);
    }
    on() {
      return this;
    }
    async connect() {}
    async noop() {}
    async mailboxOpen() {
      return { exists: 0 };
    }
  },
}));
const ref: GoogleAccountBinding = {
  provider: "google",
  clientId: "fixture.apps.googleusercontent.com",
  email: "Person@example.com",
};
const env = {
  APPLE_MAIL_MCP_GOOGLE_CLIENT_ID: ref.clientId,
  APPLE_MAIL_MCP_IMAP_AUTH: "google",
  APPLE_MAIL_MCP_IMAP_USER: ref.email,
  APPLE_MAIL_MCP_SMTP_AUTH: "google",
  APPLE_MAIL_MCP_SMTP_USER: ref.email,
  APPLE_MAIL_MCP_SMTP_HOST: "smtp.gmail.com",
};
beforeEach(() => {
  imap.options.length = 0;
  imap.clients.length = 0;
  vi.spyOn(gmailOAuth, "accessToken").mockResolvedValue("transport-canary");
  // This lifecycle test must never read or write the user's real Keychain.
  vi.spyOn(KeychainGrantStore.prototype, "remove").mockResolvedValue();
});
afterEach(async () => {
  await __resetPool();
  vi.restoreAllMocks();
});

it("production SMTP builder sends OAuth2 credentials over mandatory TLS without a password", async () => {
  const sendMail = vi.fn(async () => ({ messageId: "fixture" }));
  const create = vi
    .spyOn(nodemailer, "createTransport")
    .mockReturnValue({ sendMail, close: vi.fn() } as never);
  const config = resolveSmtpConfig(env);
  expect(gmailOAuth.accessToken).not.toHaveBeenCalled();
  const result = await sendViaSmtp(
    { to: ["nobody@example.com"], subject: "Fixture", body: "Fixture" },
    config,
    create,
    async () => ({})
  );
  expect(result.success).toBe(true);
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      requireTLS: true,
      auth: { type: "OAuth2", user: ref.email, accessToken: "transport-canary" },
    })
  );
  expect(gmailOAuth.accessToken).toHaveBeenCalledWith(ref);
});
it("production IMAP and IDLE builders receive accessToken and disconnect matches email case-insensitively", async () => {
  const config = resolveImapConfig(env);
  expect(gmailOAuth.accessToken).not.toHaveBeenCalled();
  expect((await imapHealthCheck({ config })).ok).toBe(true);
  const watcher = new ImapIdleWatcher({ configs: [config], onNewMail: vi.fn(), pollMs: 0 });
  await watcher.start();
  expect(imap.options).toHaveLength(2);
  for (const options of imap.options)
    expect(options).toMatchObject({
      host: "imap.gmail.com",
      secure: true,
      auth: { user: ref.email, accessToken: "transport-canary" },
    });
  for (const options of imap.options) expect(options.auth).not.toHaveProperty("pass");
  await gmailOAuth.disconnect({ ...ref, email: ref.email.toLowerCase() });
  expect(imap.clients[0].close).toHaveBeenCalled();
  expect(imap.clients[1].logout).toHaveBeenCalled();
  expect(watcher.watchedAccounts()).toEqual([]);
  await watcher.stop();
});
it("credential failure never invokes SMTP transport or password fallback", async () => {
  vi.mocked(gmailOAuth.accessToken).mockRejectedValue(new Error("Reconnect this account"));
  const create = vi.spyOn(nodemailer, "createTransport");
  const result = await sendViaSmtp(
    { to: ["nobody@example.com"], subject: "Fixture", body: "Fixture" },
    resolveSmtpConfig(env),
    create
  );
  expect(result.success).toBe(false);
  expect(create).not.toHaveBeenCalled();
});
