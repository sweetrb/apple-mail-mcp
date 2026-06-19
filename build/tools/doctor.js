import { imapHealthCheck, IMAP_ENV } from "../services/imapClient.js";
import { SMTP_ENV } from "../services/smtpMailer.js";
export async function runDoctor(mailManager) {
    const checks = [];
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
            detail: `${accounts.length} configured, ${enabled.length} enabled` +
                (disabled.length ? ` (disabled: ${disabled.join(", ")})` : ""),
        });
    }
    catch (e) {
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
    }
    else {
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
export function formatDoctorReport(r) {
    const icon = (s) => (s === "ok" ? "✅" : s === "warn" ? "⚠️ " : "❌");
    const lines = [`🩺 apple-mail-mcp doctor — ${r.healthy ? "healthy" : "ISSUES FOUND"}`, ""];
    for (const c of r.checks)
        lines.push(`${icon(c.status)} ${c.name}: ${c.detail}`);
    return lines.join("\n");
}
