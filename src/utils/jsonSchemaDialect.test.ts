import { describe, it, expect, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSON_SCHEMA_2020_12,
  normalizeOutgoingMessage,
  toJsonSchema2020_12,
  withJsonSchema2020_12,
} from "@/utils/jsonSchemaDialect.js";

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

describe("toJsonSchema2020_12", () => {
  it("stamps the 2020-12 dialect at the root", () => {
    const out = toJsonSchema2020_12({ type: "object", properties: { a: { type: "string" } } }) as {
      $schema: string;
      type: string;
    };
    expect(out.$schema).toBe(JSON_SCHEMA_2020_12);
    expect(out.type).toBe("object");
  });

  it("replaces a draft-07 root $schema instead of keeping it", () => {
    const out = toJsonSchema2020_12({ $schema: DRAFT_07, type: "object" }) as { $schema: string };
    expect(out.$schema).toBe(JSON_SCHEMA_2020_12);
    expect(JSON.stringify(out)).not.toContain("draft-07");
  });

  it("strips $schema from nested subschemas — only the root declares a dialect", () => {
    const out = toJsonSchema2020_12({
      type: "object",
      properties: {
        nested: { $schema: DRAFT_07, type: "string" },
        list: { type: "array", items: { $schema: DRAFT_07, type: "number" } },
      },
    }) as Record<string, never>;
    const json = JSON.stringify(out);
    expect(json).not.toContain("draft-07");
    // Exactly one $schema in the whole document, and it is the root's.
    expect(json.match(/"\$schema"/g)).toHaveLength(1);
    expect((out as unknown as { $schema: string }).$schema).toBe(JSON_SCHEMA_2020_12);
  });

  it("returns a non-object schema untouched", () => {
    expect(toJsonSchema2020_12(true)).toBe(true);
    expect(toJsonSchema2020_12(null)).toBe(null);
    expect(toJsonSchema2020_12("not-a-schema")).toBe("not-a-schema");
  });

  it("renames definitions to $defs and rewrites #/definitions/X refs to #/$defs/X", () => {
    const out = toJsonSchema2020_12({
      type: "object",
      definitions: { Row: { type: "object" } },
      properties: {
        row: { $ref: "#/definitions/Row" },
        other: { $ref: "#/properties/row" },
      },
    }) as {
      $defs: Record<string, unknown>;
      definitions?: unknown;
      properties: { row: { $ref: string }; other: { $ref: string } };
    };
    expect(out.$defs).toEqual({ Row: { type: "object" } });
    expect(out.definitions).toBeUndefined();
    expect(out.properties.row.$ref).toBe("#/$defs/Row");
    // A ref that does not point into definitions is left exactly as-is.
    expect(out.properties.other.$ref).toBe("#/properties/row");
  });

  it("leaves a non-string $ref alone", () => {
    const out = toJsonSchema2020_12({ $ref: 42 }) as { $ref: unknown };
    expect(out.$ref).toBe(42);
  });

  it("converts tuple items to prefixItems and additionalItems to items", () => {
    const out = toJsonSchema2020_12({
      type: "array",
      items: [{ type: "string" }, { $schema: DRAFT_07, type: "number" }],
      additionalItems: { type: "boolean" },
    }) as { prefixItems: unknown[]; items: unknown; additionalItems?: unknown };
    expect(out.prefixItems).toEqual([{ type: "string" }, { type: "number" }]);
    expect(out.items).toEqual({ type: "boolean" });
    expect(out.additionalItems).toBeUndefined();
  });

  it("drops a stray additionalItems when items is NOT a tuple, rather than clobbering items", () => {
    const out = toJsonSchema2020_12({
      type: "array",
      items: { type: "string" },
      additionalItems: { type: "boolean" },
    }) as { items: unknown; prefixItems?: unknown; additionalItems?: unknown };
    expect(out.items).toEqual({ type: "string" });
    expect(out.prefixItems).toBeUndefined();
    expect(out.additionalItems).toBeUndefined();
  });

  it("splits dependencies into dependentRequired and dependentSchemas", () => {
    const out = toJsonSchema2020_12({
      type: "object",
      dependencies: {
        creditCard: ["billingAddress"],
        shipping: { $schema: DRAFT_07, type: "object", required: ["zip"] },
      },
    }) as {
      dependencies?: unknown;
      dependentRequired: Record<string, unknown>;
      dependentSchemas: Record<string, unknown>;
    };
    expect(out.dependencies).toBeUndefined();
    expect(out.dependentRequired).toEqual({ creditCard: ["billingAddress"] });
    expect(out.dependentSchemas).toEqual({ shipping: { type: "object", required: ["zip"] } });
  });

  it("emits neither dependent keyword for an empty or non-object dependencies", () => {
    const empty = toJsonSchema2020_12({ dependencies: {} }) as Record<string, unknown>;
    expect(empty.dependentRequired).toBeUndefined();
    expect(empty.dependentSchemas).toBeUndefined();
    const bogus = toJsonSchema2020_12({ dependencies: "nonsense" }) as Record<string, unknown>;
    expect(bogus.dependencies).toBeUndefined();
    expect(bogus.dependentRequired).toBeUndefined();
    expect(bogus.dependentSchemas).toBeUndefined();
  });

  it("collapses boolean exclusiveMinimum:true + minimum into a numeric exclusiveMinimum", () => {
    const out = toJsonSchema2020_12({
      type: "number",
      minimum: 5,
      exclusiveMinimum: true,
    }) as { exclusiveMinimum: unknown; minimum?: unknown };
    expect(out.exclusiveMinimum).toBe(5);
    expect(out.minimum).toBeUndefined();
  });

  it("collapses boolean exclusiveMaximum:true + maximum into a numeric exclusiveMaximum", () => {
    const out = toJsonSchema2020_12({
      type: "number",
      maximum: 10,
      exclusiveMaximum: true,
    }) as { exclusiveMaximum: unknown; maximum?: unknown };
    expect(out.exclusiveMaximum).toBe(10);
    expect(out.maximum).toBeUndefined();
  });

  it("drops exclusiveMinimum:false / exclusiveMaximum:false and keeps the bounds", () => {
    const out = toJsonSchema2020_12({
      type: "number",
      minimum: 1,
      exclusiveMinimum: false,
      maximum: 9,
      exclusiveMaximum: false,
    }) as Record<string, unknown>;
    expect(out.exclusiveMinimum).toBeUndefined();
    expect(out.exclusiveMaximum).toBeUndefined();
    expect(out.minimum).toBe(1);
    expect(out.maximum).toBe(9);
  });

  it("passes an already-numeric exclusiveMinimum/Maximum through unchanged", () => {
    const out = toJsonSchema2020_12({
      type: "number",
      exclusiveMinimum: 0,
      exclusiveMaximum: 100,
    }) as Record<string, unknown>;
    expect(out.exclusiveMinimum).toBe(0);
    expect(out.exclusiveMaximum).toBe(100);
  });

  it("keeps a boolean exclusiveMinimum:true with no numeric bound to convert", () => {
    // Nothing to fold it into, so it is preserved rather than silently dropped.
    const out = toJsonSchema2020_12({ type: "number", exclusiveMinimum: true }) as Record<
      string,
      unknown
    >;
    expect(out.exclusiveMinimum).toBe(true);
  });

  it("recurses through arrays of subschemas (anyOf) and leaves scalars alone", () => {
    const out = toJsonSchema2020_12({
      anyOf: [
        { $schema: DRAFT_07, type: "string" },
        { type: "array", items: [{ type: "string" }] },
        "scalar-in-an-array",
      ],
      description: "kept",
      nullable: null,
    }) as { anyOf: unknown[]; description: string; nullable: unknown };
    expect(out.anyOf[0]).toEqual({ type: "string" });
    expect(out.anyOf[1]).toEqual({ type: "array", prefixItems: [{ type: "string" }] });
    expect(out.anyOf[2]).toBe("scalar-in-an-array");
    expect(out.description).toBe("kept");
    expect(out.nullable).toBeNull();
  });
});

