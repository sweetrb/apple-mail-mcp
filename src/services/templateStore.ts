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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import type { EmailTemplate } from "@/types.js";

interface PersistShape {
  version: 1;
  nextId: number;
  templates: EmailTemplate[];
}

function defaultTemplatesFile(): string {
  const env = process.env.APPLE_MAIL_MCP_TEMPLATES_FILE;
  if (env && env.trim()) return env.trim();
  return join(homedir(), "Library", "Application Support", "apple-mail-mcp", "templates.json");
}

export class TemplateStore {
  private readonly file: string;
  private templates = new Map<string, EmailTemplate>();
  private nextId = 1;
  private loaded = false;

  constructor(file?: string) {
    this.file = file ?? defaultTemplatesFile();
  }

  /** Lazily load from disk on first access; tolerates a missing/corrupt file. */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.file)) return;
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PersistShape>;
      if (Array.isArray(parsed.templates)) {
        for (const t of parsed.templates) {
          if (t && typeof t.id === "string") this.templates.set(t.id, t);
        }
      }
      if (typeof parsed.nextId === "number" && parsed.nextId > 0) this.nextId = parsed.nextId;
    } catch (err) {
      console.error(`Failed to load templates from ${this.file}: ${String(err)}`);
    }
  }

  private persist(): void {
    const data: PersistShape = {
      version: 1,
      nextId: this.nextId,
      templates: Array.from(this.templates.values()),
    };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(data, null, 2) + "\n");
    } catch (err) {
      // Don't fail the operation; the in-memory copy is still usable this session.
      console.error(`Failed to persist templates to ${this.file}: ${String(err)}`);
    }
  }

  list(): EmailTemplate[] {
    this.ensureLoaded();
    return Array.from(this.templates.values());
  }

  get(id: string): EmailTemplate | null {
    this.ensureLoaded();
    return this.templates.get(id) ?? null;
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
    this.ensureLoaded();
    const templateId = id || `tmpl_${this.nextId++}`;
    const template: EmailTemplate = { id: templateId, name, subject, body, to, cc };
    this.templates.set(templateId, template);
    this.persist();
    return template;
  }

  /** Delete a template, persisting the change. Returns false if absent. */
  delete(id: string): boolean {
    this.ensureLoaded();
    const existed = this.templates.delete(id);
    if (existed) this.persist();
    return existed;
  }
}
