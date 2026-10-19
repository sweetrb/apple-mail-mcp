/**
 * saveAttachment resolves the message the way the reads do.
 *
 * Mail numbers messages per mailbox and a label store (Gmail, iCloud) repeats
 * one id in INBOX, Important and All Mail. The save used to walk every mailbox
 * of every account and save from the first message with that id, so it could
 * write a different message's attachment. It now saves from the mailbox the
 * guarded by-id lookup found, and saves nothing when the id is ambiguous.
 * Both only build and run AppleScript, so the script is what is checked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const h = vi.hoisted(() => ({ scripts: [] as string[], output: "" }));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string) => {
      h.scripts.push(script);
      return { success: true, output: h.output };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

type Internals = {
  getCachedAccounts: () => unknown;
  resolveMailbox: (mailbox: string, account: string) => string;
};

/** The by-id error prefix. */
const ERR = "\x1dERR\x1d";

afterEach(() => {
  h.scripts.length = 0;
  h.output = "";
});

function manager(): AppleMailManager {
  const mgr = new AppleMailManager();
  const internals = mgr as unknown as Internals;
  vi.spyOn(internals, "getCachedAccounts").mockReturnValue([
    { name: "Nopuedomas", email: "jap@nopuedomas.example", enabled: true },
  ]);
  vi.spyOn(internals, "resolveMailbox").mockImplementation((mailbox) => mailbox);
  return mgr;
}

function saveInto(mgr: AppleMailManager): boolean {
  // Any visible save root will do; the home keeps the test inside a sandboxed run.
  const dir = mkdtempSync(join(homedir(), "amcp-save-"));
  try {
    return mgr.saveAttachment("538208", "a.pdf", dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("saveAttachment resolves the message the way the reads do", () => {
  it("saves from the mailbox the lookup found, not from the first one holding the id", () => {
    h.output = "Nopuedomas\x1fINBOX";
    saveInto(manager());
    const save = h.scripts.find((s) => s.includes("save att in savePath")) ?? "";
    expect(save).toContain('first account whose name is "Nopuedomas"');
    expect(save).not.toContain("repeat with acct in accounts");
  });

  it("refuses an id that several mailboxes hold and saves nothing", () => {
    h.output = `${ERR}Message 538208 is present in more than one mailbox (A/INBOX, A/All Mail); list or search that mailbox first so the read targets the right copy`;
    expect(saveInto(manager())).toBe(false);
    expect(h.scripts.some((s) => s.includes("save att in savePath"))).toBe(false);
  });
});
