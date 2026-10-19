/**
 * hasAttachments on the list/search rows (AppleScript route).
 *
 * `mail attachments of <list of messages>` returns an empty list on current
 * macOS, so the bulk read made every row report hasAttachments:false even when
 * Mail counted 1, 4 or 2 attachments message by message. The row loop now counts
 * per message. The script text is checked here; the live result is in the notes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string) => {
      h.calls.push(script);
      if (script.includes("set end of mbNames to mbPath")) {
        return { success: true, output: "INBOX" };
      }
      return { success: true, output: "" };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

const FIELD_SEP = String.fromCharCode(31);

beforeEach(() => {
  h.calls = [];
});

function rowScript(): string {
  const hit = h.calls.find((s) => s.includes("set outputText to"));
  expect(hit, "no row script was run").toBeDefined();
  return hit!;
}

describe("row hasAttachments", () => {
  it("counts attachments per message, not with a bulk read of the message list", () => {
    new AppleMailManager().searchMessages(undefined, "INBOX", "iCloud", 50);
    const script = rowScript();
    expect(script).not.toMatch(/mail attachments of _msgs/);
    expect(script).not.toContain("_atts");
    expect(script).toContain("count of mail attachments of (item _i of _msgs)");
  });

  it("list-messages counts per message too", () => {
    new AppleMailManager().listMessages("INBOX", "iCloud", 50);
    const script = rowScript();
    expect(script).not.toMatch(/mail attachments of _msgs/);
    expect(script).toContain("count of mail attachments of (item _i of _msgs)");
  });

  it("reads the per-message count whether or not the other bulk reads worked", () => {
    new AppleMailManager().listMessages("INBOX", "iCloud", 50);
    // No _bulkOK branch around it: the count must not depend on a bulk result.
    const m = rowScript().match(/set msgHasAtt to "false"\s+try\s+([\s\S]*?)end try/);
    expect(m).not.toBeNull();
    expect(m![1]).not.toContain("_bulkOK");
  });

  it("parses the true/false field the script emits", () => {
    const out = (id: string, att: string) =>
      [id, "s", "a@b.c", "2026-10-19-9-0-0", "", "true", "false", "-1", att].join(FIELD_SEP);
    const mgr = new AppleMailManager();
    // Round-trip through the public parser by way of a single-mailbox search.
    const parse = (
      mgr as unknown as { parseMessageList: (o: string, m: string, a: string) => unknown[] }
    ).parseMessageList.bind(mgr);
    const rows = parse(`${out("1", "true")}\x1e${out("2", "false")}`, "INBOX", "iCloud") as {
      id: string;
      hasAttachments: boolean;
    }[];
    expect(rows.map((r) => [r.id, r.hasAttachments])).toEqual([
      ["1", true],
      ["2", false],
    ]);
  });
});
