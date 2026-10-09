/**
 * Persistent list of mailboxes whose by-id size-guard probe timed out (#270
 * follow-up, @j5pu).
 *
 * The unscoped by-id scan asks Mail.app `count of messages` before probing a
 * mailbox for an id. On a multi-hundred-thousand-message mailbox that count
 * can outlive its 3s `with timeout of` cap — and because Mail.app handles
 * Apple events one at a time and keeps running an abandoned count to
 * completion, everything sent after it queues behind it. A mailbox that has
 * done this once is therefore never probed again: the scan skips it outright.
 *
 * 2.20.7 kept that list in memory, so every client restart (a fresh server
 * process) re-learned it at the cost of one failed lookup per large mailbox.
 * This persists it to a small JSON file so the learning survives restarts and
 * is shared by every server process on the machine. Entries expire after
 * `STALLED_MAILBOX_TTL_MS` (a mailbox that has since been archived down gets
 * probed again).
 *
 * File: `APPLE_MAIL_MCP_STALLED_MAILBOXES_FILE`, else
 * `~/Library/Application Support/apple-mail-mcp/stalled-mailboxes.json`.
 * A missing, unreadable or corrupt file reads as an empty list and a failed
 * write keeps the in-memory copy for the life of the process — never fatal.
 * Writes are atomic (temp file + rename), and every write re-reads the file
 * first so concurrent server processes merge rather than clobber.
 *
 * @module services/stalledMailboxStore
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

/** How long a learned entry is trusted before the mailbox is probed again. */
export const STALLED_MAILBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Separator inside a key: `${account}\x1f${leafMailboxName}`. */
export const STALLED_KEY_SEP = "\x1f";

interface PersistEntry {
  account: string;
  mailbox: string;
  /** Epoch milliseconds when the probe timed out. */
  recordedAt: number;
}

interface PersistShape {
  version: 1;
  entries: PersistEntry[];
}

export function defaultStalledMailboxesFile(): string {
  const env = process.env.APPLE_MAIL_MCP_STALLED_MAILBOXES_FILE;
  if (env && env.trim()) return env.trim();
  return join(
    homedir(),
    "Library",
    "Application Support",
    "apple-mail-mcp",
    "stalled-mailboxes.json"
  );
}

export class StalledMailboxStore {
  private readonly fileOverride: string | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** key → recordedAt. Holds everything learned, even when the disk write failed. */
  private memory = new Map<string, number>();

  constructor(opts: { file?: string; ttlMs?: number; now?: () => number } = {}) {
    this.fileOverride = opts.file;
    this.ttlMs = opts.ttlMs ?? STALLED_MAILBOX_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Resolved per call so an env override set after construction (tests) is honoured. */
  get file(): string {
    return this.fileOverride ?? defaultStalledMailboxesFile();
  }

  /**
   * Every live (unexpired) key, merging what is on disk — possibly written by
   * another server process — with what this process learned. Re-read on each
   * call: the file is a handful of entries and is only consulted once per
   * unscoped scan, which itself costs seconds.
   */
  keys(): string[] {
    const merged = this.merged();
    return Array.from(merged.keys());
  }

  /** Record keys whose probe just timed out, and persist them. */
  record(keys: readonly string[]): void {
    const fresh = keys.filter((k) => k.includes(STALLED_KEY_SEP));
    if (fresh.length === 0) return;
    const at = this.now();
    for (const k of fresh) this.memory.set(k, at);
    this.persist(this.merged());
  }

  /** Disk ∪ memory, newest timestamp per key, expired entries dropped. */
  private merged(): Map<string, number> {
    const cutoff = this.now() - this.ttlMs;
    const out = new Map<string, number>();
    const put = (k: string, at: number) => {
      if (at < cutoff) return;
      const prev = out.get(k);
      if (prev === undefined || at > prev) out.set(k, at);
    };
    for (const [k, at] of this.readDisk()) put(k, at);
    for (const [k, at] of this.memory) put(k, at);
    // Keep memory pruned too, so an expired entry is not resurrected by a write.
    for (const [k, at] of this.memory) if (at < cutoff) this.memory.delete(k);
    return out;
  }

  private readDisk(): Map<string, number> {
    const out = new Map<string, number>();
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return out; // missing or unreadable: empty list
    }
    try {
      const parsed = JSON.parse(text) as Partial<PersistShape> | null;
      const entries = parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
      for (const e of entries) {
        if (
          e &&
          typeof e.account === "string" &&
          typeof e.mailbox === "string" &&
          e.account &&
          e.mailbox &&
          typeof e.recordedAt === "number" &&
          Number.isFinite(e.recordedAt)
        ) {
          out.set(`${e.account}${STALLED_KEY_SEP}${e.mailbox}`, e.recordedAt);
        }
      }
    } catch (err) {
      console.error(`Ignoring unreadable stalled-mailbox list ${this.file}: ${String(err)}`);
    }
    return out;
  }

  private persist(entries: Map<string, number>): void {
    const data: PersistShape = {
      version: 1,
      entries: Array.from(entries, ([k, recordedAt]) => {
        const i = k.indexOf(STALLED_KEY_SEP);
        return { account: k.slice(0, i), mailbox: k.slice(i + 1), recordedAt };
      }),
    };
    const file = this.file;
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
      renameSync(tmp, file);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // nothing to clean up
      }
      console.error(`Failed to persist stalled-mailbox list to ${file}: ${String(err)}`);
    }
  }
}
