/** Mail-merge transport selection and responses, isolated from server startup. */
import type { AppleMailManager } from "@/services/appleMailManager.js";
import {
  shouldUseSmtp,
  resolveSmtpFrom,
  smtpDeliveryFields,
  smtpDeliveryNotice,
  type SmtpConfig,
  type sendSerialViaSmtp,
} from "@/services/smtpMailer.js";
import type { SerialEmailRecipient, SerialEmailResult } from "@/types.js";
import { errorResponse, successResponse, withErrorHandling } from "@/tools/respond.js";

export interface SerialEmailDeps {
  smtpConfigured: () => boolean;
  smtpConfig: () => SmtpConfig;
  smtpSend: typeof sendSerialViaSmtp;
  appleScriptSend: AppleMailManager["sendSerialEmail"];
}

type SerialEmailArgs = {
  recipients: SerialEmailRecipient[];
  subject: string;
  body: string;
  account?: string;
  transport?: "smtp" | "applescript";
  delayMs?: number;
};

export function createSerialEmailHandler(deps: SerialEmailDeps) {
  return withErrorHandling(
    async ({ recipients, subject, body, account, transport, delayMs }: SerialEmailArgs) => {
      const useSmtp = shouldUseSmtp(transport, account, deps.smtpConfigured());
      // Selecting SMTP commits this batch to that transport. A credential/config
      // error must reach the tool's error response before any message is submitted;
      // switching to Mail.app could change both the sender and delivery format.
      let results: SerialEmailResult[];
      if (useSmtp) {
        if (account && !account.includes("@")) {
          throw new Error(
            "A Mail.app account label cannot select an SMTP identity. Use a configured " +
              "sender email address, omit account to use the configured SMTP sender, " +
              "or explicitly select transport=applescript."
          );
        }
        const config = deps.smtpConfig();
        // Validate the whole batch's sender before invoking either send backend.
        // Keep the original config: changing config.from would widen its allowlist.
        const from = account ? resolveSmtpFrom(account, config) : undefined;
        results = await deps.smtpSend(recipients, subject, body, config, {
          delayMs,
          ...(from ? { from } : {}),
        });
      } else {
        results = deps.appleScriptSend(recipients, subject, body, account, delayMs);
      }
      const successCount = results.filter((r) => r.success && !r.deliveryUnknown).length;
      const unknownCount = results.filter((r) => r.deliveryUnknown).length;
      const failCount = results.length - successCount - unknownCount;
      const partialCount = results.filter((r) => r.partial && !r.deliveryUnknown).length;

      const details = results
        .map(
          (r) =>
            `  - ${r.email}: ${r.deliveryUnknown || r.partial ? smtpDeliveryNotice(r) : r.success ? "sent" : `FAILED (${r.error})`}`
        )
        .join("\n");
      const structured = {
        ok: failCount === 0 && partialCount === 0 && unknownCount === 0,
        sent: successCount,
        failed: failCount,
        partial: partialCount > 0 || (successCount > 0 && failCount + unknownCount > 0),
        ...(unknownCount ? { unknown: unknownCount, deliveryUnknown: true } : {}),
        transport: useSmtp ? "smtp" : "applescript",
        results: results.map((r) => ({
          email: r.email,
          success: r.success,
          error: r.error,
          ...smtpDeliveryFields(r),
        })),
      };

      if (unknownCount > 0) {
        return successResponse(
          `SMTP confirmed ${successCount} submission(s), ${failCount} known failure(s), and ${unknownCount} unknown outcome(s):\n${details}`,
          structured
        );
      } else if (partialCount > 0) {
        return successResponse(
          `SMTP accepted ${successCount} submission(s), including ${partialCount} with rejected recipients; ${failCount} submission(s) failed:\n${details}`,
          structured
        );
      } else if (failCount === 0) {
        return successResponse(
          `Successfully sent ${successCount} email(s):\n${details}`,
          structured
        );
      } else if (successCount === 0) {
        return errorResponse(`Failed to send all ${failCount} email(s):\n${details}`, structured);
      } else {
        return successResponse(
          `Sent ${successCount} of ${results.length} email(s), ${failCount} failed:\n${details}`,
          structured
        );
      }
    },
    "Error sending serial emails"
  );
}
