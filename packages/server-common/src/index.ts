import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ojErrorSchema, type OjError } from "@kaiserunix/oj-mcp-contracts";
import { z } from "zod";

export function toToolResult(result: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result
  };
}

export function toToolError(error: OjError): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: error.message }],
    structuredContent: error as unknown as Record<string, unknown>
  };
}

export function toOjToolOutputSchema(successSchema: z.ZodType): Record<string, unknown> {
  return {
    type: "object",
    anyOf: [withoutDialect(z.toJSONSchema(successSchema)), withoutDialect(z.toJSONSchema(ojErrorSchema))]
  };
}

function withoutDialect(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _dialect, ...jsonSchema } = schema;
  return jsonSchema;
}
