import { describe, it, expect } from "vitest";
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { isAbsolute, join } from "path";
import { homedir, tmpdir } from "os";
import { materializeAttachments } from "@/utils/attachmentMaterialize.js";

describe("materializeAttachments (B4)", () => {
  it("passes through plain string paths and creates nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "amcp-path-test-"));
    try {
      const first = join(dir, "a.pdf");
      const second = join(dir, "b.txt");
      writeFileSync(first, "a");
      writeFileSync(second, "b");
      const m = materializeAttachments([first, second]);
      expect(m.paths).toEqual([realpathSync(first), realpathSync(second)]);
      m.cleanup();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    const dir = mkdtempSync(join(tmpdir(), "amcp-path-test-"));
    try {
      const existing = join(dir, "keep.pdf");
      writeFileSync(existing, "keep");
      const m = materializeAttachments([
        existing,
        { filename: "../evil/name.txt", contentBase64: Buffer.from("x").toString("base64") },
      ]);
      expect(m.paths[0]).toBe(realpathSync(existing));
      expect(m.paths[1]).not.toContain("/evil/");
      expect(existsSync(m.paths[1])).toBe(true);
      m.cleanup();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an existing path outside the default user-content roots", () => {
    const dir = mkdtempSync(join(homedir(), ".amcp-attachment-read-test-"));
    try {
      const secret = join(dir, "secret.txt");
      writeFileSync(secret, "private");
      expect(() => materializeAttachments([secret])).toThrow(/outside the allowed read roots/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when inline content is missing fields", () => {
    expect(() => materializeAttachments([{ filename: "x.txt", contentBase64: "" }])).toThrow(
      /filename and contentBase64/
    );
  });

  it("cleans up earlier temp files when a later inline attachment is rejected", () => {
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("amcp-att-")));
    const boundaryOversize = Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64");

    expect(() =>
      materializeAttachments([
        { filename: "first.txt", contentBase64: Buffer.from("written first").toString("base64") },
        { filename: "too-large.bin", contentBase64: boundaryOversize },
      ])
    ).toThrow(/25 MiB decoded size limit/);

    const after = readdirSync(tmpdir()).filter(
      (name) => name.startsWith("amcp-att-") && !before.has(name)
    );
    expect(after).toEqual([]);
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
