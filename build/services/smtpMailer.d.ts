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
import type { AttachmentInput } from "../types.js";
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
}
/** Resolved SMTP connection configuration. */
export interface SmtpConfig {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
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
export declare const SMTP_ENV: {
    readonly host: "APPLE_MAIL_MCP_SMTP_HOST";
    readonly port: "APPLE_MAIL_MCP_SMTP_PORT";
    readonly secure: "APPLE_MAIL_MCP_SMTP_SECURE";
    readonly user: "APPLE_MAIL_MCP_SMTP_USER";
    readonly from: "APPLE_MAIL_MCP_SMTP_FROM";
    readonly password: "APPLE_MAIL_MCP_SMTP_PASSWORD";
    readonly keychainService: "APPLE_MAIL_MCP_SMTP_KEYCHAIN_SERVICE";
    readonly keychainAccount: "APPLE_MAIL_MCP_SMTP_KEYCHAIN_ACCOUNT";
};
/**
 * Cheap check for whether the SMTP transport is configured at all, i.e. the two
 * required settings ({@link SMTP_ENV.host} and {@link SMTP_ENV.user}) are
 * present. Used to auto-prefer SMTP over AppleScript when no transport is
 * explicitly requested, and by `doctor`. Does NOT touch the Keychain or verify
 * the password — a misconfigured password still surfaces a clear error at send
 * time via {@link resolveSmtpConfig}.
 */
export declare function isSmtpConfigured(env?: NodeJS.ProcessEnv): boolean;
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
export declare function shouldUseSmtp(transport: "applescript" | "smtp" | undefined, account: string | undefined, configured?: boolean): boolean;
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
export declare function readKeychainPassword(service: string, account: string): string | null;
/**
 * Resolves SMTP connection configuration from environment + Keychain.
 *
 * @throws Error with an actionable message listing the missing settings.
 */
export declare function resolveSmtpConfig(env?: NodeJS.ProcessEnv): SmtpConfig;
/**
 * Sends an email over SMTP, producing clean MIME with no blockquote wrapping.
 *
 * Config is resolved via {@link resolveSmtpConfig} unless one is injected (the
 * `config` parameter exists for testing). The body is sent as plain text; pass
 * a transporter factory only in tests.
 */
export declare function sendViaSmtp(opts: SmtpSendOptions, config?: SmtpConfig, createTransport?: typeof nodemailer.createTransport): Promise<SmtpSendResult>;
//# sourceMappingURL=smtpMailer.d.ts.map