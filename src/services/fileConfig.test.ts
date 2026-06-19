import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadFileConfig, fileConfigPath } from "@/services/fileConfig.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amcp-cfg-"));
  file = join(dir, "config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadFileConfig (2.1.1)", () => {
  it("applies file values for keys not already in env", () => {
    writeFileSync(
      file,
      JSON.stringify({ APPLE_MAIL_MCP_IMAP_USER: "me@x.com", APPLE_MAIL_MCP_IMAP_IDLE: "1" })
    );
    const env: NodeJS.ProcessEnv = {};
    const applied = loadFileConfig(env, file);
    expect(env.APPLE_MAIL_MCP_IMAP_USER).toBe("me@x.com");
    expect(env.APPLE_MAIL_MCP_IMAP_IDLE).toBe("1");
    expect(applied.sort()).toEqual(["APPLE_MAIL_MCP_IMAP_IDLE", "APPLE_MAIL_MCP_IMAP_USER"]);
  });

  it("never overrides a value already set in the environment", () => {
    writeFileSync(file, JSON.stringify({ APPLE_MAIL_MCP_IMAP_USER: "file@x.com" }));
    const env: NodeJS.ProcessEnv = { APPLE_MAIL_MCP_IMAP_USER: "env@x.com" };
    loadFileConfig(env, file);
    expect(env.APPLE_MAIL_MCP_IMAP_USER).toBe("env@x.com");
  });

  it("treats empty-string env as unset and fills it", () => {
    writeFileSync(file, JSON.stringify({ APPLE_MAIL_MCP_IMAP_HOST: "imap.gmail.com" }));
    const env: NodeJS.ProcessEnv = { APPLE_MAIL_MCP_IMAP_HOST: "" };
    loadFileConfig(env, file);
    expect(env.APPLE_MAIL_MCP_IMAP_HOST).toBe("imap.gmail.com");
  });

  it("ignores non-string values", () => {
    writeFileSync(file, JSON.stringify({ A: "ok", B: 5, C: true, D: { x: 1 } }));
    const env: NodeJS.ProcessEnv = {};
    const applied = loadFileConfig(env, file);
    expect(applied).toEqual(["A"]);
  });

  it("tolerates a missing file and a corrupt file", () => {
    expect(loadFileConfig({}, join(dir, "nope.json"))).toEqual([]);
    writeFileSync(file, "{ not json");
    expect(loadFileConfig({}, file)).toEqual([]);
  });

  it("defaults the path to the app-support dir, honoring the override env", () => {
    expect(fileConfigPath({})).toMatch(/apple-mail-mcp\/config\.json$/);
    expect(fileConfigPath({ APPLE_MAIL_MCP_CONFIG_FILE: "/tmp/x.json" })).toBe("/tmp/x.json");
  });
});
