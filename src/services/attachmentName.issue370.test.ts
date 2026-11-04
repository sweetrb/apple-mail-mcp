/**
 * #370 (@SandroK) — attachment names are matched modulo Unicode normalization.
 *
 * Mail.app stores non-ASCII attachment filenames of Mac-sent messages
 * decomposed (NFD: `a` + U+0308), while a client passes them precomposed
 * (NFC: U+00E4). Every lookup compared with `===`, so save-attachment and
 * fetch-attachment answered "not found … Available: <the same-looking name>".
 * Same class as #253 (mailbox names). The saved file keeps the caller's name.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const h = vi.hoisted(() => ({ scripts: [] as string[] }));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string) => {
      h.scripts.push(script);
      // The save itself misses (forcing the MIME fallback); the by-id
      // location lookup answers with one account/mailbox.
      if (script.includes("save att in savePath")) {
        return { success: true, output: "error:Attachment not found" };
      }
      return { success: true, output: "Acct\x1fINBOX" };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";
import {
  encodeImapId,
  imapFetchAttachment,
  type ImapClientLike,
  type ImapConfig,
} from "@/services/imapClient.js";
import { attachmentNameForms, sameAttachmentName } from "@/utils/attachmentName.js";
import { extractMimeAttachment } from "@/utils/mimeParse.js";

const NFC = "Vollmacht EVU Zähler – ausgefüllt.pdf"; // precomposed ä, ü
const NFD = "Vollmacht EVU Zähler – ausgefüllt.pdf"; // a/u + U+0308

afterEach(() => {
  h.scripts.length = 0;
  vi.restoreAllMocks();
});

describe("sameAttachmentName / attachmentNameForms", () => {
  it("treats the NFC and NFD spellings as the same name, either way round", () => {
    expect(NFC).not.toBe(NFD);
    expect(sameAttachmentName(NFD, NFC)).toBe(true);
    expect(sameAttachmentName(NFC, NFD)).toBe(true);
    expect(sameAttachmentName("report.pdf", "report.pdf")).toBe(true);
  });

  it("stays case-sensitive and does not match a missing name", () => {
    expect(sameAttachmentName("Report.pdf", "report.pdf")).toBe(false);
    expect(sameAttachmentName(null, NFC)).toBe(false);
    expect(sameAttachmentName(undefined, NFC)).toBe(false);
  });

  it("lists the caller's spelling first, then its NFC and NFD forms, deduplicated", () => {
    expect(attachmentNameForms(NFC)).toEqual([NFC, NFD]);
    expect(attachmentNameForms(NFD)).toEqual([NFD, NFC]);
    expect(attachmentNameForms("report.pdf")).toEqual(["report.pdf"]);
  });
});

/** A multipart message whose attachment carries `filename` (RFC 2231-encoded). */
function mimeWith(filename: string): string {
  return [
    "Content-Type: multipart/mixed; boundary=B",
    "",
    "--B",
    "Content-Type: text/plain",
    "",
    "hi",
    "--B",
    `Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Content-Type: application/pdf",
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERg==",
    "--B--",
  ].join("\n");
}

describe("extractMimeAttachment (MIME path)", () => {
  it("finds an NFD-stored attachment by its NFC name", () => {
    expect(extractMimeAttachment(mimeWith(NFD), NFC)?.data.toString()).toBe("%PDF");
  });

  it("finds an NFC-stored attachment by its NFD name", () => {
    expect(extractMimeAttachment(mimeWith(NFC), NFD)?.data.toString()).toBe("%PDF");
  });

  it("still misses a genuinely different name", () => {
    expect(extractMimeAttachment(mimeWith(NFD), "Vollmacht EVU Zahler.pdf")).toBeNull();
  });
});

describe("imapFetchAttachment (IMAP path)", () => {
  const MID = encodeImapId("acct", "INBOX", 9);
  const cfg: ImapConfig = {
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    user: "u@example.com",
    pass: "secret",
    accountLabel: "acct",
  };

  function client(stored: string, downloaded: string[]): ImapClientLike {
    return {
      connect: async () => undefined,
      getMailboxLock: async () => ({ release: () => undefined }),
      list: async () => [{ path: "INBOX", name: "INBOX" }],
      fetchOne: async () => ({
        uid: 9,
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            { part: "1", type: "text/plain", size: 10 },
            {
              part: "2",
              type: "application/pdf",
              parameters: { name: stored },
              disposition: "attachment",
              dispositionParameters: { filename: stored },
              size: 4,
            },
          ],
        },
      }),
      download: async (_range: string, part: string) => {
        downloaded.push(part);
        return {
          meta: {},
          content: (async function* () {
            yield Buffer.from("%PDF");
          })(),
        };
      },
      logout: async () => undefined,
    } as unknown as ImapClientLike;
  }

  it("fetches an NFD-stored attachment requested by its NFC name", async () => {
    const downloaded: string[] = [];
    const r = await imapFetchAttachment(MID, NFC, {
      config: cfg,
      connect: async () => client(NFD, downloaded),
    });
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(Buffer.from(r.base64 ?? "", "base64").toString()).toBe("%PDF");
    expect(downloaded).toEqual(["2"]);
  });

  it("still reports a genuinely different name as not found", async () => {
    const r = await imapFetchAttachment(MID, "other.pdf", {
      config: cfg,
      connect: async () => client(NFD, []),
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("not found");
  });
});

describe("saveAttachment (AppleScript path, then MIME fallback)", () => {
  function manager(raw: string): AppleMailManager {
    const mgr = new AppleMailManager();
    const internals = mgr as unknown as {
      getCachedAccounts: () => unknown;
      resolveMailbox: (mailbox: string, account: string) => string;
    };
    vi.spyOn(internals, "getCachedAccounts").mockReturnValue([
      { name: "Acct", email: "a@example.com", enabled: true },
    ]);
    vi.spyOn(internals, "resolveMailbox").mockImplementation((mailbox) => mailbox);
    vi.spyOn(mgr, "getRawSource").mockReturnValue(raw);
    return mgr;
  }

  it("tests Mail's stored name against both the NFC and NFD spellings", () => {
    const dir = mkdtempSync(join(tmpdir(), "amcp-370-"));
    try {
      manager(mimeWith(NFD)).saveAttachment("538208", NFC, dir);
      const save = h.scripts.find((s) => s.includes("save att in savePath")) ?? "";
      expect(save).toContain("set _attName to name of att");
      expect(save).toContain(`if _attName is "${NFC}" or _attName is "${NFD}" then`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves an NFD-stored attachment under the caller's NFC name", () => {
    const dir = mkdtempSync(join(tmpdir(), "amcp-370-"));
    try {
      expect(manager(mimeWith(NFD)).saveAttachment("538208", NFC, dir)).toBe(true);
      // Compare the name bytes, not just the path: APFS would also resolve
      // the NFD spelling, which is exactly what must not be relied on here.
      expect(readdirSync(dir)).toEqual([NFC]);
      expect(existsSync(join(dir, NFC))).toBe(true);
      expect(readFileSync(join(dir, NFC)).toString()).toBe("%PDF");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
