import { describe, it, expect, vi, afterEach } from "vitest";
import { runDoctor, formatDoctorReport, bodyIndexCheck } from "@/tools/doctor.js";
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
  it("distinguishes SMTP configuration from authentication and Sent-copy success", async () => {
    vi.stubEnv("APPLE_MAIL_MCP_IMAP_USER", "");
    vi.stubEnv("APPLE_MAIL_MCP_IMAP_ACCOUNTS", "");
    vi.stubEnv("APPLE_MAIL_MCP_SMTP_HOST", "smtp.example.test");
    vi.stubEnv("APPLE_MAIL_MCP_SMTP_USER", "sender@example.test");
    const report = await runDoctor(fakeManager());
    const smtp = report.checks.find((check) => check.name === "SMTP transport");
    expect(smtp?.status).toBe("ok");
    expect(smtp?.detail).toContain("SMTP authentication and delivery have not been checked");
    expect(smtp?.detail).toContain("best-effort Sent-folder copy through matching-account IMAP");
    expect(smtp?.detail).not.toContain("no Mail.app Sent-folder copy");
  });

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

describe("body index check", () => {
  it("distinguishes indexed prefixes from fully searched bodies", () => {
    const c = bodyIndexCheck({
      enabled: true,
      counts: { indexed: 3, queued: 0, partial: 0, tooLarge: 0, truncated: 2 },
    });
    expect(c?.detail).toContain("5 messages indexed, 2 truncated at 100,000 body characters");
  });

  it("says nothing when the body index was never asked for", () => {
    expect(bodyIndexCheck({ enabled: false }, {})).toBeNull();
  });

  it("warns when only the body flag is set", () => {
    const c = bodyIndexCheck({ enabled: false }, { APPLE_MAIL_MCP_BODY_INDEX: "1" });
    expect(c?.status).toBe("warn");
    expect(c?.detail).toMatch(/APPLE_MAIL_MCP_ENVELOPE_INDEX is not/);
  });

  it("reports path, role, coverage, last walk, rebuild and last error", () => {
    const c = bodyIndexCheck({
      enabled: true,
      path: "/x/body-index.db",
      role: "writer",
      watching: true,
      counts: { indexed: 68000, queued: 12, partial: 3, tooLarge: 1 },
      meta: {
        lastFullWalk: "2026-10-30T15:00:00.000Z",
        lastWalkMs: 900,
        lastWalkFiles: 68016,
        lastRebuild: "2026-10-29T10:00:00.000Z (schema v2 → v3)",
      },
      lastError: "2026-10-30T15:01:00.000Z file watcher stopped: x",
    });
    expect(c?.status).toBe("ok");
    expect(c?.detail).toContain("file /x/body-index.db");
    expect(c?.detail).toContain("this instance is the writer (watching the mail store)");
    expect(c?.detail).toContain(
      "68,003 messages indexed, 12 not indexed yet, 3 with no body downloaded yet, 1 over the 25 MB cap"
    );
    expect(c?.detail).toContain("last full walk 2026-10-30T15:00:00.000Z (68,016 files, 900 ms)");
    expect(c?.detail).toContain("rebuilt 2026-10-29T10:00:00.000Z (schema v2 → v3)");
    expect(c?.detail).toContain("last error: 2026-10-30T15:01:00.000Z file watcher stopped");
  });

  it("warns, with the shared Full Disk Access wording, when it can't run", () => {
    const c = bodyIndexCheck({
      enabled: true,
      unavailable:
        "Envelope Index not readable (grant Full Disk Access to the server's Node runtime)",
    });
    expect(c?.status).toBe("warn");
    expect(c?.detail).toMatch(/Full Disk Access/);
    expect(c?.detail).toMatch(/as not searched/);
  });
});
