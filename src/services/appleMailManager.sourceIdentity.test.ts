import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ScriptResult = { success: boolean; output: string; error?: string; timedOut?: boolean };
const h = vi.hoisted(() => ({
  calls: [] as string[],
  result: { success: true, output: "" } as ScriptResult,
  staleLocation: false,
}));
vi.mock("@/utils/applescript.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/applescript.js")>()),
  executeAppleScript: (script: string) => {
    h.calls.push(script);
    if (!script.includes("set _sourceMailbox")) return { success: true, output: "" };
    if (h.staleLocation && script.includes("\x1dSCOPED\x1d")) {
      return { success: true, output: "\x1dERR\x1d\x1dSCOPED\x1dnomessage" };
    }
    return h.result;
  },
}));

import { AppleMailManager } from "./appleMailManager.js";

const raw = "From: sender@example.com\r\nMessage-ID: <bound@example.com>\r\n\r\nBody\x1fbytes";
const sourceCalls = () => h.calls.filter((script) => script.includes("set _sourceMailbox"));

describe("atomic numeric source location for SMTP", () => {
  let manager: AppleMailManager;
  beforeEach(() => {
    h.calls.length = 0;
    h.staleLocation = false;
    h.result = { success: true, output: `Work\x1fProjects/Inbox\x1f${raw}` };
    manager = new AppleMailManager();
  });

  it("reads the source and actual account/mailbox together, preserving the complete source text", () => {
    expect(manager.getRawSourceWithLocation("42")).toEqual({
      account: "Work",
      mailbox: "Projects/Inbox",
      raw,
    });
    expect(sourceCalls()).toHaveLength(1);
    const script = sourceCalls()[0];
    expect(script).toContain(
      'return _hitAcct & "\x1f" & _sourceMailbox & "\x1f" & (source of msg)'
    );
    // Unlike getMessageById's metadata-only firstHit route, an ambiguous source
    // cannot silently bind an arbitrary mailbox before the SMTP sender check.
    expect(script).toContain("if (count of _hits) > 1 then return");
    expect(script).toContain("if (count of _hits) is 1 then");
  });

  it("preserves ambiguity diagnostics and does not substitute the first mailbox", () => {
    h.result.output =
      "\x1dERR\x1dMessage 42 is present in more than one mailbox (Work/Inbox, Personal/Inbox)";
    expect(manager.getRawSourceWithLocation("42")).toBeNull();
    expect(manager.consumeLastMessageLookupError()).toContain("present in more than one mailbox");
    expect(sourceCalls()).toHaveLength(1);
  });

  it("retains the established stale-location fallback while binding the source from the new lookup", () => {
    manager.noteMessageLocation("42", "Old account", "Old folder");
    h.staleLocation = true;
    expect(manager.getRawSourceWithLocation("42")).toEqual({
      account: "Work",
      mailbox: "Projects/Inbox",
      raw,
    });
    expect(sourceCalls()).toHaveLength(2);
    expect(sourceCalls()[0]).toContain("\x1dSCOPED\x1d");
    expect(sourceCalls()[1]).toContain("if (count of _hits) > 1 then return");
  });

  it("reports a timeout without adding a second source scan", () => {
    h.result = { success: false, output: "", timedOut: true, error: "timed out" };
    expect(manager.getRawSourceWithLocation("42")).toBeNull();
    expect(manager.consumeLastMessageLookupError()).toContain("timed out");
    expect(sourceCalls()).toHaveLength(1);
  });

  it.each([
    "invalid-source-scope",
    `\x1fInbox\x1f${raw}`,
    `Work\x1f\x1f${raw}`,
    "Work\x1fInbox\x1f   ",
  ])("refuses missing or malformed source ownership: %j", (output) => {
    h.result.output = output;
    expect(manager.getRawSourceWithLocation("42")).toBeNull();
    expect(manager.consumeLastMessageLookupError()).toContain(
      "source with its account and mailbox"
    );
  });

  it("keeps a local mailbox explicitly local rather than guessing an account from From", () => {
    h.result.output = `On My Mac\x1fArchive\x1f${raw}`;
    expect(manager.getRawSourceWithLocation("42")).toEqual({
      account: "On My Mac",
      mailbox: "Archive",
      raw,
    });
  });

  it.skipIf(process.platform !== "darwin").each([
    { label: "unscoped strict lookup", scope: undefined },
    { label: "remembered account", scope: { account: "Work", mailbox: "Projects/Inbox" } },
    { label: "local mailbox", scope: { account: "On My Mac", mailbox: "Archive" } },
  ])(
    "compiles the production source accessor against Mail's dictionary: $label",
    ({ scope }) => {
      if (scope) manager.noteMessageLocation("42", scope.account, scope.mailbox);
      manager.getRawSourceWithLocation("42");
      const scripts = sourceCalls();
      expect(scripts).toHaveLength(1);
      const directory = mkdtempSync(join(tmpdir(), "amcp-source-compile-"));
      try {
        // Compile the generated script without executing it. This checks Mail's
        // real terminology on macOS without opening or reading any mailbox.
        const result = spawnSync(
          "/usr/bin/osacompile",
          ["-o", join(directory, "source.scpt"), "-"],
          { input: scripts[0], encoding: "utf8", timeout: 15000 }
        );
        expect(result.status, result.stderr || result.error?.message).toBe(0);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    20000
  );
});
