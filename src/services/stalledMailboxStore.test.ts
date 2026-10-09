/**
 * #270 follow-up (@j5pu, 2.20.7 retest): the remembered "probe timed out"
 * mailbox list survives a restart. Missing/corrupt file = empty list, never
 * fatal; writes are atomic and merge with other processes'; entries expire.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  StalledMailboxStore,
  STALLED_MAILBOX_TTL_MS,
  defaultStalledMailboxesFile,
} from "@/services/stalledMailboxStore.js";

const K = (a: string, m: string) => `${a}\x1f${m}`;

describe("StalledMailboxStore", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "amcp-stalled-"));
    file = join(dir, "sub", "stalled-mailboxes.json");
  });

  it("a missing file is an empty list", () => {
    expect(new StalledMailboxStore({ file }).keys()).toEqual([]);
  });

  it("records persist across instances (a server restart)", () => {
    new StalledMailboxStore({ file }).record([K("iCloud", "Archive")]);
    expect(new StalledMailboxStore({ file }).keys()).toEqual([K("iCloud", "Archive")]);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.version).toBe(1);
    expect(onDisk.entries).toEqual([
      { account: "iCloud", mailbox: "Archive", recordedAt: expect.any(Number) },
    ]);
  });

  it("writes atomically — no temp file is left behind", () => {
    new StalledMailboxStore({ file }).record([K("a", "b")]);
    expect(readdirSync(join(dir, "sub"))).toEqual(["stalled-mailboxes.json"]);
  });

  it("merges with entries another process wrote meanwhile", () => {
    const a = new StalledMailboxStore({ file });
    const b = new StalledMailboxStore({ file });
    a.record([K("iCloud", "Archive")]);
    b.record([K("iCloud", "Recovered")]);
    expect(new StalledMailboxStore({ file }).keys().sort()).toEqual(
      [K("iCloud", "Archive"), K("iCloud", "Recovered")].sort()
    );
    // …and A sees B's entry without restarting.
    expect(a.keys()).toContain(K("iCloud", "Recovered"));
  });

  it("entries expire after the TTL (7 days by default)", () => {
    expect(STALLED_MAILBOX_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    let now = 1_000_000_000_000;
    const store = new StalledMailboxStore({ file, now: () => now });
    store.record([K("iCloud", "Archive")]);
    now += STALLED_MAILBOX_TTL_MS - 1;
    expect(new StalledMailboxStore({ file, now: () => now }).keys()).toHaveLength(1);
    now += 2;
    expect(new StalledMailboxStore({ file, now: () => now }).keys()).toEqual([]);
    expect(store.keys()).toEqual([]);
    // An expired entry is dropped from the file on the next write, not resurrected.
    store.record([K("Work", "Old")]);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.entries.map((e: { mailbox: string }) => e.mailbox)).toEqual(["Old"]);
  });

  it("a corrupt file reads as empty and is replaced on the next write — never throws", () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(file, "{not json");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new StalledMailboxStore({ file });
    expect(store.keys()).toEqual([]);
    store.record([K("iCloud", "Archive")]);
    expect(new StalledMailboxStore({ file }).keys()).toEqual([K("iCloud", "Archive")]);
    err.mockRestore();
  });

  it("ignores malformed entries", () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        entries: [
          { account: "iCloud", mailbox: "Archive", recordedAt: Date.now() },
          { account: "", mailbox: "x", recordedAt: Date.now() },
          { account: "a", mailbox: "b", recordedAt: "yesterday" },
          null,
          "junk",
        ],
      })
    );
    expect(new StalledMailboxStore({ file }).keys()).toEqual([K("iCloud", "Archive")]);
    writeFileSync(file, JSON.stringify({ entries: "nope" }));
    expect(new StalledMailboxStore({ file }).keys()).toEqual([]);
    writeFileSync(file, "null");
    expect(new StalledMailboxStore({ file }).keys()).toEqual([]);
  });

  it("an unwritable location keeps the list in memory for this process — never throws", () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "a file, so nothing can be created beneath it");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new StalledMailboxStore({ file: join(blocker, "x", "stalled.json") });
    expect(() => store.record([K("iCloud", "Archive")])).not.toThrow();
    expect(store.keys()).toEqual([K("iCloud", "Archive")]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("ignores keys without an account/mailbox separator and empty batches", () => {
    const store = new StalledMailboxStore({ file });
    store.record([]);
    store.record(["no-separator"]);
    expect(store.keys()).toEqual([]);
    expect(() => readFileSync(file)).toThrow();
  });

  it("defaults under Application Support, overridable by APPLE_MAIL_MCP_STALLED_MAILBOXES_FILE", () => {
    const saved = process.env.APPLE_MAIL_MCP_STALLED_MAILBOXES_FILE;
    try {
      delete process.env.APPLE_MAIL_MCP_STALLED_MAILBOXES_FILE;
      expect(defaultStalledMailboxesFile()).toMatch(
        /Library\/Application Support\/apple-mail-mcp\/stalled-mailboxes\.json$/
      );
      process.env.APPLE_MAIL_MCP_STALLED_MAILBOXES_FILE = "  /tmp/x.json  ";
      expect(defaultStalledMailboxesFile()).toBe("/tmp/x.json");
      expect(new StalledMailboxStore().file).toBe("/tmp/x.json");
    } finally {
      if (saved === undefined) delete process.env.APPLE_MAIL_MCP_STALLED_MAILBOXES_FILE;
      else process.env.APPLE_MAIL_MCP_STALLED_MAILBOXES_FILE = saved;
    }
  });
});
