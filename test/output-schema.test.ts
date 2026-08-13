/**
 * outputSchema contract — belt-and-suspenders for the registerTool/outputSchema
 * migration. Boots the REAL built server over stdio and verifies the MCP
 * output-schema guarantees end-to-end through the SDK:
 *
 *   1. every tool advertises an outputSchema (none slipped back to plain server.tool)
 *   2. every outputSchema is permissive — no required fields — so the SDK's
 *      structuredContent validation can never reject a valid success result for a
 *      conditionally-absent field
 *   3. every advertised schema declares the JSON Schema 2020-12 dialect and
 *      carries no draft-07-only construct — the SDK emits draft-07 and current
 *      clients refuse every such tool outright (#147)
 *   4. every advertised schema actually COMPILES under a real 2020-12 validator
 *      (ajv's Ajv2020 — the same library the MCP SDK validates with), because a
 *      schema can declare the right dialect and still be structurally invalid
 *      under it. Asserting the "$schema" string is a claim; compiling is proof.
 *   5. the diagnostic tools round-trip without a validation rejection. The SDK's
 *      validateToolOutput (server mcp.js) THROWS McpError when a success result's
 *      structuredContent is missing or fails the schema, which rejects callTool —
 *      so a resolving call proves a real payload validates against its schema.
 *      (Environment failures return isError results, which the SDK exempts.)
 *
 * Needs no configured Mail account, so it always runs (including CI). Requires
 * build/ — `npm ci` runs prepare→build and the CI step builds before this.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// ajv's 2020-12 entrypoint is CommonJS with `module.exports = Ajv2020` AND an
// `exports.default` alias, so the ESM default import lands on the namespace-ish
// object under some loaders and on the class under others — unwrap `.default`
// when it is there. ajv is a DIRECT devDependency on purpose: it reaches the
// tree transitively via @modelcontextprotocol/sdk, but pnpm's strict
// node_modules layout makes a transitive package unimportable.
import Ajv2020Entry from "ajv/dist/2020.js";

const Ajv2020 = ((Ajv2020Entry as unknown as { default?: unknown }).default ??
  Ajv2020Entry) as typeof Ajv2020Entry;

const SERVER = resolve(__dirname, "../build/index.js");

// Walk schema POSITIONS, not every key. The keys of a `properties` map are
// caller-chosen TOOL PARAMETER NAMES, not keywords, so a tool with a parameter
// named `definitions` or `$schema` is perfectly legal and must not be reported;
// and enum/const/default hold instance DATA, whose keys mean nothing here.
// (Same distinction the normalizer itself makes — see src/utils/jsonSchemaDialect.ts.)
const SCHEMA_MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "dependentSchemas"];
const DATA_KEYWORDS = ["enum", "const", "default", "examples", "required", "dependentRequired"];

/** Re-enter only the subschema positions of `obj`, reporting each via `visit`. */
function walkSubschemas(
  obj: Record<string, unknown>,
  path: string,
  visit: (node: unknown, path: string) => void
): void {
  for (const [key, value] of Object.entries(obj)) {
    if (DATA_KEYWORDS.includes(key)) continue;
    if (SCHEMA_MAP_KEYWORDS.includes(key)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
          visit(sub, `${path}.${key}.${name}`);
        }
      }
      continue;
    }
    visit(value, `${path}.${key}`);
  }
}

