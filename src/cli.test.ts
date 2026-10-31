/**
 * Tests for the standalone `apple-mail-send` CLI.
 *
 * runCli is exercised with injected deps (a fake sender, a fake file reader,
 * captured stdout/stderr) so nothing touches the network, Keychain, or disk.
 */
import { describe, it, expect, vi } from "vitest";
import { runCli, EX_USAGE, EX_NOINPUT, EX_CONFIG, type CliDeps } from "./cli.js";
import type { SmtpConfig } from "./smtpMailer.js";
import nodemailer from "nodemailer";
import { sendViaSmtp } from "@/services/smtpMailer.js";
import { withSmtpFixture } from "@/services/smtpMailer.testFixture.js";

const FAKE_CONFIG: SmtpConfig = {
  host: "smtp.example.com",
  port: 587,
  secure: false,
  user: "me@example.com",
  pass: "s3cret",
  from: "me@example.com",
};

/** Builds deps with sensible test defaults; override per case. */
function makeDeps(over: Partial<CliDeps> = {}): {
  deps: CliDeps;
  send: ReturnType<typeof vi.fn>;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const send = vi.fn().mockResolvedValue({ success: true, messageId: "<id>" });
  const deps: CliDeps = {
    send: send as never,
    resolveConfig: () => FAKE_CONFIG,
    readTextFile: (p: string) => `contents-of:${p}`,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    env: {},
    ...over,
  };
  return { deps, send, out, err };
}

const REQUIRED = [
  "--from",
  "me@example.com",
  "--to",
  "you@example.com",
  "--subject",
  "Hi",
  "--body-file",
  "/tmp/body.txt",
];

