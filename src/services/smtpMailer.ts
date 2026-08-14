/**
 * SMTP transport for sending mail (issue #12).
 *
 * Mail.app's AppleScript send path wraps any injected body in
 * `<blockquote type="cite">` under the Apple-Mail-URLShareWrapperClass template
 * on macOS 15+, so messages render to recipients as quoted/forwarded content
 * (Apple radar FB11734014, open since Ventura). This module bypasses Mail.app
 * entirely and submits clean MIME directly over SMTP via nodemailer.
 *
 * Connection settings come from environment variables; the password is read
 * from the macOS Keychain via the `security` CLI by default so no secret is
 * ever placed in config. When SMTP is configured, `send-email` auto-prefers it
 * over AppleScript (opt out per call with `transport: "applescript"`); see
 * {@link shouldUseSmtp}.
 *
 * @module services/smtpMailer
 */

import nodemailer from "nodemailer";
import { execFileSync } from "child_process";
import { isAbsolute } from "path";
import { existsSync } from "fs";
import type { AttachmentInput } from "@/types.js";
import { decodeInlineAttachment } from "@/utils/attachmentLimits.js";
import { SETUP_HINT } from "@/utils/docsUrls.js";

/** Options for an SMTP send, mirroring the AppleScript send-email surface. */
export interface SmtpSendOptions {
  to: string[];
  subject: string;
  /** Plain-text body. Always sent as the text/plain part. */
  body: string;
  cc?: string[];
  bcc?: string[];
  /** Overrides the configured From address (must be allowed by the SMTP server). */
  from?: string;
  /** Files to attach: absolute paths and/or inline base64 content (B4). */
  attachments?: AttachmentInput[];
  /**
   * Optional HTML body. When provided, the message is sent as
   * multipart/alternative ({@link SmtpSendOptions.body} as the text/plain part,
   * this as the text/html part) so clients pick the richer rendering while
   * plain-text clients still get a clean fallback.
   */
  htmlBody?: string;
  /**
   * RFC 5322 threading (2.5.0): the message this is replying to — emitted as the
   * `In-Reply-To` header so SMTP replies/forwards thread correctly in Gmail and
   * other clients. Pass the original message's `Message-ID`.
   */
  inReplyTo?: string;
  /**
   * RFC 5322 threading (2.5.0): the `References` chain — the original message's
   * existing `References` plus its `Message-ID`. nodemailer accepts an array.
   */
  references?: string[];
}

/** Resolved SMTP connection configuration. */
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  /** Deliberate insecure escape hatch; false/undefined requires STARTTLS. */
  allowPlaintext?: boolean;
  user: string;
  pass: string;
  from: string;
  allowedFrom?: string[];
}

/** Result of an SMTP send. */
export interface SmtpSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Environment variables consumed by {@link resolveSmtpConfig}. Documented here
 * (and in the README) so the error path can point users at exactly what to set.
 */
export const SMTP_ENV = {
  host: "APPLE_MAIL_MCP_SMTP_HOST",
  port: "APPLE_MAIL_MCP_SMTP_PORT",
  secure: "APPLE_MAIL_MCP_SMTP_SECURE",
  allowPlaintext: "APPLE_MAIL_MCP_SMTP_ALLOW_PLAINTEXT",
  user: "APPLE_MAIL_MCP_SMTP_USER",
  from: "APPLE_MAIL_MCP_SMTP_FROM",
  allowedFrom: "APPLE_MAIL_MCP_SMTP_ALLOWED_FROM",
  password: "APPLE_MAIL_MCP_SMTP_PASSWORD",
  keychainService: "APPLE_MAIL_MCP_SMTP_KEYCHAIN_SERVICE",
  keychainAccount: "APPLE_MAIL_MCP_SMTP_KEYCHAIN_ACCOUNT",
} as const;

/**
 * Cheap check for whether the SMTP transport is configured at all, i.e. the two
 * required settings ({@link SMTP_ENV.host} and {@link SMTP_ENV.user}) are
 * present. Used to auto-prefer SMTP over AppleScript when no transport is
 * explicitly requested, and by `doctor`. Does NOT touch the Keychain or verify
 * the password — a misconfigured password still surfaces a clear error at send
 * time via {@link resolveSmtpConfig}.
 */
export function isSmtpConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[SMTP_ENV.host]?.trim() && env[SMTP_ENV.user]?.trim());
}