describe("outputSchema contract (real server over stdio)", () => {
  let client: Client;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env } as Record<string, string>,
    });
    client = new Client({ name: "outputschema-contract-test", version: "0.0.0" });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it("registers tools, and every tool advertises an outputSchema", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    const missing = tools.filter((t) => !t.outputSchema).map((t) => t.name);
    expect(missing, `tools missing an outputSchema: ${missing.join(", ")}`).toEqual([]);
  });

  it("every outputSchema is permissive — no required fields", async () => {
    const { tools } = await client.listTools();
    const offenders = tools
      .filter((t) => {
        const req = (t.outputSchema as { required?: unknown } | undefined)?.required;
        return Array.isArray(req) && req.length > 0;
      })
      .map(
        (t) =>
          `${t.name}: requires [${(t.outputSchema as { required: string[] }).required.join(", ")}]`
      );
    expect(
      offenders,
      `outputSchemas must not require fields (a missing field would reject a valid result): ${offenders.join("; ")}`
    ).toEqual([]);
  });

  it("every outputSchema tolerates undeclared keys (additionalProperties !== false)", async () => {
    // The CLIENT validates structuredContent against the ADVERTISED JSON Schema
    // (client/index.js → "Structured content does not match the tool's output
    // schema"), so `additionalProperties: false` makes any field the schema
    // didn't enumerate a hard -32602 that discards an otherwise-correct result.
    // The server never notices, because zod's own parse strips unknown keys
    // instead of failing — so nothing but this assertion catches it, and it went
    // unnoticed until #135 (get-mail-stats' IMAP branch emits `perMailbox`).
    // A bare zod raw shape renders as additionalProperties:false; registerTool()
    // in src/index.ts wraps every shape in .passthrough() to prevent that.
    const { tools } = await client.listTools();
    const offenders = tools
      .filter(
        (t) =>
          (t.outputSchema as { additionalProperties?: unknown } | undefined)
            ?.additionalProperties === false
      )
      .map((t) => t.name);
    expect(
      offenders,
      `outputSchemas must tolerate undeclared keys — these advertise ` +
        `additionalProperties:false, so any field they don't enumerate is rejected ` +
        `client-side and the whole result is lost: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  it("every advertised schema declares JSON Schema 2020-12 (never draft-07)", async () => {
    // #147: the SDK converts our zod schemas with a draft-07 target and stamps
    // "$schema": "http://json-schema.org/draft-07/schema#" on every emitted
    // input/outputSchema. Clients standardized on 2020-12 now reject the tool
    // outright ("The default validator supports JSON Schema 2020-12 only"), so
    // EVERY tool disappears. src/utils/jsonSchemaDialect.ts normalizes the
    // outgoing tools/list payload; this asserts what the wire actually carries.
    const { tools } = await client.listTools();
    const offenders: string[] = [];
    for (const tool of tools) {
      for (const [kind, schema] of [
        ["inputSchema", tool.inputSchema],
        ["outputSchema", tool.outputSchema],
      ] as const) {
        if (!schema) continue;
        const declared = (schema as { $schema?: unknown }).$schema;
        if (declared !== "https://json-schema.org/draft/2020-12/schema") {
          offenders.push(`${tool.name}.${kind} declares ${JSON.stringify(declared)}`);
        }
        if (JSON.stringify(schema).includes("draft-07")) {
          offenders.push(`${tool.name}.${kind} mentions draft-07`);
        }
      }
    }
    expect(
      offenders,
      `every advertised schema must declare the 2020-12 dialect: ${offenders.join("; ")}`
    ).toEqual([]);
  });

  it("no advertised schema uses a draft-07-only construct", async () => {
    // The dialect declaration is only honest if the BODY is 2020-12 too:
    // tuple-form `items`, `additionalItems`, `definitions`, `#/definitions/`
    // refs, `dependencies`, and boolean `exclusiveMinimum/Maximum` all changed.
    const { tools } = await client.listTools();
    const offenders: string[] = [];

    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, `${path}[${i}]`));
        return;
      }
      if (typeof node !== "object" || node === null) return;
      const obj = node as Record<string, unknown>;
      if (Array.isArray(obj.items)) offenders.push(`${path}: tuple-form "items"`);
      if ("additionalItems" in obj) offenders.push(`${path}: "additionalItems"`);
      if ("definitions" in obj) offenders.push(`${path}: "definitions"`);
      if ("dependencies" in obj) offenders.push(`${path}: "dependencies"`);
      if (typeof obj.exclusiveMinimum === "boolean")
        offenders.push(`${path}: boolean "exclusiveMinimum"`);
      if (typeof obj.exclusiveMaximum === "boolean")
        offenders.push(`${path}: boolean "exclusiveMaximum"`);
      if (typeof obj.$ref === "string" && obj.$ref.startsWith("#/definitions/"))
        offenders.push(`${path}: "#/definitions/" $ref`);
      walkSubschemas(obj, path, walk);
    };

    for (const tool of tools) {
      if (tool.inputSchema) walk(tool.inputSchema, `${tool.name}.inputSchema`);
      if (tool.outputSchema) walk(tool.outputSchema, `${tool.name}.outputSchema`);
    }
    expect(offenders, `draft-07-only constructs on the wire: ${offenders.join("; ")}`).toEqual([]);
  });

  it("only the schema ROOT declares a dialect — no nested $schema", async () => {
    // A subschema carrying its own "$schema" is not portable and is exactly what
    // the normalizer strips; assert it never reappears.
    const { tools } = await client.listTools();
    const offenders: string[] = [];
    const walkNested = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((child, i) => walkNested(child, `${path}[${i}]`));
        return;
      }
      if (typeof node !== "object" || node === null) return;
      const obj = node as Record<string, unknown>;
      if ("$schema" in obj) offenders.push(`${path}: nested "$schema"`);
      walkSubschemas(obj, path, walkNested);
    };
    for (const tool of tools) {
      for (const [kind, schema] of [
        ["inputSchema", tool.inputSchema],
        ["outputSchema", tool.outputSchema],
      ] as const) {
        if (!schema) continue;
        // Start below the root, whose own $schema is the legitimate declaration.
        walkSubschemas(schema as Record<string, unknown>, `${tool.name}.${kind}`, walkNested);
      }
    }
    expect(offenders, `nested dialect declarations: ${offenders.join("; ")}`).toEqual([]);
  });

  it("every advertised schema compiles under a REAL 2020-12 validator (ajv)", async () => {
    // The dialect assertions above check what we CLAIM; this checks whether the
    // claim holds. A schema can carry `"$schema": ".../2020-12/schema"` and
    // still be structurally invalid under it (bad `type`, malformed `$ref`,
    // non-schema in a `properties` slot, a keyword whose value has the wrong
    // shape) — every one of those is a tool a strict client drops on the floor.
    //
    // ajv IS the validator the MCP SDK itself uses, and Ajv2020 will refuse a
    // schema whose declared meta-schema it doesn't know — so this also
    // independently re-catches the #147 draft-07 regression from the other end,
    // via a library rather than a string comparison.
    //
    // strict:false on purpose: ajv's strict mode rejects unknown keywords and
    // benign annotations (title/examples/x-*), which is a style opinion, not a
    // portability fact. What we need to know is whether the schema is
    // STRUCTURALLY VALID under 2020-12.
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const tool of tools) {
      for (const [kind, schema] of [
        ["inputSchema", tool.inputSchema],
        ["outputSchema", tool.outputSchema],
      ] as const) {
        if (!schema) continue;
        // A fresh instance per schema: ajv caches by $id/serialized schema, and
        // one poisoned instance must not mask or manufacture later failures.
        const ajv = new Ajv2020({ strict: false });
        try {
          ajv.compile(schema as object);
        } catch (err) {
          failures.push(`${tool.name}.${kind}: ${(err as Error).message}`);
        }
      }
    }
    expect(
      failures,
      `every advertised schema must compile under JSON Schema 2020-12 — ` +
        `a client that validates schemas will refuse these tools outright: ${failures.join("; ")}`
    ).toEqual([]);
  });

  it("diagnostic tools' real output validates against their outputSchema (when reachable)", async () => {
    // The SDK throws an "Output validation error" McpError when a success
    // result's structuredContent is missing or fails its schema — the only
    // failure we treat as a bug. A slow or unavailable backend (e.g. AppleScript
    // timing out on a headless CI runner) is tolerated, not failed.
    for (const name of ["health-check", "doctor"]) {
      const call = client.callTool({ name, arguments: {} });
      try {
        await Promise.race([
          call,
          new Promise((resolve) => setTimeout(() => resolve(undefined), 8000)),
        ]);
      } catch (err) {
        const msg = String((err as { message?: string })?.message ?? err);
        if (/output validation error|invalid structured content/i.test(msg)) throw err;
        // otherwise: environment/transport error — the tool couldn't run here
      }
      // Swallow any late rejection (e.g. when the client closes mid-call).
      void Promise.resolve(call).catch(() => {});
    }
  }, 30_000);
});
