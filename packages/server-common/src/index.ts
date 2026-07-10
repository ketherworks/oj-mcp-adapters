import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OjError } from "@kaiserunix/oj-mcp-contracts";

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
