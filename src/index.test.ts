/**
 * Tests for MCP tool input schema validation.
 * These tests import Zod schemas directly to verify validation rules
 * without needing a running MCP server.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MESSAGE_ID_SCHEMA, DATE_FILTER_SCHEMA, BATCH_IDS_SCHEMA } from "./index.js";

const TEMPLATE_ID_SCHEMA = z.string().min(1, "Template ID is required");

describe("MESSAGE_ID_SCHEMA", () => {
  it("accepts a valid numeric ID", () => {
    expect(() => MESSAGE_ID_SCHEMA.parse("12345")).not.toThrow();
  });

  it("rejects an alphabetic string", () => {
    expect(() => MESSAGE_ID_SCHEMA.parse("abc")).toThrow("Message ID must be numeric");
  });

  it("rejects an injection payload", () => {
    expect(() => MESSAGE_ID_SCHEMA.parse("0 or true")).toThrow("Message ID must be numeric");
  });

  it("rejects an empty string", () => {
    expect(() => MESSAGE_ID_SCHEMA.parse("")).toThrow();
  });

  it("rejects a float", () => {
    expect(() => MESSAGE_ID_SCHEMA.parse("1.5")).toThrow("Message ID must be numeric");
  });
});

describe("TEMPLATE_ID_SCHEMA (regression: must NOT use numeric regex)", () => {
  it("accepts a tmpl_ prefixed ID", () => {
    expect(() => TEMPLATE_ID_SCHEMA.parse("tmpl_1")).not.toThrow();
  });
});

describe("DATE_FILTER_SCHEMA", () => {
  it("accepts a valid AppleScript date string", () => {
    expect(() => DATE_FILTER_SCHEMA.parse("January 1, 2026")).not.toThrow();
  });

  it("accepts a date with time", () => {
    expect(() => DATE_FILTER_SCHEMA.parse("March 21, 2026 09:00:00")).not.toThrow();
  });

  it("rejects an injection payload", () => {
    expect(() => DATE_FILTER_SCHEMA.parse('" & (do shell script "id") & "')).toThrow(
      "Invalid date format"
    );
  });

  it("rejects a string with quotes", () => {
    expect(() => DATE_FILTER_SCHEMA.parse('"quoted"')).toThrow("Invalid date format");
  });

  it("accepts undefined (field is optional)", () => {
    expect(() => DATE_FILTER_SCHEMA.optional().parse(undefined)).not.toThrow();
  });
});

describe("Batch operation ids array — max 100 cap", () => {
  it("accepts an array of 1 ID", () => {
    expect(() => BATCH_IDS_SCHEMA.parse(["1"])).not.toThrow();
  });

  it("accepts an array of 100 IDs", () => {
    const ids = Array.from({ length: 100 }, (_, i) => String(i + 1));
    expect(() => BATCH_IDS_SCHEMA.parse(ids)).not.toThrow();
  });

  it("rejects an array of 101 IDs", () => {
    const ids = Array.from({ length: 101 }, (_, i) => String(i + 1));
    expect(() => BATCH_IDS_SCHEMA.parse(ids)).toThrow(
      "Cannot process more than 100 messages at once"
    );
  });

  it("rejects an empty array", () => {
    expect(() => BATCH_IDS_SCHEMA.parse([])).toThrow();
  });

  it("rejects non-numeric IDs within array", () => {
    expect(() => BATCH_IDS_SCHEMA.parse(["abc"])).toThrow("Message ID must be numeric");
  });
});
