import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ojCapabilitiesSchema,
  ojErrorSchema,
  ojProblemSummarySchema,
  ojProviderHealthSchema,
  ojSearchResultSchema,
  type OjCapability,
  type OjError
} from "@kaiserunix/oj-mcp-contracts";
import { toOjToolOutputSchema, toToolError, toToolResult } from "@kaiserunix/oj-mcp-server-common";
import { z } from "zod";
import { CodeforcesApiError, CodeforcesRequestCancelledError } from "./client.js";
import { CodeforcesProvider, codeforcesSearchInputSchema } from "./provider.js";

export const CODEFORCES_MCP_TOOL_NAMES = [
  "oj_capabilities",
  "oj_health",
  "oj_search_problems",
  "codeforces_get_problem_metadata"
] as const;

const strictEmptyInputSchema = z.object({}).strict();
const metadataInputSchema = z.object({ nativeId: z.string().trim().min(3).max(64) }).strict();
const INVALID_TOOL_NAME = "__invalid_codeforces_tool_call__";
const permissiveCallToolRequestSchema = z
  .object({
    method: z.literal("tools/call"),
    params: z
      .unknown()
      .transform(normalizeCallParams)
      .optional()
      .default({ name: INVALID_TOOL_NAME, arguments: { __invalidCallParams: true } })
  })
  .passthrough();

const tools: Tool[] = [
  tool(
    "oj_capabilities",
    "Codeforces Provider Capabilities",
    "Report audited Codeforces official API capabilities and unsupported operations.",
    strictEmptyInputSchema,
    ojCapabilitiesSchema,
    false
  ),
  tool(
    "oj_health",
    "Codeforces Provider Health",
    "Return passive transport, schema, and persisted Codeforces upstream health.",
    strictEmptyInputSchema,
    ojProviderHealthSchema,
    true
  ),
  tool(
    "oj_search_problems",
    "Search Codeforces Problems",
    "Search official Codeforces problem metadata by id, title, or tag.",
    codeforcesSearchInputSchema,
    ojSearchResultSchema,
    true
  ),
  tool(
    "codeforces_get_problem_metadata",
    "Get Codeforces Problem Metadata",
    "Get official metadata only. This tool does not return a problem statement or submit code.",
    metadataInputSchema,
    ojProblemSummarySchema,
    true
  )
];

export interface CodeforcesMcpServerOptions {
  provider?: CodeforcesProvider;
  transport: OjCapability["transport"];
}

export function createCodeforcesMcpServer(options: CodeforcesMcpServerOptions): McpServer {
  const provider = options.provider ?? new CodeforcesProvider();
  const server = new McpServer({ name: "codeforces-mcp-server", version: "0.1.0" });
  server.server.registerCapabilities({ tools: { listChanged: false } });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.server.setRequestHandler(permissiveCallToolRequestSchema, async (request, extra) => {
    const params = request.params;
    const name = readToolName(params);
    const input = readToolArguments(params);
    const requestId = requestIdFrom(input);
    return callSafely(async () => {
      switch (name) {
        case "oj_capabilities":
          parseToolInput(strictEmptyInputSchema, input, name);
          return provider.getCapabilities(options.transport);
        case "oj_health":
          parseToolInput(strictEmptyInputSchema, input, name);
          return provider.getHealth({ signal: extra.signal });
        case "oj_search_problems":
          return provider.search(parseToolInput(codeforcesSearchInputSchema, input, name), { signal: extra.signal });
        case "codeforces_get_problem_metadata": {
          const { nativeId } = parseToolInput(metadataInputSchema, input, name);
          const summary = await provider.getProblemMetadata(nativeId, { signal: extra.signal });
          if (!summary) throw new CodeforcesApiError("resource.not_found", `Codeforces problem ${nativeId} was not found.`);
          return summary;
        }
        default:
          throw new CodeforcesApiError("request.invalid", "tools/call must name one of the four advertised Codeforces tools.");
      }
    }, requestId, extra.signal);
  });
  return server;
}