/**
 * Decides whether `send-email` should use the SMTP transport for this call.
 *
 * - explicit `"smtp"` → always SMTP (config errors surface, no fallback);
 * - explicit `"applescript"` → always the Mail.app path;
 * - omitted → SMTP when configured, **except** when a non-email `account` label
 *   (a Mail.app account name such as `"Work"`) is supplied. That requests
 *   account-based sending, which only the AppleScript path can do, so we honor
 *   the caller's intent instead of silently switching their account. An
 *   `account` that is an email address is treated as a From override and does
 *   not block SMTP.
 */
export function shouldUseSmtp(
  transport: "applescript" | "smtp" | undefined,
  account: string | undefined,
  configured: boolean = isSmtpConfigured()
): boolean {
  if (transport === "smtp") return true;
  if (transport === "applescript") return false;
  if (!configured) return false;
  const isAccountLabel = Boolean(account && !account.includes("@"));
  return !isAccountLabel;
}

/**
 * Reads a password from the macOS login Keychain via the `security` CLI.
 *
 * Tries `find-internet-password` first (where Mail.app stores account
 * passwords) and falls back to `find-generic-password`. Returns null if no
 * matching item exists or the lookup fails for any reason — callers fall back
 * to the password env var and ultimately surface a clear configuration error.
 *
 * @param service - Keychain service / server name (typically the SMTP host)
 * @param account - Keychain account (typically the SMTP username)
 */
export function readKeychainPassword(service: string, account: string): string | null {
  for (const kind of ["find-internet-password", "find-generic-password"] as const) {
    try {
      const out = execFileSync("security", [kind, "-s", service, "-a", account, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const pass = out.replace(/\n$/, "");
      if (pass) return pass;
    } catch {
      // Not found via this kind; try the next.
    }
  }
  return null;
}

/**
 * Resolves SMTP connection configuration from environment + Keychain.
 *
 * @throws Error with an actionable message listing the missing settings.
 */
export function resolveSmtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig {
  const host = env[SMTP_ENV.host]?.trim();
  const user = env[SMTP_ENV.user]?.trim();

  const missing: string[] = [];
  if (!host) missing.push(SMTP_ENV.host);
  if (!user) missing.push(SMTP_ENV.user);
  if (missing.length > 0) {
    throw new Error(
      `SMTP transport is not configured. Set ${missing.join(" and ")} ` +
        `(plus a password via ${SMTP_ENV.password} or the Keychain). ` +
        SETUP_HINT
    );
  }

  // secure=true => implicit TLS (port 465); otherwise STARTTLS (port 587).
  const secure = /^(1|true|yes)$/i.test(env[SMTP_ENV.secure]?.trim() ?? "");
  const port = env[SMTP_ENV.port]
    ? Number.parseInt(env[SMTP_ENV.port] as string, 10)
    : secure
      ? 465
      : 587;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid ${SMTP_ENV.port}: "${env[SMTP_ENV.port]}" is not a valid port.`);
  }

  const from = env[SMTP_ENV.from]?.trim() || (user as string);
  const allowedFrom = (env[SMTP_ENV.allowedFrom] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  // Password: explicit env var wins, otherwise Keychain (service/account
  // default to the host/user but can be overridden).
  let pass = env[SMTP_ENV.password];
  if (!pass) {
    const service = env[SMTP_ENV.keychainService]?.trim() || (host as string);
    const account = env[SMTP_ENV.keychainAccount]?.trim() || (user as string);
    pass = readKeychainPassword(service, account) ?? undefined;
  }
  if (!pass) {
    throw new Error(
      `No SMTP password found. Set ${SMTP_ENV.password}, or store an internet ` +
        `password in the Keychain for service "${
          env[SMTP_ENV.keychainService]?.trim() || host
        }" / account "${env[SMTP_ENV.keychainAccount]?.trim() || user}". ` +
        SETUP_HINT
    );
  }

  const allowPlaintext = /^(1|true|yes|on)$/i.test(env[SMTP_ENV.allowPlaintext]?.trim() ?? "");
  return {
    host: host as string,
    port,
    secure,
    allowPlaintext,
    user: user as string,
    pass,
    from,
    allowedFrom,
  };
}

/**
 * Validates attachment paths the same way the AppleScript path does: absolute
 * and existing. Returns nodemailer attachment descriptors.
 */
function buildAttachments(attachments?: AttachmentInput[]) {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((a) => {
    if (typeof a === "string") {
      if (!isAbsolute(a)) throw new Error(`Attachment path must be absolute: "${a}"`);
      if (!existsSync(a)) throw new Error(`Attachment file not found: "${a}"`);
      return { path: a };
    }
    if (!a.filename || !a.contentBase64) {
      throw new Error("Inline attachment requires both filename and contentBase64.");
    }
    return { filename: a.filename, content: decodeInlineAttachment(a.contentBase64) };
  });
}

