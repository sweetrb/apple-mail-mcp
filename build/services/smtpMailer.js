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
/**
 * Environment variables consumed by {@link resolveSmtpConfig}. Documented here
 * (and in the README) so the error path can point users at exactly what to set.
 */
export const SMTP_ENV = {
    host: "APPLE_MAIL_MCP_SMTP_HOST",
    port: "APPLE_MAIL_MCP_SMTP_PORT",
    secure: "APPLE_MAIL_MCP_SMTP_SECURE",
    user: "APPLE_MAIL_MCP_SMTP_USER",
    from: "APPLE_MAIL_MCP_SMTP_FROM",
    password: "APPLE_MAIL_MCP_SMTP_PASSWORD",
    keychainService: "APPLE_MAIL_MCP_SMTP_KEYCHAIN_SERVICE",
    keychainAccount: "APPLE_MAIL_MCP_SMTP_KEYCHAIN_ACCOUNT",
};
/**
 * Cheap check for whether the SMTP transport is configured at all, i.e. the two
 * required settings ({@link SMTP_ENV.host} and {@link SMTP_ENV.user}) are
 * present. Used to auto-prefer SMTP over AppleScript when no transport is
 * explicitly requested, and by `doctor`. Does NOT touch the Keychain or verify
 * the password — a misconfigured password still surfaces a clear error at send
 * time via {@link resolveSmtpConfig}.
 */
export function isSmtpConfigured(env = process.env) {
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
export function shouldUseSmtp(transport, account, configured = isSmtpConfigured()) {
    if (transport === "smtp")
        return true;
    if (transport === "applescript")
        return false;
    if (!configured)
        return false;
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
export function readKeychainPassword(service, account) {
    for (const kind of ["find-internet-password", "find-generic-password"]) {
        try {
            const out = execFileSync("security", [kind, "-s", service, "-a", account, "-w"], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            });
            const pass = out.replace(/\n$/, "");
            if (pass)
                return pass;
        }
        catch {
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
export function resolveSmtpConfig(env = process.env) {
    const host = env[SMTP_ENV.host]?.trim();
    const user = env[SMTP_ENV.user]?.trim();
    const missing = [];
    if (!host)
        missing.push(SMTP_ENV.host);
    if (!user)
        missing.push(SMTP_ENV.user);
    if (missing.length > 0) {
        throw new Error(`SMTP transport is not configured. Set ${missing.join(" and ")} ` +
            `(plus a password via ${SMTP_ENV.password} or the Keychain). ` +
            `See the README "SMTP transport" section.`);
    }
    // secure=true => implicit TLS (port 465); otherwise STARTTLS (port 587).
    const secure = /^(1|true|yes)$/i.test(env[SMTP_ENV.secure]?.trim() ?? "");
    const port = env[SMTP_ENV.port]
        ? Number.parseInt(env[SMTP_ENV.port], 10)
        : secure
            ? 465
            : 587;
    if (!Number.isInteger(port) || port <= 0) {
        throw new Error(`Invalid ${SMTP_ENV.port}: "${env[SMTP_ENV.port]}" is not a valid port.`);
    }
    const from = env[SMTP_ENV.from]?.trim() || user;
    // Password: explicit env var wins, otherwise Keychain (service/account
    // default to the host/user but can be overridden).
    let pass = env[SMTP_ENV.password];
    if (!pass) {
        const service = env[SMTP_ENV.keychainService]?.trim() || host;
        const account = env[SMTP_ENV.keychainAccount]?.trim() || user;
        pass = readKeychainPassword(service, account) ?? undefined;
    }
    if (!pass) {
        throw new Error(`No SMTP password found. Set ${SMTP_ENV.password}, or store an internet ` +
            `password in the Keychain for service "${env[SMTP_ENV.keychainService]?.trim() || host}" / account "${env[SMTP_ENV.keychainAccount]?.trim() || user}".`);
    }
    return { host: host, port, secure, user: user, pass, from };
}
/**
 * Validates attachment paths the same way the AppleScript path does: absolute
 * and existing. Returns nodemailer attachment descriptors.
 */
function buildAttachments(attachments) {
    if (!attachments || attachments.length === 0)
        return undefined;
    return attachments.map((a) => {
        if (typeof a === "string") {
            if (!isAbsolute(a))
                throw new Error(`Attachment path must be absolute: "${a}"`);
            if (!existsSync(a))
                throw new Error(`Attachment file not found: "${a}"`);
            return { path: a };
        }
        if (!a.filename || !a.contentBase64) {
            throw new Error("Inline attachment requires both filename and contentBase64.");
        }
        return { filename: a.filename, content: Buffer.from(a.contentBase64, "base64") };
    });
}
/**
 * Sends an email over SMTP, producing clean MIME with no blockquote wrapping.
 *
 * Config is resolved via {@link resolveSmtpConfig} unless one is injected (the
 * `config` parameter exists for testing). The body is sent as plain text; pass
 * a transporter factory only in tests.
 */
export async function sendViaSmtp(opts, config, createTransport = nodemailer.createTransport) {
    let cfg;
    try {
        cfg = config ?? resolveSmtpConfig();
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    let attachments;
    try {
        attachments = buildAttachments(opts.attachments);
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    const transporter = createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: { user: cfg.user, pass: cfg.pass },
    });
    const html = opts.htmlBody?.trim() ? opts.htmlBody : undefined;
    try {
        const info = await transporter.sendMail({
            from: opts.from?.trim() || cfg.from,
            to: opts.to,
            cc: opts.cc,
            bcc: opts.bcc,
            subject: opts.subject,
            text: opts.body,
            // When present, nodemailer emits multipart/alternative (text + html).
            html,
            attachments,
        });
        return { success: true, messageId: info.messageId };
    }
    catch (error) {
        return {
            success: false,
            error: `SMTP send failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    finally {
        transporter.close();
    }
}