function tool(
  name: (typeof CODEFORCES_MCP_TOOL_NAMES)[number],
  title: string,
  description: string,
  inputSchema: z.ZodType,
  successSchema: z.ZodType,
  openWorldHint: boolean
): Tool {
  return {
    name,
    title,
    description,
    inputSchema: z.toJSONSchema(inputSchema) as Tool["inputSchema"],
    outputSchema: toOjToolOutputSchema(successSchema) as Tool["outputSchema"],
    annotations: readAnnotations(openWorldHint)
  };
}

function readToolName(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  return typeof params.name === "string" ? params.name : undefined;
}

function readToolArguments(params: unknown): unknown {
  return isRecord(params) ? params.arguments : undefined;
}

function normalizeCallParams(value: unknown): { name: string; arguments: Record<string, unknown> } {
  if (!isRecord(value)) return { name: INVALID_TOOL_NAME, arguments: { __invalidCallParams: true } };
  const name = typeof value.name === "string" ? value.name : INVALID_TOOL_NAME;
  const rawArguments = value.arguments;
  const args: Record<string, unknown> =
    rawArguments === undefined ? {} : isRecord(rawArguments) ? { ...rawArguments } : { __invalidArguments: true };
  const unexpected = Object.keys(value).filter((key) => key !== "name" && key !== "arguments" && key !== "_meta");
  if (unexpected.length > 0) args.__invalidCallParams = true;
  return { name, arguments: args };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolInput<T>(schema: z.ZodType<T>, input: unknown, toolName: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new CodeforcesApiError("request.invalid", `${toolName} input did not match its strict bounded schema.`);
  }
  return parsed.data;
}

function requestIdFrom(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  return typeof input.requestId === "string" && input.requestId.length >= 1 && input.requestId.length <= 128
    ? input.requestId
    : undefined;
}

async function callSafely<T extends object>(operation: () => Promise<T>, requestId?: string, signal?: AbortSignal) {
  try {
    return toToolResult((await operation()) as unknown as Record<string, unknown>);
  } catch (caught) {
    if (caught instanceof CodeforcesRequestCancelledError) throw caught;
    if (signal?.aborted) {
      throw new CodeforcesRequestCancelledError("Codeforces tool call was cancelled by the caller.", { cause: caught });
    }
    return mapError(caught, requestId);
  }
}

function mapError(caught: unknown, requestId?: string) {
  if (caught instanceof CodeforcesApiError) {
    return toToolError(ojErrorSchema.parse(error(caught.code, caught.message, requestId, caught.retryAfterMs)));
  }
  return toToolError(ojErrorSchema.parse(error("internal", "Codeforces provider failed.", requestId)));
}

function error(code: OjError["code"], message: string, requestId?: string, retryAfterMs?: number): OjError {
  return {
    schemaVersion: "oj.error/v1",
    code,
    layer: errorLayer(code),
    message,
    retryPolicy: retryPolicy(code),
    userAction: userAction(code),
    platform: "codeforces",
    providerId: "codeforces-official-api",
    requestId,
    retryAfterMs
  };
}

function errorLayer(code: OjError["code"]): OjError["layer"] {
  if (code === "network.timeout") return "transport";
  if (code === "rate_limited" || code === "resource.not_found" || code.startsWith("upstream.")) return "upstream";
  return "broker";
}

function retryPolicy(code: OjError["code"]): OjError["retryPolicy"] {
  return code === "rate_limited" || code === "network.timeout" || code === "upstream.unavailable" ? "safe_read" : "never";
}

function userAction(code: OjError["code"]): OjError["userAction"] {
  if (code === "rate_limited" || code === "network.timeout" || code === "upstream.unavailable") return "retry";
  if (code === "upstream.schema_changed" || code === "internal") return "open_logs";
  return "none";
}

function readAnnotations(openWorldHint: boolean) {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint
  } as const;
}
