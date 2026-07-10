import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ojCapabilitiesSchema,
  ojProblemSummarySchema,
  ojProviderHealthSchema,
  ojSearchRequestSchema,
  ojSearchResultSchema,
  type OjError
} from "@kaiserunix/oj-mcp-contracts";
import { toToolError, toToolResult } from "@kaiserunix/oj-mcp-server-common";
import { z } from "zod";
import { CodeforcesApiError } from "./client.js";
import { CodeforcesProvider } from "./provider.js";

export const CODEFORCES_MCP_TOOL_NAMES = [
  "oj_capabilities",
  "oj_health",
  "oj_search_problems",
  "codeforces_get_problem_metadata"
] as const;

export function createCodeforcesMcpServer(options: { provider?: CodeforcesProvider } = {}): McpServer {
  const provider = options.provider ?? new CodeforcesProvider();
  const server = new McpServer({ name: "codeforces-mcp-server", version: "0.1.0" });

  server.registerTool(
    "oj_capabilities",
    {
      title: "Codeforces Provider Capabilities",
      description: "Report audited Codeforces official API capabilities and unsupported operations.",
      inputSchema: {},
      outputSchema: ojCapabilitiesSchema,
      annotations: readAnnotations(false)
    },
    async () => toToolResult((await provider.getCapabilities()) as unknown as Record<string, unknown>)
  );

  server.registerTool(
    "oj_health",
    {
      title: "Codeforces Provider Health",
      description: "Return transport, schema, and Codeforces upstream health without exposing raw responses.",
      inputSchema: {},
      outputSchema: ojProviderHealthSchema,
      annotations: readAnnotations(true)
    },
    async () => toToolResult((await provider.getHealth()) as unknown as Record<string, unknown>)
  );

  server.registerTool(
    "oj_search_problems",
    {
      title: "Search Codeforces Problems",
      description: "Search official Codeforces problem metadata by id, title, or tag.",
      inputSchema: ojSearchRequestSchema,
      outputSchema: ojSearchResultSchema,
      annotations: readAnnotations(true)
    },
    async (input) => callSafely(() => provider.search(input))
  );

  server.registerTool(
    "codeforces_get_problem_metadata",
    {
      title: "Get Codeforces Problem Metadata",
      description: "Get official metadata only. This tool does not return a problem statement or submit code.",
      inputSchema: { nativeId: z.string().min(3).max(32) },
      outputSchema: ojProblemSummarySchema,
      annotations: readAnnotations(true)
    },
    async ({ nativeId }) => {
      try {
        const summary = await provider.getProblemMetadata(nativeId);
        if (!summary) {
          return toToolError(error("resource.not_found", `Codeforces problem ${nativeId} was not found.`, "never", "none"));
        }
        return toToolResult(summary as unknown as Record<string, unknown>);
      } catch (caught) {
        return mapError(caught);
      }
    }
  );

  return server;
}

async function callSafely<T extends object>(operation: () => Promise<T>): Promise<ReturnType<typeof toToolResult>> {
  try {
    return toToolResult((await operation()) as unknown as Record<string, unknown>);
  } catch (caught) {
    return mapError(caught);
  }
}

function mapError(caught: unknown) {
  if (caught instanceof CodeforcesApiError) {
    return toToolError(
      error(
        caught.code,
        caught.message,
        caught.code === "rate_limited" || caught.code === "network.timeout" ? "safe_read" : "never",
        caught.code === "rate_limited" ? "retry" : "open_logs",
        caught.retryAfterMs
      )
    );
  }
  return toToolError(error("internal", "Codeforces provider failed.", "never", "open_logs"));
}

function error(
  code: OjError["code"],
  message: string,
  retryPolicy: OjError["retryPolicy"],
  userAction: OjError["userAction"],
  retryAfterMs?: number
): OjError {
  return {
    schemaVersion: "oj.error/v1",
    code,
    layer: code.startsWith("upstream") || code === "rate_limited" ? "upstream" : "broker",
    message,
    retryPolicy,
    userAction,
    platform: "codeforces",
    providerId: "codeforces-official-api",
    retryAfterMs
  };
}

function readAnnotations(openWorldHint: boolean) {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint
  } as const;
}
