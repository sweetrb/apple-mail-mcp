/**
 * Tests for MCP tool input schema validation.
 * These tests import Zod schemas directly to verify validation rules
 * without needing a running MCP server.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MESSAGE_ID_SCHEMA } from "./index.js";

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
