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
import { SETUP_GUIDE_URL } from "@/utils/docsUrls.js";
import { BODY_INDEX_ENV, bodyIndexStatus, type BodyIndexStatus } from "@/utils/bodyIndexSync.js";
import { ENVELOPE_INDEX_ENV, isTruthyFlag } from "@/utils/envelopeIndex.js";

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
      detail: `not configured — AppleScript is used for all accounts. Set ${IMAP_ENV.user} (+ Keychain/password), or ${IMAP_ENV.accounts} for multiple accounts, to enable server-side search and server-mailbox ops. ${CONFIG_FILE_HINT}. Setup guide: ${SETUP_GUIDE_URL}`,
    });
  } else {
    for (const label of imapAccounts) {
      const h = await imapHealthCheck({ account: label });
      checks.push({
        name: `IMAP: ${label}`,
        status: h.ok ? "ok" : "fail",
        // `h.error` is optional on the health-check result, so interpolating it
        // bare printed the literal string "connection failed: undefined" for
        // any failure that carried no message (issue #138). Never render that:
        // an unexplained failure is still worth naming, but as words.
        detail: h.ok
          ? `connected to ${h.host}`
          : `connection failed: ${h.error ?? "the health check reported no detail"}. Check the Keychain password and host/port.`,
      });
    }
  }

  // 4. SMTP transport (optional) — configured?
  const smtpHost = process.env[SMTP_ENV.host]?.trim();
  checks.push({
    name: "SMTP transport",
    status: isSmtpConfigured() ? "ok" : "warn",
    detail: isSmtpConfigured()
      ? `configuration present (${smtpHost}); SMTP authentication and delivery have not been checked. send-email auto-prefers SMTP unless a non-email "account" label selects AppleScript. SMTP sends attempt a best-effort Sent-folder copy through matching-account IMAP; check the send result for whether it was filed. Pass transport:"applescript" to force Mail.app. The apple-mail-send CLI is also available.`
      : `not configured — send-email uses AppleScript (subject to macOS 15+ blockquote wrapping). Set ${SMTP_ENV.host} and ${SMTP_ENV.user} (+ password via Keychain) to enable. ${CONFIG_FILE_HINT}. Setup guide: ${SETUP_GUIDE_URL}`,
  });

  // 5. Body index (opt-in). Reported only when asked for, so default setups see no noise.
  const body = bodyIndexCheck(bodyIndexStatus());
  if (body) checks.push(body);

  const healthy = !checks.some((c) => c.status === "fail");
  return { healthy, checks };
}

/**
 * The body index line: enabled or not, path, writer or reader, where the build
 * runs and whether it is running, coverage, last full walk, last rebuild and
 * last error. Null when the flag isn't set at all.
 */
export function bodyIndexCheck(
  s: BodyIndexStatus,
  env: NodeJS.ProcessEnv = process.env
): DoctorCheck | null {
  if (!s.enabled) {
    if (!isTruthyFlag(env[BODY_INDEX_ENV])) return null;
    return {
      name: "Body index",
      status: "warn",
      detail: `${BODY_INDEX_ENV} is set but ${ENVELOPE_INDEX_ENV} is not; the body index needs both, so body search on AppleScript-only accounts is off.`,
    };
  }
  const fmt = (n: number) => n.toLocaleString("en-US");
  const parts: string[] = [];
  if (s.path) parts.push(`file ${s.path}`);
  if (s.role) {
    parts.push(
      s.role === "writer"
        ? `this instance is the writer (${s.watching ? "watching the mail store" : "no file watcher; timed walks only"})`
        : "this instance is a reader (another instance keeps the index current)"
    );
  }
  if (s.build) {
    const b = s.build;
    parts.push(
      b.fallback
        ? `${b.fallback}${b.running ? "; build running" : ""}`
        : b.running
          ? `build running in a ${b.runsOn}`
          : `no build running (it starts in a ${b.runsOn} when there is work)`
    );
  }
  if (s.counts) {
    const c = s.counts;
    parts.push(
      `${fmt(c.indexed + c.partial)} messages indexed` +
        (c.queued ? `, ${fmt(c.queued)} not indexed yet` : "") +
        (c.partial ? `, ${fmt(c.partial)} with no body downloaded yet` : "") +
        (c.tooLarge ? `, ${fmt(c.tooLarge)} over the 25 MB cap` : "") +
        (c.unreadable ? `, ${fmt(c.unreadable)} that couldn't be read` : "")
    );
  }
  if (s.meta) {
    const m = s.meta;
    parts.push(
      m.lastFullWalk
        ? `last full walk ${m.lastFullWalk} (${fmt(m.lastWalkFiles ?? 0)} files, ${fmt(m.lastWalkMs ?? 0)} ms)`
        : "first full walk still running"
    );
    if (m.lastRebuild) parts.push(`rebuilt ${m.lastRebuild}`);
  }
  const lastError = s.lastError ?? s.meta?.lastError;
  if (lastError) parts.push(`last error: ${lastError}`);
  if (s.unavailable) {
    return {
      name: "Body index",
      status: "warn",
      detail: `enabled but not usable: ${s.unavailable}. Body searches on AppleScript-only accounts report those accounts as not searched.${parts.length ? ` ${parts.join("; ")}.` : ""}`,
    };
  }
  return { name: "Body index", status: "ok", detail: `${parts.join("; ")}.` };
}

/** Render a DoctorReport as readable text. */
export function formatDoctorReport(r: DoctorReport): string {
  const icon = (s: CheckStatus): string => (s === "ok" ? "✅" : s === "warn" ? "⚠️ " : "❌");
  const lines = [`🩺 apple-mail-mcp doctor — ${r.healthy ? "healthy" : "ISSUES FOUND"}`, ""];
  for (const c of r.checks) lines.push(`${icon(c.status)} ${c.name}: ${c.detail}`);
  return lines.join("\n");
}
