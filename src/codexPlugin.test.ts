import { describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = (file: string) => JSON.parse(readFileSync(join(root, file), "utf8"));
const portable = json("codex/plugin.json");
const legacy = json("codex/.codex-plugin/plugin.json");
const version = json("package.json").version;

describe("portable Codex plugin", () => {
  it("keeps installation opt-in and server enablement under user control", () => {
    const entries = json(".agents/plugins/marketplace.json").plugins;
    const entry = entries.find((plugin: { name: string }) => plugin.name === portable.name);
    expect(
      entries.filter((plugin: { name: string }) => plugin.name === portable.name)
    ).toHaveLength(1);
    expect(entry.policy).toEqual({ installation: "AVAILABLE", authentication: "ON_INSTALL" });
    expect(entry).not.toHaveProperty("enabled");
    for (const manifest of [portable, legacy, portable.extensions["com.openai"]]) {
      expect(manifest).not.toHaveProperty("enabled");
      expect(manifest).not.toHaveProperty("hooks");
    }
    for (const file of ["codex/mcp.json", "codex/.mcp.json"]) {
      expect(json(file).mcpServers["apple-mail"]).not.toHaveProperty("enabled");
    }
    expect(existsSync(join(root, "codex/hooks/hooks.json"))).toBe(false);
    expect(existsSync(join(root, "codex/.codex/config.toml"))).toBe(false);
    const skill = readFileSync(join(root, "skills/apple-mail/SKILL.md"), "utf8");
    expect(skill).toContain("Do not enable");
    expect(skill).toContain(
      "either or override a disabled setting unless the user explicitly requests it."
    );
  });

  it("preserves identity, publisher, presentation, and release parity", () => {
    expect(portable.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    for (const key of [
      "name",
      "description",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
    ]) {
      expect(portable[key]).toEqual(legacy[key]);
    }
    expect(portable.version).toBe(version);
    expect(legacy.version).toBe(version);
    expect(portable.extensions["com.openai"]).toEqual({ interface: legacy.interface });
    const entry = json(".agents/plugins/marketplace.json").plugins.find(
      (plugin: { name: string }) => plugin.name === portable.name
    );
    expect(entry.source).toEqual({ source: "local", path: "./codex" });
    expect(entry.version).toBe(version);
  });

  it("ships typed portable stdio wiring identical to the compatibility launcher", () => {
    const config = json("codex/mcp.json");
    expect(config.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    expect(Object.keys(config.mcpServers)).toEqual(["apple-mail"]);
    const { type, ...server } = config.mcpServers["apple-mail"];
    expect(type).toBe("stdio");
    expect(server).toEqual(json("codex/.mcp.json").mcpServers["apple-mail"]);
    expect(server).toEqual({ command: "npx", args: ["-y", `apple-mail-mcp@${version}`] });
    expect(JSON.stringify([portable, config])).not.toMatch(/\/Users\/|\/home\/|clientSecret/);
  });

  it("keeps the OpenAI presentation summary within its 30-character limit", () => {
    const summary = portable.extensions["com.openai"].interface.shortDescription;
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(30);
  });

  it("resolves bundled assets and generated skills from the portable root", () => {
    const ui = portable.extensions["com.openai"].interface;
    for (const path of [ui.composerIcon, ui.logo, ...ui.screenshots]) {
      expect(path).toMatch(/^\.\/assets\//);
      expect(existsSync(join(root, "codex", path))).toBe(true);
    }
    const source = readFileSync(join(root, "skills/apple-mail/SKILL.md"), "utf8");
    for (const copy of [
      "codex/skills/apple-mail/SKILL.md",
      ".antigravity-plugin/skills/apple-mail/SKILL.md",
    ]) {
      expect(readFileSync(join(root, copy), "utf8")).toBe(source);
    }
    expect(source).toContain("font-size: inherit;");
    expect(source).toContain("computer control supplied by the host");
    expect(source).toContain("actual From");
    expect(source).not.toContain("render-authored-body.mjs");
  });

  it("detects and repairs portable release and compatibility drift", () => {
    const fixture = mkdtempSync(join(tmpdir(), "apple-mail-plugin-sync-"));
    try {
      for (const dir of ["codex", ".claude-plugin", ".agents", ".antigravity-plugin"]) {
        cpSync(join(root, dir), join(fixture, dir), { recursive: true });
      }
      writeFileSync(
        join(fixture, "package.json"),
        JSON.stringify({ name: "apple-mail-mcp", version: "9.8.7" })
      );
      const run = (args: string[] = []) =>
        spawnSync(process.execPath, [join(root, "scripts/sync-plugin-version.mjs"), ...args], {
          cwd: fixture,
          encoding: "utf8",
        });
      expect(run(["--check"]).status).toBe(1);
      expect(run().status).toBe(0);
      expect(run(["--check"]).status).toBe(0);
      const read = (path: string) => JSON.parse(readFileSync(join(fixture, path), "utf8"));
      expect(read("codex/plugin.json").version).toBe("9.8.7");
      for (const file of ["codex/mcp.json", "codex/.mcp.json"]) {
        expect(read(file).mcpServers["apple-mail"].args).toContain("apple-mail-mcp@9.8.7");
      }
      const changed = read("codex/plugin.json");
      changed.name = "wrong-identity";
      changed.extensions["com.openai"].interface.displayName = "Wrong";
      changed.extensions["org.example"] = { retained: true };
      writeFileSync(join(fixture, "codex/plugin.json"), JSON.stringify(changed));
      expect(run(["--check"]).status).toBe(1);
      expect(run().status).toBe(0);
      expect(run(["--check"]).status).toBe(0);
      expect(read("codex/plugin.json").extensions["org.example"]).toEqual({ retained: true });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
