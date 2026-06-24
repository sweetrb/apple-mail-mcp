#!/usr/bin/env node
/**
 * `apple-mail-send` — standalone clean-SMTP email CLI.
 *
 * A thin command-line front end over {@link sendViaSmtp} so scheduled tasks,
 * cron jobs, and other scripts can send clean MIME (no Mail.app blockquote
 * wrapping, issue #12) WITHOUT a running MCP server. It reuses the exact same
 * SMTP config resolution as the MCP `send-email` tool — env vars first, then the
 * macOS Keychain (see the README "SMTP transport" section).
 *
 * The flag surface intentionally mirrors the legacy nhl-bracket-tracker
 * `send_email.py` (--from/--to/--cc/--bcc/--subject/--body-file/
 * --html-body-file/--attach) and its exit codes (78 = EX_CONFIG when SMTP is
 * not configured) so callers can drop this in as a replacement.
 *
 * Usage:
 *   apple-mail-send --from me@example.com --to you@example.com \
 *     --subject "Hi" --body-file /tmp/body.txt \
 *     [--html-body-file /tmp/body.html] [--attach /tmp/report.pdf]
 *
 * @module cli
 */
import { readFileSync, realpathSync } from "fs";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { sendViaSmtp, resolveSmtpConfig, SMTP_ENV } from "./services/smtpMailer.js";
/** sysexits.h codes used so callers can distinguish failure modes. */
export const EX_USAGE = 64;
export const EX_NOINPUT = 66;
export const EX_CONFIG = 78;
const USAGE = `apple-mail-send — send a clean email via SMTP (no Mail.app blockquote wrapping).

Required:
  --from <addr>         Sender address (must be allowed by the SMTP server)
  --to <addr>           Recipient (repeatable)
  --subject <text>      Subject line
  --body-file <path>    UTF-8 file with the plain-text body

Optional:
  --cc <addr>           CC recipient (repeatable)
  --bcc <addr>          BCC recipient (repeatable)
  --html-body-file <p>  UTF-8 file with an HTML alternative body (sends
                        multipart/alternative)
  --attach <path>       Absolute path to a file to attach (repeatable)
  --help                Show this help

SMTP connection comes from ${SMTP_ENV.host} / ${SMTP_ENV.user} (+ password via
${SMTP_ENV.password} or the macOS Keychain). See the README "SMTP transport".`;
/**
 * Parses argv, sends the email, and returns a process exit code. Pure with
 * respect to its deps (no direct process/console access) so it can be unit
 * tested without the network or Keychain.
 *
 * @param argv - arguments AFTER `node cli.js` (i.e. `process.argv.slice(2)`)
 */
export async function runCli(argv, deps = {}) {
    const send = deps.send ?? sendViaSmtp;
    const resolveConfig = deps.resolveConfig ?? resolveSmtpConfig;
    const readTextFile = deps.readTextFile ?? ((p) => readFileSync(p, "utf8"));
    const out = deps.stdout ?? ((l) => console.log(l));
    const err = deps.stderr ?? ((l) => console.error(l));
    const env = deps.env ?? process.env;
    let values;
    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                from: { type: "string" },
                to: { type: "string", multiple: true },
                cc: { type: "string", multiple: true },
                bcc: { type: "string", multiple: true },
                subject: { type: "string" },
                "body-file": { type: "string" },
                "html-body-file": { type: "string" },
                attach: { type: "string", multiple: true },
                help: { type: "boolean" },
            },
            allowPositionals: false,
        }));
    }
    catch (e) {
        err(e instanceof Error ? e.message : String(e));
        err(USAGE);
        return EX_USAGE;
    }
    if (values.help) {
        out(USAGE);
        return 0;
    }
    const missing = [];
    if (!values.from)
        missing.push("--from");
    if (!values.to || values.to.length === 0)
        missing.push("--to");
    if (!values.subject)
        missing.push("--subject");
    if (!values["body-file"])
        missing.push("--body-file");
    if (missing.length > 0) {
        err(`Missing required argument(s): ${missing.join(", ")}`);
        err(USAGE);
        return EX_USAGE;
    }
    // Resolve the full SMTP config up front (host/user/port + Keychain password)
    // so a missing password counts as EX_CONFIG (78) — the same actionable
    // "needs setup" signal as a missing host/user — rather than a generic failure.
    let config;
    try {
        config = resolveConfig(env);
    }
    catch (e) {
        err(e instanceof Error ? e.message : String(e));
        err(`See the README "SMTP transport" section.`);
        return EX_CONFIG;
    }
    let body;
    let htmlBody;
    try {
        body = readTextFile(values["body-file"]);
        if (values["html-body-file"])
            htmlBody = readTextFile(values["html-body-file"]);
    }
    catch (e) {
        err(`Could not read body file: ${e instanceof Error ? e.message : String(e)}`);
        return EX_NOINPUT;
    }
    const attachments = values.attach?.length
        ? values.attach
        : undefined;
    const result = await send({
        from: values.from,
        to: values.to,
        cc: values.cc,
        bcc: values.bcc,
        subject: values.subject,
        body,
        htmlBody,
        attachments,
    }, config);
    if (!result.success) {
        err(result.error ?? "SMTP send failed.");
        return 1;
    }
    out(`sent to ${values.to.join(", ")} from ${values.from}`);
    return 0;
}
// Entry point when invoked directly (not when imported by tests). Resolve both
// sides through the filesystem so it still matches when launched via the npm
// `bin` symlink (argv[1] is the symlink; import.meta.url is the real build file).
function isInvokedDirectly() {
    if (typeof process === "undefined" || !process.argv?.[1])
        return false;
    try {
        return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
    }
    catch {
        return false;
    }
}
if (isInvokedDirectly()) {
    runCli(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
        console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
        process.exit(1);
    });
}
