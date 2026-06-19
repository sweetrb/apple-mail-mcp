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
});
