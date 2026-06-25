#!/usr/bin/env node
import { sendViaSmtp, resolveSmtpConfig } from "./services/smtpMailer.js";
/** sysexits.h codes used so callers can distinguish failure modes. */
export declare const EX_USAGE = 64;
export declare const EX_NOINPUT = 66;
export declare const EX_CONFIG = 78;
/** Injectable dependencies, defaulted to the real implementations. */
export interface CliDeps {
    send?: typeof sendViaSmtp;
    resolveConfig?: typeof resolveSmtpConfig;
    readTextFile?: (path: string) => string;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    env?: NodeJS.ProcessEnv;
}
/**
 * Parses argv, sends the email, and returns a process exit code. Pure with
 * respect to its deps (no direct process/console access) so it can be unit
 * tested without the network or Keychain.
 *
 * @param argv - arguments AFTER `node cli.js` (i.e. `process.argv.slice(2)`)
 */
export declare function runCli(argv: string[], deps?: CliDeps): Promise<number>;
//# sourceMappingURL=cli.d.ts.map