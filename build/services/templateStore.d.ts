import type { EmailTemplate } from "../types.js";
export declare class TemplateStore {
    private readonly file;
    private templates;
    private nextId;
    private loaded;
    constructor(file?: string);
    /** Lazily load from disk on first access; tolerates a missing/corrupt file. */
    private ensureLoaded;
    private persist;
    list(): EmailTemplate[];
    get(id: string): EmailTemplate | null;
    /** Create or update a template, then persist. */
    save(name: string, subject: string, body: string, to?: string[], cc?: string[], id?: string): EmailTemplate;
    /** Delete a template, persisting the change. Returns false if absent. */
    delete(id: string): boolean;
}
//# sourceMappingURL=templateStore.d.ts.map