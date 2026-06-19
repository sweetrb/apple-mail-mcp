/**
 * Setup "doctor" (C3): one diagnostic that checks the things that actually break
 * an apple-mail-mcp setup — Mail.app automation permission, account state, and
 * the optional IMAP/SMTP backends — and reports each as ok / warn / fail with an
 * actionable message, instead of failing opaquely deep in a tool call.
 *
 * @module tools/doctor
 */
import type { AppleMailManager } from "@/services/appleMailManager.js";
import { imapHealthCheck, IMAP_ENV } from "@/services/imapClient.js";
import { SMTP_ENV } from "@/services/smtpMailer.js";

export type CheckStatus = "ok" | "warn" | "fail";
export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}
export interface DoctorReport {
  healthy: boolean;
  checks: DoctorCheck[];
}

export async function runDoctor(mailManager: AppleMailManager): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // 1. Mail.app reachability + Automation permission (existing health check).
  const hc = mailManager.healthCheck();
  for (const c of hc.checks) {
    checks.push({
      name: `Mail.app: ${c.name}`,
      status: c.passed ? "ok" : "fail",
      detail: c.message,
    });
  }

  // 2. Accounts — at least one enabled; name any disabled (they're invisible in
  //    the UI but still addressable, a common source of confusion — see #47).
  try {
    const accounts = mailManager.listAccounts();
    const enabled = accounts.filter((a) => a.enabled);
    const disabled = accounts.filter((a) => !a.enabled).map((a) => a.name);
    checks.push({
      name: "Accounts",
      status: enabled.length > 0 ? "ok" : "warn",
      detail:
        `${accounts.length} configured, ${enabled.length} enabled` +
        (disabled.length ? ` (disabled: ${disabled.join(", ")})` : ""),
    });
  } catch (e) {
    checks.push({
      name: "Accounts",
      status: "fail",
      detail: `could not list accounts: ${String(e)}`,
    });
  }

  // 3. IMAP backend (optional) — configured? connects?
  const imap = await imapHealthCheck();
  if (!imap.configured) {
    checks.push({
      name: "IMAP backend",
      status: "warn",
      detail: `not configured — AppleScript is used for all accounts. Set ${IMAP_ENV.user} (+ Keychain/password) to enable server-side search and server-mailbox ops.`,
    });
  } else {
    checks.push({
      name: "IMAP backend",
      status: imap.ok ? "ok" : "fail",
      detail: imap.ok
        ? `connected to ${imap.host} as ${imap.account}`
        : `configured but the connection failed: ${imap.error}. Check the app-specific password in the Keychain and the host/port.`,
    });
  }

  // 4. SMTP transport (optional) — configured?
  const smtpHost = process.env[SMTP_ENV.host]?.trim();
  checks.push({
    name: "SMTP transport",
    status: smtpHost ? "ok" : "warn",
    detail: smtpHost
      ? `configured (${smtpHost}); send-email transport:"smtp" is available`
      : `not configured — send-email uses AppleScript (subject to macOS 15+ blockquote wrapping). Set ${SMTP_ENV.host} to enable.`,
  });

  const healthy = !checks.some((c) => c.status === "fail");
  return { healthy, checks };
}

/** Render a DoctorReport as readable text. */
export function formatDoctorReport(r: DoctorReport): string {
  const icon = (s: CheckStatus): string => (s === "ok" ? "✅" : s === "warn" ? "⚠️ " : "❌");
  const lines = [`🩺 apple-mail-mcp doctor — ${r.healthy ? "healthy" : "ISSUES FOUND"}`, ""];
  for (const c of r.checks) lines.push(`${icon(c.status)} ${c.name}: ${c.detail}`);
  return lines.join("\n");
}
