import {
  McpServer,
  type RegisteredTool,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Zod 3 advertises strip objects as closed although parsing strips extra keys.
// Preserve that advertisement through Zod 4's supported JSON Schema metadata,
// without changing parsing, catchall validation, refinements or handlers.
export function preserveObjectSchemaContracts(schema: unknown): void {
  const seen = new Set<object>();
  function visit(value: unknown): void {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (value instanceof z.ZodType) {
      if (value instanceof z.ZodObject) {
        const catchall = value.def.catchall;
        if (!catchall || catchall instanceof z.ZodNever) {
          z.globalRegistry.add(value, { ...value.meta(), additionalProperties: false });
        } else if (catchall instanceof z.ZodUnknown || catchall instanceof z.ZodAny) {
          z.globalRegistry.add(value, { ...value.meta(), additionalProperties: true });
        }
      }
      visit(value.def);
    } else {
      for (const child of Object.values(value)) visit(child);
    }
  }
  visit(schema);
}

/**
 * Register a tool, advertising its `outputSchema` as PERMISSIVE.
 *
 * The MCP **client** validates a result's `structuredContent` against the JSON
 * Schema the server advertised — not against the server's own zod object. A
 * bare zod raw shape renders as `additionalProperties: false`, so a payload
 * carrying any field the schema didn't enumerate is rejected client-side with
 * `-32602 … data must NOT have additional properties`, discarding a result the
 * handler produced correctly (#135: `get-mail-stats`'s IMAP branch emits
 * `perMailbox`). The server never sees it, because zod's own parse silently
 * *strips* unknown keys rather than failing — which is why the v2.3.0 migration
 * believed "all fields optional, no `.strict()`" already meant permissive. It
 * covered optionality; it did not cover undeclared keys.
 *
 * `.passthrough()` advertises `additionalProperties: true`, which is the
 * contract that migration intended: a declared field documents the shape,
 * an undeclared one is carried through instead of nuking the whole result.
 * Enforced for every tool by `test/output-schema.test.ts`.
 */
export function registerToolWithContracts<
  OutputArgs extends z.ZodRawShape,
  InputArgs extends undefined | z.ZodRawShape = undefined,
>(
  server: McpServer,
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: InputArgs;
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations;
  },
  cb: ToolCallback<InputArgs>
): RegisteredTool {
  const { outputSchema, ...rest } = config;
  const tool = server.registerTool(
    name,
    outputSchema ? { ...rest, outputSchema: z.object(outputSchema).passthrough() } : rest,
    cb
  );
  // The SDK retains raw input shapes and wraps them only when listing tools.
  // Store an object now so the root advertisement receives the same metadata.
  if (config.inputSchema && Object.keys(config.inputSchema).length > 0) {
    tool.inputSchema = z.object(config.inputSchema);
  }
  preserveObjectSchemaContracts(tool.inputSchema);
  preserveObjectSchemaContracts(tool.outputSchema);
  return tool;
}

/** Keep the full integer domain accepted before Zod 4's safe-integer restriction. */
export function integerNumber() {
  return z
    .number()
    .refine(Number.isInteger, { message: "Expected integer" })
    .meta({ type: "integer" });
}
