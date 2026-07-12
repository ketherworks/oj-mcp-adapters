import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ojCapabilitiesSchema,
  ojErrorSchema,
  ojProblemDocumentSchema,
  ojProviderHealthSchema,
  type OjError,
  type OjErrorCode
} from "@kaiserunix/oj-mcp-contracts";
import { toOjToolOutputSchema, toToolError, toToolResult } from "@kaiserunix/oj-mcp-server-common";
import { z } from "zod";
import { NowCoderAdapterError } from "./errors.js";
import { NowCoderProvider } from "./provider.js";
import type { NowCoderProblemLocator } from "./url.js";

export const NOWCODER_MCP_TOOL_NAMES = ["oj_capabilities", "oj_health", "oj_fetch_problem"] as const;

const fetchProblemInputSchema = z.object({
  url: z.string().url().max(2_048).describe(
    "Official public URL shaped as https://ac.nowcoder.com/acm/problem/<id> or https://ac.nowcoder.com/acm/contest/<contest>/<index>."
  ).optional(),
  nativeId: z.string().min(3).max(29).describe(
    "Canonical NowCoder native ID: NC<positive-id> or <positive-contest-id>/<uppercase-or-numeric-index>."
  ).optional()
}).strict().refine((value) => (value.url === undefined) !== (value.nativeId === undefined), {
  message: "Provide exactly one URL or nativeId."
});
const emptyInputSchema = z.object({}).strict();

const tools: Tool[] = [
  tool(
    "oj_capabilities",
    "NowCoder Provider Capabilities",
    "Report the audited anonymous NowCoder page-adapter capability and explicitly unsupported operations.",
    emptyInputSchema,
    ojCapabilitiesSchema,
    false
  ),
  tool(
    "oj_health",
    "NowCoder Provider Health",
    "Report passive adapter health from the last fetch; this tool does not probe NowCoder.",
    emptyInputSchema,
    ojProviderHealthSchema,
    false
  ),
  tool(
    "oj_fetch_problem",
    "Fetch NowCoder Problem",
    "Fetch and normalize one anonymous official public NowCoder ACM problem page. This is not an official API and never uses cookies, a browser, execution, or submission.",
    fetchProblemInputSchema,
    ojProblemDocumentSchema,
    true
  )
];

export function createNowCoderMcpServer(options: { provider?: NowCoderProvider } = {}): McpServer {
  const provider = options.provider ?? new NowCoderProvider();
  const server = new McpServer({ name: "nowcoder-mcp-server", version: "0.1.0" });
  server.server.registerCapabilities({ tools: { listChanged: false } });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const input = request.params.arguments ?? {};
    return callSafely(async () => {
      switch (request.params.name) {
        case "oj_capabilities":
          parseInput(emptyInputSchema, input, request.params.name);
          return provider.getCapabilities();
        case "oj_health":
          parseInput(emptyInputSchema, input, request.params.name);
          return provider.getHealth();
        case "oj_fetch_problem":
          return provider.fetchProblem(parseInput(fetchProblemInputSchema, input, request.params.name) as NowCoderProblemLocator, {
            signal: extra.signal
          });
        default:
          throw new NowCoderAdapterError("request.invalid", "Unknown NowCoder tool name.");
      }
    }, extra.signal);
  });

  return server;
}

function tool(
  name: (typeof NOWCODER_MCP_TOOL_NAMES)[number],
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

function parseInput<T>(schema: z.ZodType<T>, input: unknown, toolName: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new NowCoderAdapterError("request.invalid", `${toolName} input did not match its strict bounded schema.`);
  }
  return parsed.data;
}

async function callSafely(operation: () => Promise<object>, signal?: AbortSignal): Promise<CallToolResult> {
  try {
    return toToolResult((await operation()) as Record<string, unknown>);
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("NowCoder tool call was cancelled.", "AbortError");
    }
    return mapError(error);
  }
}

function mapError(error: unknown): CallToolResult {
  if (error instanceof NowCoderAdapterError) {
    return toToolError(toOjError(error));
  }
  return toToolError(toOjError(new NowCoderAdapterError("internal", "NowCoder provider failed.")));
}

function toOjError(error: NowCoderAdapterError): OjError {
  try {
    const retryable = error.code === "rate_limited" || error.code === "network.timeout" || error.code === "upstream.unavailable";
    const parsed = ojErrorSchema.safeParse({
      schemaVersion: "oj.error/v1",
      code: error.code,
      layer: errorLayer(error.code),
      message: error.message,
      retryPolicy: error.code === "challenge.required" ? "after_user_action" : retryable ? "safe_read" : "never",
      userAction: error.code === "challenge.required" ? "solve_challenge" : retryable ? "retry" : error.code === "upstream.schema_changed" || error.code === "internal" ? "open_logs" : "none",
      platform: "nowcoder",
      providerId: "nowcoder-public-page",
      httpStatus: error.options.httpStatus,
      retryAfterMs: error.options.retryAfterMs
    });
    if (parsed.success) return parsed.data;
  } catch {
    // Runtime-corrupted error objects must not escape the MCP error boundary.
  }
  return {
    schemaVersion: "oj.error/v1",
    code: "internal",
    layer: "broker",
    message: "NowCoder provider failed to produce a valid error response.",
    retryPolicy: "never",
    userAction: "open_logs",
    platform: "nowcoder",
    providerId: "nowcoder-public-page"
  };
}

function errorLayer(code: OjErrorCode): OjError["layer"] {
  if (code === "request.invalid" || code === "internal") return "broker";
  if (code === "policy.blocked") return "policy";
  if (code.startsWith("auth.") || code === "challenge.required") return "auth";
  if (code === "network.timeout") return "transport";
  return "upstream";
}

function readAnnotations(openWorldHint: boolean) {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint
  } as const;
}