/**
 * Position-awareness: a "properties" map's keys are caller-chosen TOOL PARAMETER
 * NAMES, not schema keywords. Before the fix, convertNode recursed uniformly and
 * switched on every key it met, so a parameter named "definitions" was renamed to
 * "$defs", one named "$schema" was silently DELETED (while "required" still named
 * it — a schema no input can satisfy), and "dependencies"/"additionalItems" were
 * restructured or dropped. Likewise "enum"/"const"/"default"/"examples" hold
 * instance DATA, and recursing into them rewrote a caller's literal values.
 */
describe("toJsonSchema2020_12 — position awareness", () => {
  type Obj = Record<string, any>;

  it("keeps a tool parameter NAMED definitions under its own name, and still converts its subschema", () => {
    const out = toJsonSchema2020_12({
      type: "object",
      properties: {
        definitions: {
          // nested dialect declaration must still be stripped — proves the VALUE
          // is still recursed even though the KEY is left alone
          $schema: DRAFT_07,
          type: "array",
          items: [{ type: "string" }],
        },
      },
      required: ["definitions"],
    }) as Obj;

    expect(Object.keys(out.properties)).toEqual(["definitions"]);
    expect(out.properties.definitions).toEqual({
      type: "array",
      prefixItems: [{ type: "string" }],
    });
    // NOT renamed — neither on the properties map nor hoisted to the root
    expect(out.properties.$defs).toBeUndefined();
    expect(out.$defs).toBeUndefined();
    // required still names a property that exists
    expect(out.required).toEqual(["definitions"]);
    expect(Object.keys(out.properties)).toContain(out.required[0]);
  });

  it("PRESERVES a tool parameter NAMED $schema instead of deleting it, keeping required satisfiable", () => {
    const out = toJsonSchema2020_12({
      type: "object",
      properties: {
        $schema: { type: "string", description: "dialect URI to validate against" },
        payload: { type: "object" },
      },
      required: ["$schema"],
    }) as Obj;

    expect(out.properties.$schema).toEqual({
      type: "string",
      description: "dialect URI to validate against",
    });
    expect(out.required).toEqual(["$schema"]);
    // Every required name resolves to a declared property — the schema is satisfiable.
    for (const name of out.required) expect(Object.keys(out.properties)).toContain(name);
    // The ROOT still declares the dialect; the parameter is a separate thing.
    expect(out.$schema).toBe(JSON_SCHEMA_2020_12);
  });

  it("keeps tool parameters NAMED dependencies and additionalItems intact, names and values", () => {
    const out = toJsonSchema2020_12({
      type: "object",
      properties: {
        dependencies: { type: "array", items: { type: "string" } },
        additionalItems: { type: "boolean", description: "allow extras" },
      },
      required: ["dependencies", "additionalItems"],
    }) as Obj;

    expect(Object.keys(out.properties).sort()).toEqual(["additionalItems", "dependencies"]);
    expect(out.properties.dependencies).toEqual({ type: "array", items: { type: "string" } });
    expect(out.properties.additionalItems).toEqual({
      type: "boolean",
      description: "allow extras",
    });
    // The keyword rewrites must not have fired on the properties map.
    expect(out.properties.dependentRequired).toBeUndefined();
    expect(out.properties.dependentSchemas).toBeUndefined();
    expect(out.properties.items).toBeUndefined();
    expect(out.required).toEqual(["dependencies", "additionalItems"]);
  });

  it("still renames a REAL definitions block at a schema position and still rewrites #/definitions/X", () => {
    const out = toJsonSchema2020_12({
      type: "object",
      definitions: {
        Row: { $schema: DRAFT_07, type: "object", properties: { id: { type: "string" } } },
        // a definition whose NAME collides with a keyword keeps its name
        properties: { type: "string" },
      },
      properties: { row: { $ref: "#/definitions/Row" } },
    }) as Obj;

    expect(out.definitions).toBeUndefined();
    expect(Object.keys(out.$defs).sort()).toEqual(["Row", "properties"]);
    expect(out.$defs.Row).toEqual({ type: "object", properties: { id: { type: "string" } } });
    expect(out.$defs.properties).toEqual({ type: "string" });
    expect(out.properties.row).toEqual({ $ref: "#/$defs/Row" });
    expect(JSON.stringify(out)).not.toContain("draft-07");
  });

  it("passes enum, const, default and examples through VERBATIM even when they collide with keywords", () => {
    const out = toJsonSchema2020_12({
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["definitions", "$schema", "additionalItems"],
          default: { definitions: 1, $schema: "x" },
        },
        pinned: {
          const: { dependencies: { a: ["b"] }, additionalItems: false, items: [1, 2] },
        },
        sampled: {
          examples: [{ $schema: "not-a-dialect", properties: { minimum: 3 } }],
        },
      },
    }) as Obj;

    expect(out.properties.mode.enum).toEqual(["definitions", "$schema", "additionalItems"]);
    expect(out.properties.mode.default).toEqual({ definitions: 1, $schema: "x" });
    expect(out.properties.pinned.const).toEqual({
      dependencies: { a: ["b"] },
      additionalItems: false,
      items: [1, 2],
    });
    expect(out.properties.sampled.examples).toEqual([
      { $schema: "not-a-dialect", properties: { minimum: 3 } },
    ]);
    // None of the keyword rewrites leaked into the data.
    expect(out.properties.mode.default.$defs).toBeUndefined();
    expect(out.properties.pinned.const.prefixItems).toBeUndefined();
    expect(out.properties.pinned.const.dependentRequired).toBeUndefined();
  });

  it("leaves patternProperties and $defs map KEYS untouched while converting their VALUES", () => {
    const out = toJsonSchema2020_12({
      type: "object",
      patternProperties: {
        "^x-": { $schema: DRAFT_07, type: "string" },
        "^definitions$": { type: "array", items: [{ type: "string" }] },
      },
      $defs: {
        $schema: { type: "boolean" },
        definitions: { $schema: DRAFT_07, type: "number" },
      },
    }) as Obj;

    expect(Object.keys(out.patternProperties)).toEqual(["^x-", "^definitions$"]);
    expect(out.patternProperties["^x-"]).toEqual({ type: "string" });
    expect(out.patternProperties["^definitions$"]).toEqual({
      type: "array",
      prefixItems: [{ type: "string" }],
    });

    expect(Object.keys(out.$defs).sort()).toEqual(["$schema", "definitions"]);
    expect(out.$defs.$schema).toEqual({ type: "boolean" });
    expect(out.$defs.definitions).toEqual({ type: "number" });

    // Exactly one $schema *keyword* survives — the root's — even though a $defs
    // member is NAMED $schema.
    expect(out.$schema).toBe(JSON_SCHEMA_2020_12);
    expect(JSON.stringify(out)).not.toContain("draft-07");
  });

  it("round-trips an apple-notes-mcp get-checklist-state-shaped outputSchema unchanged apart from the root dialect", () => {
    // Regression guard mirroring the real tool surface: properties.items is an
    // array-typed subschema, i.e. a parameter NAMED like the "items" keyword.
    const outputSchema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              checked: { type: "boolean" },
              index: { type: "number" },
            },
            additionalProperties: true,
          },
        },
        total: { type: "number" },
        checkedCount: { type: "number" },
      },
      additionalProperties: true,
    };
    const pristine = structuredClone(outputSchema);

    const { $schema, ...rest } = toJsonSchema2020_12(outputSchema) as Obj;

    expect($schema).toBe(JSON_SCHEMA_2020_12);
    expect(rest).toEqual(pristine);
    // and the caller's object was not mutated in place
    expect(outputSchema).toEqual(pristine);
  });
});

