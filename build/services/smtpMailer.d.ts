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
 * ever placed in config. AppleScript remains the default transport — SMTP is
 * opt-in per call (`transport: "smtp"`).
 *
 * @module services/smtpMailer
 */
import nodemailer from "nodemailer";
/** Options for an SMTP send, mirroring the AppleScript send-email surface. */
export interface SmtpSendOptions {
    to: string[];
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
    /** Overrides the configured From address (must be allowed by the SMTP server). */
    from?: string;
    /** Absolute paths to files to attach. */
    attachments?: string[];
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