/**
 * Sends an email over SMTP, producing clean MIME with no blockquote wrapping.
 *
 * Config is resolved via {@link resolveSmtpConfig} unless one is injected (the
 * `config` parameter exists for testing). The body is sent as plain text; pass
 * a transporter factory only in tests.
 */
export async function sendViaSmtp(
  opts: SmtpSendOptions,
  config?: SmtpConfig,
  createTransport: typeof nodemailer.createTransport = nodemailer.createTransport
): Promise<SmtpSendResult> {
  let cfg: SmtpConfig;
  try {
    cfg = config ?? resolveSmtpConfig();
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }

  const requestedFrom = opts.from?.trim();
  const allowedFrom = new Set(
    [cfg.user, cfg.from, ...(cfg.allowedFrom ?? [])].map((value) => value.trim().toLowerCase())
  );
  if (requestedFrom && !allowedFrom.has(requestedFrom.toLowerCase())) {
    return {
      success: false,
      error: `SMTP From "${requestedFrom}" is not a configured sender identity.`,
    };
  }

  let attachments;
  try {
    attachments = buildAttachments(opts.attachments);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }

  const requireTLS = !cfg.secure && !cfg.allowPlaintext;
  if (!cfg.secure && cfg.allowPlaintext) {
    console.warn(
      `SMTP plaintext explicitly enabled via ${SMTP_ENV.allowPlaintext}; credentials and message content may be exposed.`
    );
  }
  const transporter = createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    // Port 587/143-style configurations must not silently downgrade to
    // plaintext when the server advertises no usable TLS upgrade.
    requireTLS,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  const html = opts.htmlBody?.trim() ? opts.htmlBody : undefined;

  try {
    const info = await transporter.sendMail({
      from: requestedFrom || cfg.from,
      to: opts.to,
      cc: opts.cc,
      bcc: opts.bcc,
      subject: opts.subject,
      text: opts.body,
      // When present, nodemailer emits multipart/alternative (text + html).
      html,
      attachments,
      // RFC 5322 threading for SMTP replies/forwards (2.5.0).
      inReplyTo: opts.inReplyTo?.trim() || undefined,
      references: opts.references?.length ? opts.references : undefined,
    });
    return { success: true, messageId: info.messageId };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const tlsHint = requireTLS
      ? ` STARTTLS is required for non-implicit TLS; to explicitly allow plaintext (not recommended), set ${SMTP_ENV.allowPlaintext}=1.`
      : "";
    return {
      success: false,
      error: `SMTP send failed: ${detail}.${tlsHint}`,
    };
  } finally {
    transporter.close();
  }
}

/** One recipient of a mail-merge batch (mirrors the AppleScript serial path). */
export interface SerialSmtpRecipient {
  email: string;
  variables: Record<string, string>;
}

/** Per-recipient outcome of a serial SMTP send. */
export interface SerialSmtpResult {
  email: string;
  success: boolean;
  error?: string;
}

/**
 * Replace every `{{Key}}` token in `template` with the matching value from
 * `variables`. Keys are escaped so regex metacharacters in a key are literal.
 * Mirrors the substitution in {@link AppleMailManager.sendSerialEmail} so the
 * two transports personalize identically.
 */
export function applyPlaceholders(template: string, variables: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(variables)) {
    const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\{\\{${safeKey}\\}\\}`, "g"), value);
  }
  return out;
}

/**
 * Send a personalized mail-merge batch over SMTP — one individual message per
 * recipient (recipients never see each other), with `{{Key}}` placeholders in
 * the subject/body replaced per recipient. Returns a per-recipient result list;
 * a single recipient's failure does not abort the batch.
 *
 * `opts.send` and `opts.sleep` are injectable for tests (no real SMTP / no real
 * delay). The default `sleep` waits `delayMs` (clamped 0–10000) between sends.
 */
export async function sendSerialViaSmtp(
  recipients: SerialSmtpRecipient[],
  subject: string,
  body: string,
  config: SmtpConfig,
  opts: {
    delayMs?: number;
    send?: typeof sendViaSmtp;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<SerialSmtpResult[]> {
  const send = opts.send ?? sendViaSmtp;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delay = Math.min(Math.max(opts.delayMs ?? 500, 0), 10000);

  const results: SerialSmtpResult[] = [];
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    try {
      const res = await send(
        {
          to: [r.email],
          subject: applyPlaceholders(subject, r.variables),
          body: applyPlaceholders(body, r.variables),
          from: config.from,
        },
        config
      );
      results.push({ email: r.email, success: res.success, error: res.error });
    } catch (error) {
      results.push({
        email: r.email,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (delay > 0 && i < recipients.length - 1) {
      await sleep(delay);
    }
  }
  return results;
}
