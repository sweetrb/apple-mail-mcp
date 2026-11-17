import { describe, it, expect } from "vitest";
import { TOOL_ANNOTATIONS, annotationsFor } from "@/tools/toolAnnotations.js";
import { READ_ONLY_TOOLS, SENDING_TOOLS, WRITING_TOOLS } from "@/utils/toolMode.js";

describe("toolAnnotations", () => {
  it("refuses a tool with no classification", () => {
    expect(() => annotationsFor("no-such-tool")).toThrow(/no entry/);
  });

  it("lets a registration add hints but keeps the table's classification", () => {
    expect(annotationsFor("get-message-headers", { title: "Headers" })).toMatchObject({
      readOnlyHint: true,
      title: "Headers",
    });
  });

  it("classifies every tool the APPLE_MAIL_MCP_MODE gate knows about", () => {
    const unclassified = [...SENDING_TOOLS, ...READ_ONLY_TOOLS, ...WRITING_TOOLS].filter(
      (name) => !(name in TOOL_ANNOTATIONS)
    );
    expect(unclassified).toEqual([]);
  });

  it("never marks a tool both read-only and destructive", () => {
    const both = Object.entries(TOOL_ANNOTATIONS)
      .filter(([, a]) => a.readOnlyHint && a.destructiveHint)
      .map(([n]) => n);
    expect(both).toEqual([]);
  });
});
