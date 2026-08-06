import { describe, it, expect, vi, afterEach } from "vitest";
import { runDoctor, formatDoctorReport } from "@/tools/doctor.js";
import type { AppleMailManager } from "@/services/appleMailManager.js";

function fakeManager(over: Partial<AppleMailManager> = {}): AppleMailManager {
  return {
    healthCheck: () => ({
      healthy: true,
      checks: [{ name: "reachable", passed: true, message: "Mail.app responded" }],
    }),
    listAccounts: () => [
      { name: "iCloud", email: "x@icloud.com", enabled: false },
      { name: "work", email: "w@co.io", enabled: true },
    ],
    ...over,
  } as unknown as AppleMailManager;
}

afterEach(() => vi.unstubAllEnvs());

describe("runDoctor (C3)", () => {
  it("reports accounts, names disabled ones, and stays healthy when only warnings", async () => {
    vi.stubEnv("APPLE_MAIL_MCP_IMAP_USER", "");
    vi.stubEnv("APPLE_MAIL_MCP_IMAP_ACCOUNTS", "");
    vi.stubEnv("APPLE_MAIL_MCP_SMTP_HOST", "");
    const r = await runDoctor(fakeManager());
    expect(r.healthy).toBe(true); // warnings don't make it unhealthy
    const accounts = r.checks.find((c) => c.name === "Accounts");
    expect(accounts?.status).toBe("ok");
    expect(accounts?.detail).toMatch(/disabled: iCloud/);
    expect(r.checks.find((c) => c.name === "IMAP backend")?.status).toBe("warn");
    expect(r.checks.find((c) => c.name === "SMTP transport")?.status).toBe("warn");
  });

  it("is unhealthy when a Mail.app check fails", async () => {
    vi.stubEnv("APPLE_MAIL_MCP_IMAP_USER", "");
    vi.stubEnv("APPLE_MAIL_MCP_IMAP_ACCOUNTS", "");
    vi.stubEnv("APPLE_MAIL_MCP_SMTP_HOST", "");
    const r = await runDoctor(
      fakeManager({
        healthCheck: () => ({
          healthy: false,
          checks: [{ name: "permission", passed: false, message: "not authorized" }],
        }),
      })
    );
    expect(r.healthy).toBe(false);
    expect(formatDoctorReport(r)).toMatch(/ISSUES FOUND/);
    expect(formatDoctorReport(r)).toMatch(/❌ Mail\.app: permission/);
  });

  // Issue #138: with accounts declared ONLY via APPLE_MAIL_MCP_IMAP_ACCOUNTS,
  // imapHealthCheck's "is IMAP configured?" gate tested just the legacy
  // singular APPLE_MAIL_MCP_IMAP_USER, so it short-circuited to
  // {configured:false, ok:false} — no error field — and doctor interpolated
  // that into the literal text "connection failed: undefined" for every
  // account, without ever attempting a connection.
  it("#138: an ACCOUNTS-only config gets a real diagnosis, never 'undefined'", async () => {
    vi.stubEnv("APPLE_MAIL_MCP_IMAP_USER", "");
    const accounts = [{ account: "Work", user: "me@co.com", host: "imap.co.com" }];
    vi.stubEnv("APPLE_MAIL_MCP_IMAP_ACCOUNTS", JSON.stringify(accounts));
    vi.stubEnv("APPLE_MAIL_MCP_SMTP_HOST", "");
    const r = await runDoctor(fakeManager());
    const imap = r.checks.find((c) => c.name === "IMAP: Work");
    expect(imap).toBeDefined();
    expect(imap?.status).toBe("fail");
    expect(imap?.detail).not.toMatch(/undefined/);
    // No password and no Keychain service configured — that is the real reason,
    // and now it is the one reported (resolved without touching the network).
    expect(imap?.detail).toMatch(/No IMAP password for account "Work"/);
  });

  it("never renders the string 'undefined' in a failure detail", async () => {
    vi.stubEnv("APPLE_MAIL_MCP_IMAP_USER", "");
    vi.stubEnv(
      "APPLE_MAIL_MCP_IMAP_ACCOUNTS",
      JSON.stringify([{ account: "Nope", user: "a@b.com" }])
    );
    vi.stubEnv("APPLE_MAIL_MCP_SMTP_HOST", "");
    const r = await runDoctor(fakeManager());
    expect(formatDoctorReport(r)).not.toMatch(/undefined/);
  });
});
