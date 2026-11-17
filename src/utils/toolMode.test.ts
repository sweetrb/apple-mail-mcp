import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  READ_ONLY_TOOLS,
  SENDING_TOOLS,
  WRITING_TOOLS,
  isToolAllowed,
  parseToolMode,
  resolveToolMode,
  withSafetyAnnotations,
} from "@/utils/toolMode.js";

/** Tool names registered in src/index.ts (`registerTool(\n  "name",`). */
function registeredToolNames(): string[] {
  const source = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
  return [...source.matchAll(/registerTool\(\s*"([a-z0-9-]+)"/g)].map((match) => match[1]);
}

describe("APPLE_MAIL_MCP_MODE tool gate", () => {
  it("classifies every registered tool in exactly one set", () => {
    const names = registeredToolNames();
    expect(names.length).toBeGreaterThanOrEqual(50);
    for (const name of names) {
      const sets = [SENDING_TOOLS, READ_ONLY_TOOLS, WRITING_TOOLS].filter((set) => set.has(name));
      expect(sets.length, `${name} must be in exactly one of the tool sets`).toBe(1);
    }
    for (const set of [SENDING_TOOLS, READ_ONLY_TOOLS, WRITING_TOOLS]) {
      for (const name of set) expect(names, `${name} is not a registered tool`).toContain(name);
    }
  });

  it("defaults to full and rejects unknown modes instead of opening up", () => {
    expect(parseToolMode(undefined)).toBe("full");
    expect(parseToolMode(" NO_SEND ")).toBe("no_send");
    expect(() => parseToolMode("readonly")).toThrow(/must be one of/);
  });

  it("stops when the config file names the mode but it was not applied", () => {
    expect(() => resolveToolMode({}, '{"APPLE_MAIL_MCP_MODE": "read_only",}')).toThrow(
      /was not applied/
    );
    expect(() => resolveToolMode({}, '{"env": {"APPLE_MAIL_MCP_MODE": "read_only"}}')).toThrow(
      /was not applied/
    );
    expect(
      resolveToolMode({ APPLE_MAIL_MCP_MODE: "read_only" }, '{"APPLE_MAIL_MCP_MODE": "read_only"}')
    ).toBe("read_only");
    expect(resolveToolMode({}, '{"APPLE_MAIL_MCP_IMAP_HOST": "x"}')).toBe("full");
    expect(resolveToolMode({}, undefined)).toBe("full");
  });

  it("stops when the config file exists but cannot be read, unless the mode is already set", () => {
    expect(() => resolveToolMode({}, undefined, "EACCES")).toThrow(/could not be read \(EACCES\)/);
    expect(resolveToolMode({ APPLE_MAIL_MCP_MODE: "read_only" }, undefined, "EACCES")).toBe(
      "read_only"
    );
    expect(resolveToolMode({}, undefined, undefined)).toBe("full");
  });

  it("no_send drops every sending tool, rule enabling included, and keeps drafts and organizing", () => {
    for (const name of SENDING_TOOLS) expect(isToolAllowed(name, "no_send")).toBe(false);
    expect(isToolAllowed("enable-rule", "no_send")).toBe(false);
    expect(isToolAllowed("create-draft", "no_send")).toBe(true);
    expect(isToolAllowed("batch-delete-messages", "no_send")).toBe(true);
  });

  it("read_only is an allow-list: writers and unknown tools are out", () => {
    expect(isToolAllowed("search-messages", "read_only")).toBe(true);
    expect(isToolAllowed("fetch-attachment", "read_only")).toBe(true);
    for (const name of [
      "send-email",
      "create-draft",
      "save-attachment",
      "get-message-rfc822",
      "delete-rule",
      "use-template",
      "some-future-tool",
    ]) {
      expect(isToolAllowed(name, "read_only")).toBe(false);
    }
  });

  it("marks sending and deleting tools destructive and reads read-only", () => {
    expect(withSafetyAnnotations("send-email", { openWorldHint: true })).toEqual({
      openWorldHint: true,
      destructiveHint: true,
    });
    expect(withSafetyAnnotations("search-messages", {})).toEqual({ readOnlyHint: true });
    expect(withSafetyAnnotations("create-draft", undefined)).toBeUndefined();
    expect(withSafetyAnnotations("delete-message", undefined)).toEqual({
      destructiveHint: true,
    });
  });
});
