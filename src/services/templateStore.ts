/**
 * Persistent email-template store (B3 / audit #14).
 *
 * Templates used to live in an in-memory Map that was lost on every server
 * restart (and `nextTemplateId` reset to 1, colliding ids across restarts).
 * This persists them to a JSON file so they survive restarts. The file path is
 * `APPLE_MAIL_MCP_TEMPLATES_FILE` or, by default,
 * `~/Library/Application Support/apple-mail-mcp/templates.json`.
 *
 * @module services/templateStore
 */
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join, resolve } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import type { EmailTemplate } from "@/types.js";

interface PersistShape {
  version: 1;
  nextId: number;
  templates: EmailTemplate[];
}

interface TemplateSnapshot {
  nextId: number;
  templates: Map<string, EmailTemplate>;
}

interface LockTicket {
  pid: number;
  /** Null while this contender is choosing its number. */
  number: number | null;
}

const LOCK_WAIT_MS = 5_000;
const waitWord = new Int32Array(new SharedArrayBuffer(4));

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** PID reuse or an unreadable process conservatively counts as a live owner. */
function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function liveTickets(dir: string): Array<LockTicket & { name: string }> {
  const live: Array<LockTicket & { name: string }> = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue; // unpublished private staging files
    const path = join(dir, name);
    let ticket: LockTicket;
    try {
      ticket = JSON.parse(readFileSync(path, "utf8")) as LockTicket;
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue; // owner just released it
      throw error;
    }
    if (
      !ticket ||
      !Number.isSafeInteger(ticket.pid) ||
      ticket.pid <= 0 ||
      (ticket.number !== null && (!Number.isSafeInteger(ticket.number) || ticket.number <= 0))
    ) {
      throw new Error(`Invalid template lock ticket at ${path}; no templates were changed.`);
    }
    if (!processIsAlive(ticket.pid)) {
      // Every attempt has a unique path. Unlike unlinking a shared stale lock,
      // this cannot accidentally delete a newly acquired successor's lock.
      try {
        unlinkSync(path);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      continue;
    }
    live.push({ ...ticket, name });
  }
  return live;
}

/**
 * Cross-process Lamport bakery lock using atomically published ticket files.
 * Publish choosing → choose max+1 → publish number → wait for choosing/lower
 * contenders. The choosing phase is essential: a late arrival must observe an
 * active owner's number and wait behind it, even if its unique name sorts first.
 * Dead owners are reaped by PID; live or reused PIDs are never stolen by age.
 */
function withTemplateLock<T>(file: string, operation: (path: string) => T): T {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  let target: string;
  try {
    target = realpathSync(file);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    // A dangling final symlink has no canonical target yet. Renaming over it
    // would silently replace the link and split sessions using the target path.
    if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(
        `Cannot update templates through a dangling symlink at ${file}; no templates were changed.`
      );
    }
    target = join(realpathSync(dirname(file)), basename(file));
  }
  const dir = `${target}.lock`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockStat = lstatSync(dir);
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
    throw new Error(`Template lock path is not a directory: ${dir}`);
  }
  const name = `${randomUUID()}-${process.pid}.json`;
  const own = join(dir, name);
  const staging = join(dir, `.${name}`);
  const publish = (number: number | null): void => {
    writeFileSync(staging, JSON.stringify({ pid: process.pid, number }), {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(staging, own);
  };
  try {
    publish(null);
    const number = liveTickets(dir).reduce((max, t) => Math.max(max, t.number ?? 0), 0) + 1;
    if (!Number.isSafeInteger(number)) throw new Error("Template lock ticket limit reached.");
    publish(number);
    const deadline = performance.now() + LOCK_WAIT_MS;
    while (
      liveTickets(dir).some(
        (t) =>
          t.name !== name &&
          (t.number === null || t.number < number || (t.number === number && t.name < name))
      )
    ) {
      if (performance.now() >= deadline) {
        throw new Error(
          "Another session is updating templates; no templates were changed. Retry shortly."
        );
      }
      Atomics.wait(waitWord, 0, 0, 10);
    }
    return operation(target);
  } finally {
    for (const path of [own, staging]) {
      try {
        unlinkSync(path);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          console.error(`Failed to release template lock ${path}: ${String(error)}`);
        }
      }
    }
  }
}

function defaultTemplatesFile(): string {
  const env = process.env.APPLE_MAIL_MCP_TEMPLATES_FILE;
  if (env && env.trim()) return env.trim();
  return join(homedir(), "Library", "Application Support", "apple-mail-mcp", "templates.json");
}

export class TemplateStore {
  private readonly file: string;

  constructor(file?: string) {
    this.file = resolve(file ?? defaultTemplatesFile());
  }

  /** Read a fresh snapshot. Reads tolerate corruption; mutations never overwrite it. */
  private load(file = this.file, strict = false): TemplateSnapshot {
    const snapshot: TemplateSnapshot = { nextId: 1, templates: new Map() };
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PersistShape>;
      if (parsed.version !== 1 || !Array.isArray(parsed.templates)) {
        throw new Error("Unsupported template file format");
      }
      for (const t of parsed.templates) {
        if (!t || typeof t.id !== "string") throw new Error("Invalid stored template");
        snapshot.templates.set(t.id, t);
        const id = /^tmpl_(\d+)$/.exec(t.id);
        if (id && Number.isSafeInteger(Number(id[1]))) {
          snapshot.nextId = Math.max(snapshot.nextId, Number(id[1]) + 1);
        }
      }
      if (Number.isSafeInteger(parsed.nextId) && parsed.nextId! > 0) {
        snapshot.nextId = Math.max(snapshot.nextId, parsed.nextId!);
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") return snapshot;
      if (strict) throw new Error(`Cannot update templates at ${file}: ${String(error)}`);
      console.error(`Failed to load templates from ${file}: ${String(error)}`);
      return { nextId: 1, templates: new Map() };
    }
    return snapshot;
  }

  private persist(file: string, snapshot: TemplateSnapshot): void {
    const data: PersistShape = {
      version: 1,
      nextId: snapshot.nextId,
      templates: Array.from(snapshot.templates.values()),
    };
    const staging = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(staging, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(data, null, 2) + "\n");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(staging, file);
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch (error) {
          console.error(`Failed to close template staging file ${staging}: ${String(error)}`);
        }
      }
      try {
        unlinkSync(staging);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          console.error(`Failed to remove template staging file ${staging}: ${String(error)}`);
        }
      }
    }
  }

  list(): EmailTemplate[] {
    return Array.from(this.load().templates.values());
  }

  get(id: string): EmailTemplate | null {
    return this.load().templates.get(id) ?? null;
  }

  /** Create or update a template, then persist. */
  save(
    name: string,
    subject: string,
    body: string,
    to?: string[],
    cc?: string[],
    id?: string
  ): EmailTemplate {
    return withTemplateLock(this.file, (file) => {
      const snapshot = this.load(file, true);
      if (!id && !Number.isSafeInteger(snapshot.nextId)) {
        throw new Error("Template id limit reached; no templates were changed.");
      }
      const templateId = id || `tmpl_${snapshot.nextId++}`;
      const template: EmailTemplate = { id: templateId, name, subject, body, to, cc };
      snapshot.templates.set(templateId, template);
      this.persist(file, snapshot);
      return template;
    });
  }

  /** Delete a template, persisting the change. Returns false if absent. */
  delete(id: string): boolean {
    return withTemplateLock(this.file, (file) => {
      const snapshot = this.load(file, true);
      const existed = snapshot.templates.delete(id);
      if (existed) this.persist(file, snapshot);
      return existed;
    });
  }
}
