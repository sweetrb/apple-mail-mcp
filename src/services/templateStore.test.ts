import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TemplateStore } from "@/services/templateStore.js";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amcp-tmpl-"));
  file = join(dir, "templates.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("TemplateStore (B3 / #14)", () => {
  it("saves, lists, gets, and deletes templates", () => {
    const s = new TemplateStore(file);
    const t = s.save("Greeting", "Hi {{Name}}", "Hello {{Name}}", ["a@b.com"]);
    expect(t.id).toMatch(/^tmpl_/);
    expect(s.list()).toHaveLength(1);
    expect(s.get(t.id)?.subject).toBe("Hi {{Name}}");
    expect(s.delete(t.id)).toBe(true);
    expect(s.list()).toHaveLength(0);
    expect(s.delete(t.id)).toBe(false);
  });

  it("persists to disk and survives a 'restart' (new instance, same file)", () => {
    const s1 = new TemplateStore(file);
    const t = s1.save("Memo", "Subj", "Body");
    expect(existsSync(file)).toBe(true);

    // Simulate restart: a fresh store reading the same file.
    const s2 = new TemplateStore(file);
    expect(s2.list()).toHaveLength(1);
    expect(s2.get(t.id)?.name).toBe("Memo");
  });

  it("does not reset/collide ids across restarts", () => {
    const s1 = new TemplateStore(file);
    const a = s1.save("A", "s", "b");
    const b = s1.save("B", "s", "b");
    expect(a.id).not.toBe(b.id);

    const s2 = new TemplateStore(file);
    const c = s2.save("C", "s", "b"); // continues the sequence, no collision
    expect(c.id).not.toBe(a.id);
    expect(c.id).not.toBe(b.id);
    expect(s2.list()).toHaveLength(3);
  });

  it("tolerates a missing file (starts empty) and a corrupt file", () => {
    expect(new TemplateStore(join(dir, "nope.json")).list()).toEqual([]);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    expect(new TemplateStore(bad).list()).toEqual([]);
  });

  it("updates an existing template in place when given its id", () => {
    const s = new TemplateStore(file);
    const t = s.save("Orig", "s1", "b1");
    s.save("Renamed", "s2", "b2", undefined, undefined, t.id);
    expect(s.list()).toHaveLength(1);
    expect(s.get(t.id)?.name).toBe("Renamed");
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.templates).toHaveLength(1);
  });
});
