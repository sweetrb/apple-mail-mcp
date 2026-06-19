import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { isAbsolute } from "path";
import { materializeAttachments } from "@/utils/attachmentMaterialize.js";

describe("materializeAttachments (B4)", () => {
  it("passes through plain string paths and creates nothing", () => {
    const m = materializeAttachments(["/Users/me/a.pdf", "/tmp/b.txt"]);
    expect(m.paths).toEqual(["/Users/me/a.pdf", "/tmp/b.txt"]);
    m.cleanup();
  });

  it("writes inline base64 content to a temp file and cleans it up", () => {
    const m = materializeAttachments([
      { filename: "note.txt", contentBase64: Buffer.from("payload").toString("base64") },
    ]);
    expect(m.paths).toHaveLength(1);
    expect(isAbsolute(m.paths[0])).toBe(true);
    expect(existsSync(m.paths[0])).toBe(true);
    expect(readFileSync(m.paths[0]).toString()).toBe("payload");
    m.cleanup();
    expect(existsSync(m.paths[0])).toBe(false);
  });

  it("mixes paths and inline content, sanitizing the filename", () => {
    const m = materializeAttachments([
      "/tmp/keep.pdf",
      { filename: "../evil/name.txt", contentBase64: Buffer.from("x").toString("base64") },
    ]);
    expect(m.paths[0]).toBe("/tmp/keep.pdf");
    expect(m.paths[1]).not.toContain("/evil/");
    expect(existsSync(m.paths[1])).toBe(true);
    m.cleanup();
  });

  it("throws when inline content is missing fields", () => {
    expect(() => materializeAttachments([{ filename: "x.txt", contentBase64: "" }])).toThrow(
      /filename and contentBase64/
    );
  });

  it("handles the empty/undefined case (incl. its no-op cleanup)", () => {
    const a = materializeAttachments();
    expect(a.paths).toEqual([]);
    expect(() => a.cleanup()).not.toThrow(); // exercise the no-op cleanup path
    const b = materializeAttachments([]);
    expect(b.paths).toEqual([]);
    b.cleanup();
  });
});
