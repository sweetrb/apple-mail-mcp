/**
 * Tests for the standalone `apple-mail-send` CLI.
 *
 * runCli is exercised with injected deps (a fake sender, a fake file reader,
 * captured stdout/stderr) so nothing touches the network, Keychain, or disk.
 */
import { describe, it, expect, vi } from "vitest";
import { runCli, EX_USAGE, EX_NOINPUT, EX_CONFIG, type CliDeps } from "./cli.js";
import type { SmtpConfig } from "./smtpMailer.js";

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

  it("--help prints usage and exits 0 without sending", async () => {
    const { deps, send, out } = makeDeps();
    const code = await runCli(["--help"], deps);

    expect(code).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(out.join("\n")).toMatch(/apple-mail-send/);
  });
});
