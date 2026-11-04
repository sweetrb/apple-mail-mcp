import { describe, it, expect } from "vitest";
import { TOOL_ANNOTATIONS, annotationsFor } from "@/tools/toolAnnotations.js";

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

  it("never marks a tool both read-only and destructive", () => {
    const both = Object.entries(TOOL_ANNOTATIONS)
      .filter(([, a]) => a.readOnlyHint && a.destructiveHint)
      .map(([n]) => n);
    expect(both).toEqual([]);
  });
});
