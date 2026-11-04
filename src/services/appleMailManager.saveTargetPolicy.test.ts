/**
 * Save-target policy (2.20.54): a save path is untrusted input, because email
 * content steers the model. The write side now enforces the same protected-path
 * rules as the read side and accepts only document folders plus explicit roots.
 * Reported privately by Alejandro San Martin Lamas.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { resolveAttachmentSaveTarget } from "@/services/appleMailManager.js";
import { ATTACHMENT_SAVE_ROOTS_ENV } from "@/utils/attachmentReadPolicy.js";

let base = "";
let home = "";
const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };

beforeAll(() => {
  // /var/tmp is in no default save root on macOS or Linux, so the fake home is
  // not accidentally inside /tmp or the temp directory.
  base = realpathSync.native(mkdtempSync("/var/tmp/amcp-save-"));
  home = join(base, "home");
  for (const d of [
    "Downloads",
    "Documents",
    "Projects",
    join("Library", "LaunchAgents"),
    join("Library", "Application Support", "apple-mail-mcp"),
    join("Library", "Mobile Documents", "com~apple~CloudDocs"),
    ".config",
    join("Downloads", ".hidden"),
  ]) {
    mkdirSync(join(home, d), { recursive: true });
  }
  mkdirSync(join(base, "tmp"));
  symlinkSync(join(home, "Library", "LaunchAgents"), join(home, "Downloads", "agents"));
  writeFileSync(join(home, "Downloads", "exists.pdf"), "x");
  process.env.HOME = home;
  process.env.TMPDIR = join(base, "tmp");
});

afterAll(() => {
  process.env.HOME = saved.HOME;
  if (saved.TMPDIR === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = saved.TMPDIR;
  rmSync(base, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...extra });

describe("resolveAttachmentSaveTarget — allowed", () => {
  it("saves into Downloads, Documents and iCloud Drive", () => {
    for (const d of [
      "Downloads",
      "Documents",
      join("Library", "Mobile Documents", "com~apple~CloudDocs"),
    ]) {
      const t = resolveAttachmentSaveTarget(join(home, d), "a.pdf", env());
      expect(t.savedPath).toBe(join(home, d, "a.pdf"));
    }
  });

  it("saves into a root named in APPLE_MAIL_MCP_ATTACHMENT_SAVE_ROOTS", () => {
    const projects = join(home, "Projects");
    expect(() => resolveAttachmentSaveTarget(projects, "a.pdf", env())).toThrow(/outside allowed/);
    const t = resolveAttachmentSaveTarget(
      projects,
      "a.pdf",
      env({ [ATTACHMENT_SAVE_ROOTS_ENV]: projects })
    );
    expect(t.saveDirectory).toBe(projects);
  });
});

describe("resolveAttachmentSaveTarget — refused", () => {
  it("refuses ~/Library/LaunchAgents (the reported persistence path)", () => {
    expect(() =>
      resolveAttachmentSaveTarget(join(home, "Library", "LaunchAgents"), "x.plist", env())
    ).toThrow(/protected location/);
  });

  it("refuses this server's own config directory", () => {
    expect(() =>
      resolveAttachmentSaveTarget(
        join(home, "Library", "Application Support", "apple-mail-mcp"),
        "config.json",
        env()
      )
    ).toThrow(/protected location/);
  });

  it("refuses the home folder itself, so ~/.zshenv cannot be created", () => {
    expect(() => resolveAttachmentSaveTarget(home, ".zshenv", env())).toThrow();
    expect(() => resolveAttachmentSaveTarget(home, "notes.txt", env())).toThrow(/outside allowed/);
  });

  it("refuses hidden folders and hidden file names, even inside Downloads", () => {
    expect(() => resolveAttachmentSaveTarget(join(home, ".config"), "a", env())).toThrow(
      /protected/
    );
    expect(() =>
      resolveAttachmentSaveTarget(join(home, "Downloads", ".hidden"), "a", env())
    ).toThrow(/protected/);
    expect(() => resolveAttachmentSaveTarget(join(home, "Downloads"), ".zshenv", env())).toThrow(
      /protected/
    );
  });

  it("refuses a symlink in Downloads that points into the Library", () => {
    expect(() =>
      resolveAttachmentSaveTarget(join(home, "Downloads", "agents"), "x.plist", env())
    ).toThrow(/protected location/);
  });

  it("an explicit root holding the whole home folder does not lift the Library rule", () => {
    const e = env({ [ATTACHMENT_SAVE_ROOTS_ENV]: home });
    expect(() =>
      resolveAttachmentSaveTarget(join(home, "Library", "LaunchAgents"), "x.plist", e)
    ).toThrow(/protected location/);
    expect(() => resolveAttachmentSaveTarget(home, ".zprofile", e)).toThrow(/protected/);
  });

  it("still refuses to overwrite and to traverse out", () => {
    expect(() => resolveAttachmentSaveTarget(join(home, "Downloads"), "exists.pdf", env())).toThrow(
      /overwrite/
    );
    expect(() =>
      resolveAttachmentSaveTarget(join(home, "Downloads"), "../Projects/x", env())
    ).toThrow(/outside allowed/);
  });
});
