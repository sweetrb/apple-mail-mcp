/**
 * Setup "doctor" (C3): one diagnostic that checks the things that actually break
 * an apple-mail-mcp setup — Mail.app automation permission, account state, and
 * the optional IMAP/SMTP backends — and reports each as ok / warn / fail with an
 * actionable message, instead of failing opaquely deep in a tool call.
 *
 * @module tools/doctor
 */
import type { AppleMailManager } from "../services/appleMailManager.js";
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
export declare function runDoctor(mailManager: AppleMailManager): Promise<DoctorReport>;
/** Render a DoctorReport as readable text. */
export declare function formatDoctorReport(r: DoctorReport): string;
//# sourceMappingURL=doctor.d.ts.map