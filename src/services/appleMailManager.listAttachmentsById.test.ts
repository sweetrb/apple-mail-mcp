/**
 * listAttachments resolves the message the way the reads do.
 *
 * Mail numbers messages per mailbox, so one id can exist in several. The list
 * used to answer for the first mailbox that held the id. It now looks in the
 * mailbox the id was listed from, else uses the bounded by-id scan, and refuses
 * an id that several mailboxes hold. Both only build and run AppleScript, so the
 * script is what is checked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ scripts: [] as string[], output: "", source: "" }));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string) => {
      h.scripts.push(script);
      // The raw-source fallback asks for `source of msg`; everything else gets `output`.
      const isSource = script.includes("return source of msg");
      return { success: true, output: isSource ? h.source : h.output };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

type Internals = {
  getCachedAccounts: () => unknown;
  resolveMailbox: (mailbox: string, account: string) => string;
};

/** What the attachment lookup leads its answer with, and the by-id error prefix. */
const FOUND = "\x1dATT\x1d";
const ERR = "\x1dERR\x1d";

afterEach(() => {
  h.scripts.length = 0;
  h.output = "";
  h.source = "";
});

function manager(location?: { account: string; mailbox: string }): AppleMailManager {
  const mgr = new AppleMailManager();
  const internals = mgr as unknown as Internals;
  vi.spyOn(internals, "getCachedAccounts").mockReturnValue([
    { name: "Nopuedomas", email: "jap@nopuedomas.example", enabled: true },
  ]);
  vi.spyOn(internals, "resolveMailbox").mockImplementation((mailbox) => mailbox);
  if (location) mgr.noteMessageLocation("538208", location.account, location.mailbox);
  return mgr;
}

describe("listAttachments mailbox binding", () => {
  it("looks only in the mailbox the id was listed from", () => {
    h.output = `${FOUND}a.pdf\x1fapplication/pdf\x1f10`;
    const found = manager({ account: "Nopuedomas", mailbox: "INBOX" }).listAttachments("538208");
    expect(found).toEqual([
      { id: "538208-a.pdf", name: "a.pdf", mimeType: "application/pdf", size: 10 },
    ]);
    expect(h.scripts).toHaveLength(1);
    expect(h.scripts[0]).toContain('first account whose name is "Nopuedomas"');
    expect(h.scripts[0]).not.toContain("repeat with acct in accounts");
  });

  it("without a known mailbox, uses the bounded scan", () => {
    h.output = `${FOUND}a.pdf\x1fapplication/pdf\x1f10`;
    const found = manager(undefined).listAttachments("538208");
    expect(found.map((a) => a.name)).toEqual(["a.pdf"]);
    expect(h.scripts[0]).toContain("repeat with acct in accounts");
  });

  it("refuses an id that several mailboxes hold instead of answering for the first", () => {
    h.output = `${ERR}Message 538208 is present in more than one mailbox (A/INBOX, A/All Mail); list or search that mailbox first so the read targets the right copy`;
    expect(() => manager(undefined).listAttachments("538208")).toThrow(
      /present in more than one mailbox/
    );
  });

  it("a message with no attachments reads as found, not as a miss, and falls back to the source", () => {
    h.output = FOUND;
    h.source = "";
    expect(manager({ account: "Nopuedomas", mailbox: "INBOX" }).listAttachments("538208")).toEqual(
      []
    );
  });
});
