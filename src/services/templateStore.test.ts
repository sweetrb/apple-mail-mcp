import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { TemplateStore } from "@/services/templateStore.js";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  mkdirSync,
  symlinkSync,
  lstatSync,
  utimesSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fork, type ChildProcess } from "child_process";
import { buildSync } from "esbuild";
import { fileURLToPath } from "url";

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

  it("preserves saves from two already-loaded sessions and allocates different ids", () => {
    const first = new TemplateStore(file);
    const second = new TemplateStore(file);
    expect(first.list()).toEqual([]);
    expect(second.list()).toEqual([]);
    const a = first.save("First session", "First subject", "First body");
    const b = second.save("Second session", "Second subject", "Second body");
    expect(b.id).not.toBe(a.id);
    expect(first.list().map((t) => t.name)).toEqual(["First session", "Second session"]);
    expect(second.get(a.id)?.body).toBe("First body");
    expect(new TemplateStore(file).list().map((t) => t.name)).toEqual([
      "First session",
      "Second session",
    ]);
  });

  it("does not resurrect a template deleted by another loaded session", () => {
    const first = new TemplateStore(file);
    const a = first.save("First", "s", "b");
    const second = new TemplateStore(file);
    second.list();
    expect(first.delete(a.id)).toBe(true);
    second.save("Second", "s", "b");
    expect(first.get(a.id)).toBeNull();
    expect(new TemplateStore(file).list().map((t) => t.name)).toEqual(["Second"]);
  });

  it("reports a persistence failure rather than returning an unsaved template", () => {
    writeFileSync(join(dir, "not-a-directory"), "existing file");
    const s = new TemplateStore(join(dir, "not-a-directory", "templates.json"));
    expect(() => s.save("Not saved", "s", "b")).toThrow();
    expect(readFileSync(join(dir, "not-a-directory"), "utf8")).toBe("existing file");
  });

  it("does not overwrite a corrupt store during a mutation", () => {
    writeFileSync(file, "{ not json");
    expect(() => new TemplateStore(file).save("Lost", "s", "b")).toThrow(/Cannot update/);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("refuses a dangling template symlink without replacing it", () => {
    const alias = join(dir, "alias.json");
    symlinkSync(file, alias);
    expect(() => new TemplateStore(alias).save("Not saved", "s", "b")).toThrow(/symlink/);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("preserves an existing template symlink and updates its canonical store", () => {
    const original = new TemplateStore(file);
    const first = original.save("Original", "s", "b");
    const alias = join(dir, "alias.json");
    symlinkSync(file, alias);
    const second = new TemplateStore(alias).save("Alias", "s", "b");
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(original.list().map((t) => t.name)).toEqual(["Original", "Alias"]);
  });

  it("does not reuse an explicitly created numeric template id", () => {
    const s = new TemplateStore(file);
    s.save("Explicit", "s", "b", undefined, undefined, "tmpl_1");
    expect(s.save("Generated", "s", "b").id).toBe("tmpl_2");
    expect(s.list()).toHaveLength(2);
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

/** Real child processes run the production store bundle, with OS-boundary barriers. */
describe("TemplateStore across processes", () => {
  let compiledDir: string;
  let compiled: string;
  let worker: string;
  const children: ChildProcess[] = [];

  beforeAll(() => {
    compiledDir = mkdtempSync(join(tmpdir(), "amcp-tmpl-workers-"));
    compiled = join(compiledDir, "store.mjs");
    const result = buildSync({
      entryPoints: [fileURLToPath(new URL("./templateStore.ts", import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      write: false,
    });
    writeFileSync(compiled, result.outputFiles[0].text);
    worker = join(compiledDir, "worker.mjs");
    writeFileSync(
      worker,
      String.raw`
      import fs from "node:fs";
      import crypto from "node:crypto";
      import { syncBuiltinESMExports } from "node:module";
      import { basename, dirname, join } from "node:path";
      import { pathToFileURL } from "node:url";
      const [compiled, file, label, mode, gate, uuid, committed] = process.argv.slice(2);
      // Production locks and writes the canonical target. macOS tmpdir() uses
      // /var/... while realpath returns /private/var/...; compare that target so
      // aliases cannot bypass the transaction barrier or its commit marker.
      const targetFile = fs.existsSync(file)
        ? fs.realpathSync(file)
        : join(fs.realpathSync(dirname(file)), basename(file));
      if (uuid) crypto.randomUUID = () => uuid;
      const nativeRead = fs.readFileSync;
      const nativeRename = fs.renameSync;
      let saving = false;
      let held = false;
      const pause = () => {
        const word = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 4000;
        while (!fs.existsSync(gate)) {
          if (Date.now() > deadline) throw new Error("barrier was not released");
          Atomics.wait(word, 0, 0, 10);
        }
      };
      fs.readFileSync = function(path, ...args) {
        if (saving && path === targetFile) {
          if (mode === "hold" && !held) {
            held = true;
            process.send({ phase: "inside" });
            pause();
          } else if (mode === "guard" && !fs.existsSync(gate)) {
            throw new Error("entered the transaction before the other owner committed");
          }
        }
        return nativeRead.call(this, path, ...args);
      };
      fs.renameSync = function(from, to) {
        let number;
        if (saving && String(to).endsWith(".json") && String(to).includes(".lock/")) {
          number = JSON.parse(nativeRead(from, "utf8")).number;
          if (number !== null && mode === "choosing" && !held) {
            held = true;
            process.send({ phase: "numberReady", number });
            pause();
          }
        }
        const result = nativeRename.call(this, from, to);
        if (number !== undefined && number !== null) process.send({ phase: "numberPublished", number });
        if (saving && to === targetFile && committed) fs.writeFileSync(committed, "committed");
        return result;
      };
      if (mode === "crash") fs.fsyncSync = () => process.exit(23);
      syncBuiltinESMExports();
      const { TemplateStore } = await import(pathToFileURL(compiled).href);
      const store = new TemplateStore(file);
      store.list();
      process.send({ phase: "ready" });
      process.once("message", () => {
        saving = true;
        try {
          const saved = store.save(label, "subject", "body");
          process.send({ phase: "done", saved }, () => process.disconnect());
        } catch (error) {
          process.send({ phase: "failed", error: String(error) }, () => process.disconnect());
        }
      });
    `
    );
  });
  afterEach(async () => {
    await Promise.all(
      children.splice(0).map((child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        return new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.kill("SIGKILL");
        });
      })
    );
  });
  afterAll(() => rmSync(compiledDir, { recursive: true, force: true }));

  function actor(label: string, mode = "normal", gate = "", uuid = "", committed = "") {
    const child = fork(worker, [compiled, file, label, mode, gate, uuid, committed], {
      silent: true,
    });
    children.push(child);
    const messages: Array<{
      phase: string;
      error?: string;
      number?: number;
      saved?: { id: string };
    }> = [];
    let stderr = "";
    child.stderr!.on("data", (data) => {
      stderr += String(data);
    });
    child.stdout!.resume();
    child.on("message", (message) => messages.push(message as (typeof messages)[number]));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const phase = (name: string): Promise<(typeof messages)[number]> => {
      const existing = messages.find(
        (message) => message.phase === name || message.phase === "failed"
      );
      if (existing)
        return existing.phase === "failed"
          ? Promise.reject(new Error(existing.error))
          : Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error(`Missing ${name}: ${stderr}`)), 6000);
        const listener = (message: (typeof messages)[number]) => {
          if (message.phase === name) finish(undefined, message);
          else if (message.phase === "failed") finish(new Error(message.error));
        };
        const finish = (error?: Error, message?: (typeof messages)[number]) => {
          clearTimeout(timeout);
          child.off("message", listener);
          if (error) reject(error);
          else resolve(message!);
        };
        child.on("message", listener);
      });
    };
    return { child, phase, exited, messages, start: () => child.send("save") };
  }

  it("preserves simultaneous saves from preloaded processes with unique ids", async () => {
    const writers = Array.from({ length: 8 }, (_, i) => actor(`Session ${i}`));
    await Promise.all(writers.map((writer) => writer.phase("ready")));
    writers.forEach((writer) => writer.start());
    const saved = await Promise.all(writers.map((writer) => writer.phase("done")));
    expect(new Set(saved.map((message) => message.saved!.id)).size).toBe(8);
    expect(
      new TemplateStore(file)
        .list()
        .map((t) => t.name)
        .sort()
    ).toEqual(Array.from({ length: 8 }, (_, i) => `Session ${i}`));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(`${file}.lock`).mode & 0o777).toBe(0o700);
  }, 10000);

  it.each([false, true])(
    "keeps a later lexically earlier contender behind an active owner (directory alias=%s)",
    async (directoryAlias) => {
      if (directoryAlias) {
        const target = join(dir, "actual");
        const alias = join(dir, "alias");
        mkdirSync(target);
        symlinkSync(target, alias, "dir");
        file = join(alias, "templates.json");
      }
      new TemplateStore(file).save("Seed", "s", "b");
      const gate = join(dir, "release-owner");
      const owner = actor("Owner", "hold", gate, "ffffffff-ffff-ffff-ffff-ffffffffffff");
      await owner.phase("ready");
      owner.start();
      await owner.phase("inside");
      const later = actor("Later", "guard", gate, "00000000-0000-0000-0000-000000000000");
      await later.phase("ready");
      later.start();
      await later.phase("numberPublished");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        later.messages.some((message) => message.phase === "done" || message.phase === "failed")
      ).toBe(false);
      writeFileSync(gate, "go");
      await Promise.all([owner.phase("done"), later.phase("done")]);
      expect(new TemplateStore(file).list().map((t) => t.name)).toEqual(["Seed", "Owner", "Later"]);
    },
    10000
  );

  it.each([false, true])(
    "waits for a contender paused between choosing and number publication (directory alias=%s)",
    async (directoryAlias) => {
      if (directoryAlias) {
        const target = join(dir, "actual");
        const alias = join(dir, "alias");
        mkdirSync(target);
        symlinkSync(target, alias, "dir");
        file = join(alias, "templates.json");
      }
      new TemplateStore(file).save("Seed", "s", "b");
      const gate = join(dir, "finish-choosing");
      const committed = join(dir, "first-committed");
      const choosing = actor(
        "First",
        "choosing",
        gate,
        "00000000-0000-0000-0000-000000000000",
        committed
      );
      await choosing.phase("ready");
      choosing.start();
      expect((await choosing.phase("numberReady")).number).toBe(1);
      const other = actor("Second", "guard", committed, "ffffffff-ffff-ffff-ffff-ffffffffffff");
      await other.phase("ready");
      other.start();
      expect((await other.phase("numberPublished")).number).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        other.messages.some((message) => message.phase === "done" || message.phase === "failed")
      ).toBe(false);
      writeFileSync(gate, "go");
      await Promise.all([choosing.phase("done"), other.phase("done")]);
      expect(new TemplateStore(file).list().map((t) => t.name)).toEqual([
        "Seed",
        "First",
        "Second",
      ]);
    },
    10000
  );

  it("recovers a crashed writer without exposing its staged partial update", async () => {
    new TemplateStore(file).save("Before crash", "s", "b");
    const crashed = actor("Never committed", "crash");
    await crashed.phase("ready");
    crashed.start();
    expect(await crashed.exited).toBe(23);
    expect(new TemplateStore(file).list().map((t) => t.name)).toEqual(["Before crash"]);
    new TemplateStore(file).save("After crash", "s", "b");
    expect(new TemplateStore(file).list().map((t) => t.name)).toEqual([
      "Before crash",
      "After crash",
    ]);
  }, 10000);

  it("never steals an old ticket whose pid is still live", () => {
    new TemplateStore(file).save("Existing", "s", "b");
    const lock = `${file}.lock`;
    mkdirSync(lock, { recursive: true });
    const held = join(lock, "old-live-owner.json");
    writeFileSync(held, JSON.stringify({ pid: process.pid, number: 1 }));
    utimesSync(held, new Date(0), new Date(0));
    expect(() => new TemplateStore(file).save("Must not save", "s", "b")).toThrow(
      /Another session/
    );
    expect(existsSync(held)).toBe(true);
    expect(new TemplateStore(file).list().map((t) => t.name)).toEqual(["Existing"]);
  }, 10000);
});
