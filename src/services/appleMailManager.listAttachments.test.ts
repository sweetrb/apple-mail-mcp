/**
 * `listAttachments` for a message Apple Mail composed itself: the files it
 * attaches are written as `Content-Disposition: inline` with a filename, and
 * `MIME type of att` throws for them in AppleScript. executeAppleScript is
 * mocked, so these tests inspect the generated script and the parsed fallback.
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

afterEach(() => {
  h.scripts.length = 0;
  h.output = "";
  h.source = "";
});

describe("listAttachments survives an unreadable property", () => {
  it("reads name, MIME type and size each inside its own try", () => {
    new AppleMailManager().listAttachments("538547");
    const script = h.scripts[0];
    expect(script).toMatch(/try\s+set attType to MIME type of att\s+end try/);
    expect(script).toMatch(/try\s+set attSize to file size of att as string\s+end try/);
    expect(script).toMatch(/try\s+set attName to name of att\s+end try/);
  });

  it("falls back to the raw source and lists an inline PDF Apple Mail attached", () => {
    h.output = "";
    h.source = [
      'Content-Type: multipart/mixed; boundary="B"',
      "",
      "--B",
      "Content-Type: text/plain",
      "",
      "Hola",
      "--B",
      "Content-Disposition: inline;",
      '\tfilename="report.pdf"',
      "Content-Type: application/pdf;",
      '\tname="report.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjMK",
      "--B--",
    ].join("\n");
    const found = new AppleMailManager().listAttachments("538547");
    expect(found.map((a) => a.name)).toEqual(["report.pdf"]);
  });
});