describe("normalizeOutgoingMessage", () => {
  const toolsListResult = () => ({
    jsonrpc: "2.0" as const,
    id: 2,
    result: {
      tools: [
        {
          name: "search-messages",
          inputSchema: { $schema: DRAFT_07, type: "object", properties: {} },
          outputSchema: { $schema: DRAFT_07, type: "object", additionalProperties: true },
        },
        {
          name: "no-output-schema",
          inputSchema: { $schema: DRAFT_07, type: "object" },
        },
      ],
    },
  });

  it("rewrites inputSchema and outputSchema on every tool", () => {
    const out = normalizeOutgoingMessage(toolsListResult()) as {
      result: {
        tools: {
          name: string;
          inputSchema: { $schema: string };
          outputSchema?: { $schema: string };
        }[];
      };
    };
    expect(out.result.tools[0].inputSchema.$schema).toBe(JSON_SCHEMA_2020_12);
    expect(out.result.tools[0].outputSchema?.$schema).toBe(JSON_SCHEMA_2020_12);
    expect(out.result.tools[1].inputSchema.$schema).toBe(JSON_SCHEMA_2020_12);
    expect(JSON.stringify(out)).not.toContain("draft-07");
  });

  it("does not corrupt a tool whose PARAMETER names collide with schema keywords", () => {
    // The wire path for the position-awareness bug: this tool would previously
    // have shipped with $schema deleted and definitions renamed, while required
    // still named both — an inputSchema no call could satisfy.
    const out = normalizeOutgoingMessage({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          {
            name: "validate-doc",
            inputSchema: {
              $schema: DRAFT_07,
              type: "object",
              properties: {
                $schema: { type: "string" },
                definitions: { type: "object" },
                additionalItems: { type: "boolean" },
              },
              required: ["$schema", "definitions", "additionalItems"],
            },
          },
        ],
      },
    }) as { result: { tools: { inputSchema: Record<string, any> }[] } };

    const schema = out.result.tools[0].inputSchema;
    expect(schema.$schema).toBe(JSON_SCHEMA_2020_12);
    expect(Object.keys(schema.properties).sort()).toEqual([
      "$schema",
      "additionalItems",
      "definitions",
    ]);
    for (const name of schema.required) expect(Object.keys(schema.properties)).toContain(name);
    expect(JSON.stringify(out)).not.toContain("draft-07");
  });

  it("leaves a tool without an outputSchema without one (does not invent it)", () => {
    const out = normalizeOutgoingMessage(toolsListResult()) as {
      result: { tools: Record<string, unknown>[] };
    };
    expect(out.result.tools[1]).not.toHaveProperty("outputSchema");
    expect(out.result.tools[1].name).toBe("no-output-schema");
  });

  it("does not mutate the input message", () => {
    const message = toolsListResult();
    normalizeOutgoingMessage(message);
    expect(message.result.tools[0].inputSchema.$schema).toBe(DRAFT_07);
  });

  it("returns a tools/call result unchanged", () => {
    const message = {
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } },
    };
    expect(normalizeOutgoingMessage(message)).toBe(message);
  });

  it("returns a notification unchanged", () => {
    const message = { jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } };
    expect(normalizeOutgoingMessage(message)).toBe(message);
  });

  it("returns an error response unchanged", () => {
    const message = { jsonrpc: "2.0", id: 3, error: { code: -32601, message: "no such method" } };
    expect(normalizeOutgoingMessage(message)).toBe(message);
  });

  it("tolerates a non-object message and a malformed tools array", () => {
    expect(normalizeOutgoingMessage("junk")).toBe("junk");
    expect(normalizeOutgoingMessage(null)).toBe(null);
    const malformed = { result: { tools: ["not-a-tool", { name: "bare" }] } };
    const out = normalizeOutgoingMessage(malformed) as { result: { tools: unknown[] } };
    expect(out.result.tools[0]).toBe("not-a-tool");
    expect(out.result.tools[1]).toEqual({ name: "bare" });
  });

  it("returns a result that is not a tools/list unchanged", () => {
    const message = { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } };
    expect(normalizeOutgoingMessage(message)).toBe(message);
  });
});

