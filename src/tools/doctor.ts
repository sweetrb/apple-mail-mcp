/**
 * Setup "doctor" (C3): one diagnostic that checks the things that actually break
 * an apple-mail-mcp setup — Mail.app automation permission, account state, and
 * the optional IMAP/SMTP backends — and reports each as ok / warn / fail with an
 * actionable message, instead of failing opaquely deep in a tool call.
 *
 * @module tools/doctor
 */
import type { AppleMailManager } from "@/services/appleMailManager.js";
import { imapHealthCheck, IMAP_ENV, listImapAccountLabels } from "@/services/imapClient.js";
import { SMTP_ENV, isSmtpConfigured } from "@/services/smtpMailer.js";

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

/** Public setup walkthrough, surfaced in the "not configured" messages so a stuck
 *  user (or their AI) can find it without having the repo checked out. */
const SETUP_GUIDE = "https://github.com/sweetrb/apple-mail-mcp/blob/main/docs/IMAP-SETUP.md";
/** The #1 Claude-Desktop failure mode: the host strips the server `env` block, so
 *  the env-var advice silently does nothing — point users at the file method. */
const CONFIG_FILE_HINT =
  "If your MCP host ignores the server 'env' block (e.g. Claude Desktop), put these " +
  "in ~/Library/Application Support/apple-mail-mcp/config.json instead";

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

  // 3. IMAP backend (optional) — check every configured account (C2).
  const imapAccounts = listImapAccountLabels();
  if (imapAccounts.length === 0) {
    checks.push({
      name: "IMAP backend",
      status: "warn",
      detail: `not configured — AppleScript is used for all accounts. Set ${IMAP_ENV.user} (+ Keychain/password), or ${IMAP_ENV.accounts} for multiple accounts, to enable server-side search and server-mailbox ops. ${CONFIG_FILE_HINT}. Setup guide: ${SETUP_GUIDE}`,
    });
  } else {
    for (const label of imapAccounts) {
      const h = await imapHealthCheck({ account: label });
      checks.push({
        name: `IMAP: ${label}`,
        status: h.ok ? "ok" : "fail",
        detail: h.ok
          ? `connected to ${h.host}`
          : `connection failed: ${h.error}. Check the Keychain password and host/port.`,
      });
    }
  }

  // 4. SMTP transport (optional) — configured?
  const smtpHost = process.env[SMTP_ENV.host]?.trim();
  checks.push({
    name: "SMTP transport",
    status: isSmtpConfigured() ? "ok" : "warn",
    detail: isSmtpConfigured()
      ? `configured (${smtpHost}); send-email auto-prefers clean SMTP (no Mail.app Sent-folder copy; a non-email "account" label still routes to AppleScript). Pass transport:"applescript" to force Mail.app. The apple-mail-send CLI is also available.`
      : `not configured — send-email uses AppleScript (subject to macOS 15+ blockquote wrapping). Set ${SMTP_ENV.host} and ${SMTP_ENV.user} (+ password via Keychain) to enable. ${CONFIG_FILE_HINT}. Setup guide: ${SETUP_GUIDE}`,
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