describe("runCli", () => {
  it.each([
    { name: "all accepted", refused: [], finalReply: "accept" as const, code: 0, count: 1 },
    {
      name: "partial",
      refused: ["refused@example.test"],
      finalReply: "accept" as const,
      code: 2,
      count: 1,
    },
    {
      name: "all refused",
      refused: ["accepted@example.test", "refused@example.test"],
      finalReply: "accept" as const,
      code: 1,
      count: 0,
    },
    {
      name: "lost final acknowledgment",
      refused: [],
      finalReply: "close-after-data" as const,
      code: 3,
      count: 1,
    },
  ])(
    "propagates real loopback $name without retrying",
    async ({ refused, finalReply, code, count }) => {
      await withSmtpFixture(
        refused,
        async (config, submissions) => {
          const sender = vi.fn((opts, cfg) =>
            sendViaSmtp(opts, cfg, nodemailer.createTransport, async () => ({}))
          );
          const { deps, out, err } = makeDeps({ resolveConfig: () => config, send: sender });
          const argv = [
            "--from",
            "fixture@example.test",
            "--to",
            "accepted@example.test",
            "--to",
            "refused@example.test",
            "--subject",
            "Fixture",
            "--body-file",
            "/tmp/body.txt",
          ];
          expect(await runCli(argv, deps)).toBe(code);
          expect(submissions).toHaveLength(count);
          expect(sender).toHaveBeenCalledOnce();
          if (code === 2) expect(err.join("\n")).toContain("Do not resend to accepted recipients");
          if (code === 3) {
            expect(out).toEqual([]);
            expect(err.join("\n")).toContain("outcome is unknown");
          }
        },
        finalReply
      );
    }
  );

  it.each(["returned", "thrown"])(
    "returns a distinct unknown status without a sent claim or retry after a %s lost acknowledgment",
    async (mode) => {
      const { deps, send, out, err } = makeDeps();
      if (mode === "returned")
        send.mockResolvedValue({
          success: false,
          deliveryUnknown: true,
          error: "Connection closed",
        });
      else send.mockRejectedValue(new Error("Connection closed"));
      expect(await runCli(REQUIRED, deps)).toBe(3);
      expect(out).toEqual([]);
      expect(err.join("\n")).toContain("outcome is unknown");
      expect(err.join("\n")).toContain("Do not resend automatically");
      expect(send).toHaveBeenCalledOnce();
    }
  );

  it("returns a distinct partial status and names accepted recipients without inviting a full resend", async () => {
    const { deps, send, out, err } = makeDeps();
    send.mockResolvedValue({
      success: true,
      partial: true,
      accepted: ["you@example.com"],
      rejected: ["refused@example.com"],
    });
    const code = await runCli([...REQUIRED, "--to", "refused@example.com"], deps);
    expect(code).toBe(2);
    expect(out.join("\n")).toContain("sent to you@example.com");
    expect(out.join("\n")).not.toContain("refused@example.com");
    expect(err.join("\n")).toContain("Partial SMTP submission");
    expect(err.join("\n")).toContain("Rejected: refused@example.com");
    expect(err.join("\n")).toContain("Do not resend to accepted recipients");
    expect(send).toHaveBeenCalledOnce();
  });

  it("sends a plain-text email and reports success (exit 0)", async () => {
    const { deps, send, out } = makeDeps();
    const code = await runCli(REQUIRED, deps);

    expect(code).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      from: "me@example.com",
      to: ["you@example.com"],
      subject: "Hi",
      body: "contents-of:/tmp/body.txt",
    });
    expect(send.mock.calls[0][0].htmlBody).toBeUndefined();
    expect(out.join("\n")).toMatch(/sent to you@example.com/);
  });

  it("reads an HTML alternative body and multiple recipients/attachments", async () => {
    const { deps, send } = makeDeps();
    const code = await runCli(
      [
        ...REQUIRED,
        "--to",
        "second@example.com",
        "--cc",
        "cc@example.com",
        "--bcc",
        "bcc@example.com",
        "--html-body-file",
        "/tmp/body.html",
        "--attach",
        "/abs/a.png",
        "--attach",
        "/abs/b.pdf",
      ],
      deps
    );

    expect(code).toBe(0);
    const opts = send.mock.calls[0][0];
    expect(opts.to).toEqual(["you@example.com", "second@example.com"]);
    expect(opts.cc).toEqual(["cc@example.com"]);
    expect(opts.bcc).toEqual(["bcc@example.com"]);
    expect(opts.htmlBody).toBe("contents-of:/tmp/body.html");
    expect(opts.attachments).toEqual(["/abs/a.png", "/abs/b.pdf"]);
  });

  it("returns EX_CONFIG (78) and does not send when host/user are unconfigured", async () => {
    const { deps, send, err } = makeDeps({
      resolveConfig: () => {
        throw new Error("SMTP transport is not configured. Set HOST and USER.");
      },
    });
    const code = await runCli(REQUIRED, deps);

    expect(code).toBe(EX_CONFIG);
    expect(send).not.toHaveBeenCalled();
    expect(err.join("\n")).toMatch(/not configured/i);
  });

  it("returns EX_CONFIG (78) when only the Keychain password is missing", async () => {
    // The UX fix: a missing password is a setup problem, not a generic failure,
    // so it maps to 78 (callers branch on it to print Keychain setup help).
    const { deps, send, err } = makeDeps({
      resolveConfig: () => {
        throw new Error('No SMTP password found. Store one for "apple-mail-mcp-smtp".');
      },
    });
    const code = await runCli(REQUIRED, deps);

    expect(code).toBe(EX_CONFIG);
    expect(send).not.toHaveBeenCalled();
    expect(err.join("\n")).toMatch(/no smtp password/i);
  });

  it("returns EX_USAGE (64) when a required arg is missing", async () => {
    const { deps, send } = makeDeps();
    const code = await runCli(["--from", "me@example.com", "--subject", "Hi"], deps);

    expect(code).toBe(EX_USAGE);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns EX_USAGE (64) on an unknown flag", async () => {
    const { deps } = makeDeps();
    const code = await runCli([...REQUIRED, "--nope"], deps);
    expect(code).toBe(EX_USAGE);
  });

  it("returns EX_NOINPUT (66) when the body file cannot be read", async () => {
    const { deps, send } = makeDeps({
      readTextFile: () => {
        throw new Error("ENOENT");
      },
    });
    const code = await runCli(REQUIRED, deps);

    expect(code).toBe(EX_NOINPUT);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns 1 and surfaces the error when the send fails", async () => {
    const { deps, err } = makeDeps({
      send: vi.fn().mockResolvedValue({ success: false, error: "SMTP send failed: nope" }) as never,
    });
    const code = await runCli(REQUIRED, deps);

    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/SMTP send failed: nope/);
  });

  it("passes --reply-to through as SmtpSendOptions.replyTo", async () => {
    const { deps, send } = makeDeps();
    const code = await runCli([...REQUIRED, "--reply-to", "support@example.com"], deps);

    expect(code).toBe(0);
    expect(send.mock.calls[0][0].replyTo).toBe("support@example.com");
  });

  it("omits replyTo when --reply-to is not passed", async () => {
    const { deps, send } = makeDeps();
    await runCli(REQUIRED, deps);
    expect(send.mock.calls[0][0].replyTo).toBeUndefined();
  });

  it("reports a filed Sent-folder copy in the success line (issue #220)", async () => {
    const { deps, out } = makeDeps({
      send: vi
        .fn()
        .mockResolvedValue({ success: true, messageId: "<id>", sentCopy: true }) as never,
    });
    const code = await runCli(REQUIRED, deps);

    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/Sent-folder copy filed/);
  });

  it("reports a failed Sent-folder copy without failing the command (issue #220)", async () => {
    const { deps, out } = makeDeps({
      send: vi.fn().mockResolvedValue({
        success: true,
        messageId: "<id>",
        sentCopy: false,
        sentCopyError: "IMAP APPEND failed: NO",
      }) as never,
    });
    const code = await runCli(REQUIRED, deps);

    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/Sent-folder copy NOT filed: IMAP APPEND failed: NO/);
  });

  it("--help prints usage and exits 0 without sending", async () => {
    const { deps, send, out } = makeDeps();
    const code = await runCli(["--help"], deps);

    expect(code).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(out.join("\n")).toMatch(/apple-mail-send/);
    expect(out.join("\n")).toContain("APPLE_MAIL_MCP_SMTP_ALLOWED_FROM");
  });
});