describe("withJsonSchema2020_12", () => {
  function fakeTransport() {
    const sent: { message: unknown; options: unknown }[] = [];
    const transport = {
      send: vi.fn(async (message: unknown, options?: unknown) => {
        sent.push({ message, options });
      }),
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as unknown as Transport & { send: ReturnType<typeof vi.fn> };
    return { transport, sent };
  }

  it("returns the same transport instance (so it composes into server.connect)", () => {
    const { transport } = fakeTransport();
    expect(withJsonSchema2020_12(transport)).toBe(transport);
  });

  it("delegates to the original send with the NORMALIZED message and forwards options", async () => {
    const { transport } = fakeTransport();
    const original = transport.send;
    withJsonSchema2020_12(transport);

    const options = { relatedRequestId: 2 };
    await transport.send(
      {
        jsonrpc: "2.0",
        id: 2,
        result: {
          tools: [{ name: "t", outputSchema: { $schema: DRAFT_07, type: "object" } }],
        },
      } as Parameters<Transport["send"]>[0],
      options as Parameters<Transport["send"]>[1]
    );

    expect(original).toHaveBeenCalledTimes(1);
    const [message, passedOptions] = original.mock.calls[0] as [
      { result: { tools: { outputSchema: { $schema: string } }[] } },
      unknown,
    ];
    expect(message.result.tools[0].outputSchema.$schema).toBe(JSON_SCHEMA_2020_12);
    expect(passedOptions).toBe(options);
  });

  it("passes a non-tools/list message straight through to the original send", async () => {
    const { transport } = fakeTransport();
    const original = transport.send;
    withJsonSchema2020_12(transport);

    const notification = { jsonrpc: "2.0", method: "notifications/initialized" };
    await transport.send(notification as Parameters<Transport["send"]>[0]);

    expect(original.mock.calls[0][0]).toBe(notification);
  });
});
