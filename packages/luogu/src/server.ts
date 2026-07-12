import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ojCapabilitiesSchema,
  ojErrorSchema,
  ojProblemDocumentSchema,
  ojProviderHealthSchema,
  ojSearchResultSchema,
  type OjError
} from "@kaiserunix/oj-mcp-contracts";
import { toToolError, toToolResult } from "@kaiserunix/oj-mcp-server-common";
import { z } from "zod";
import { LuoguAdapterError, LuoguRequestCancelledError, LuoguUpstreamAdmissionError } from "./client.js";
import { LuoguProvider, luoguFetchProblemInputSchema, luoguSearchInputSchema } from "./provider.js";

export const LUOGU_MCP_TOOL_NAMES = ["oj_capabilities", "oj_health", "oj_search_problems", "oj_fetch_problem"] as const;

const strictEmptyInputSchema = z.object({}).strict();
const INVALID_TOOL_NAME = "__invalid_luogu_tool_call__";
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
    "Luogu Provider Capabilities",
    "Report the audited anonymous Luogu read surface and operations excluded by policy.",
    strictEmptyInputSchema,
    ojCapabilitiesSchema,
    false
  ),
  tool(
    "oj_health",
    "Luogu Provider Health",
    "Report local protocol health and the most recent bounded anonymous Luogu read observation.",
    strictEmptyInputSchema,
    ojProviderHealthSchema,
    false
  ),
  tool(
    "oj_search_problems",
    "Search Luogu Problems",
    "Search anonymous public Luogu problem metadata and return shared OJ summaries with bounded cursor pagination.",
    luoguSearchInputSchema,
    ojSearchResultSchema,
    true
  ),
  tool(
    "oj_fetch_problem",
    "Fetch Luogu Problem",
    "Fetch one anonymous public Luogu statement as a bounded shared OJ problem document.",
    luoguFetchProblemInputSchema,
    ojProblemDocumentSchema,
    true
  )
];

export function createLuoguMcpServer(options: { provider?: LuoguProvider; requestSignal?: AbortSignal } = {}): McpServer {
  const provider = options.provider ?? new LuoguProvider();
  const server = new McpServer({ name: "luogu-mcp-server", version: "0.1.0" });
  server.server.registerCapabilities({ tools: { listChanged: false } });

  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.server.setRequestHandler(permissiveCallToolRequestSchema, async (request, extra) => {
    const callAbort = combineAbortSignals(options.requestSignal, extra.signal);
    const params = request.params;
    const name = readToolName(params);
    const input = readToolArguments(params);
    const requestId = requestIdFrom(input);

    try {
      return await callSafely(async () => {
        switch (name) {
          case "oj_capabilities":
            parseToolInput(strictEmptyInputSchema, input, name);
            return provider.getCapabilities();
          case "oj_health":
            parseToolInput(strictEmptyInputSchema, input, name);
            return provider.getHealth();
          case "oj_search_problems":
            return provider.search(parseToolInput(luoguSearchInputSchema, input, name), { signal: callAbort.signal });
          case "oj_fetch_problem":
            return provider.fetchProblem(parseToolInput(luoguFetchProblemInputSchema, input, name), {
              signal: callAbort.signal
            });
          default:
            throw new LuoguAdapterError("request.invalid", "tools/call must name one of the four advertised Luogu tools.");
        }
      }, requestId, callAbort.signal);
    } finally {
      callAbort.dispose();
    }
  });

  return server;
}

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): { signal: AbortSignal; dispose: () => void } {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (activeSignals.length === 1) {
    return { signal: activeSignals[0], dispose: () => undefined };
  }
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  for (const signal of activeSignals) {
    const listener = () => controller.abort(signal.reason);
    if (signal.aborted) {
      listener();
      break;
    }
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const item of listeners) item.signal.removeEventListener("abort", item.listener);
    }
  };
}

function tool(
  name: (typeof LUOGU_MCP_TOOL_NAMES)[number],
  title: string,
  description: string,
  inputSchema: z.ZodType,
  outputSchema: z.ZodType,
  openWorldHint: boolean
): Tool {
  const successOrErrorSchema = z.union([outputSchema, ojErrorSchema]);
  const declaredOutputSchema = z.toJSONSchema(successOrErrorSchema) as Tool["outputSchema"];
  return {
    name,
    title,
    description,
    inputSchema: z.toJSONSchema(inputSchema) as Tool["inputSchema"],
    outputSchema: { ...declaredOutputSchema, type: "object" },
    annotations: readAnnotations(openWorldHint)
  };
}

function readToolName(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function readToolArguments(params: unknown): unknown {
  if (!params || typeof params !== "object") return undefined;
  return (params as { arguments?: unknown }).arguments;
}

function normalizeCallParams(value: unknown): { name: string; arguments: Record<string, unknown> } {
  if (!isRecord(value)) {
    return { name: INVALID_TOOL_NAME, arguments: { __invalidCallParams: true } };
  }
  const name = typeof value.name === "string" ? value.name : INVALID_TOOL_NAME;
  const rawArguments = value.arguments;
  const args: Record<string, unknown> =
    rawArguments === undefined ? {} : isRecord(rawArguments) ? { ...rawArguments } : { __invalidArguments: true };
  const unexpectedParams = Object.keys(value).filter((key) => key !== "name" && key !== "arguments" && key !== "_meta");
  if (unexpectedParams.length > 0) {
    args.__invalidCallParams = true;
  }
  return { name, arguments: args };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolInput<T>(schema: z.ZodType<T>, input: unknown, toolName: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new LuoguAdapterError("request.invalid", `${toolName} input did not match its strict bounded schema.`, {
      cause: parsed.error
    });
  }
  return parsed.data;
}

function requestIdFrom(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const requestId = (input as { requestId?: unknown }).requestId;
  return typeof requestId === "string" && requestId.length >= 1 && requestId.length <= 128 ? requestId : undefined;
}

async function callSafely<T extends object>(operation: () => Promise<T>, requestId?: string, signal?: AbortSignal) {
  try {
    return toToolResult((await operation()) as unknown as Record<string, unknown>);
  } catch (caught) {
    if (caught instanceof LuoguRequestCancelledError) throw caught;
    if (signal?.aborted) {
      throw new LuoguRequestCancelledError("Luogu tool call was cancelled by the caller.", { cause: caught });
    }
    return mapError(caught, requestId);
  }
}

function mapError(caught: unknown, requestId?: string) {
  if (caught instanceof LuoguAdapterError) {
    return toToolError(ojErrorSchema.parse(adapterError(caught, requestId)));
  }
  return toToolError(
    ojErrorSchema.parse({
      schemaVersion: "oj.error/v1",
      code: "internal",
      layer: "broker",
      message: "Luogu provider failed without exposing upstream response data.",
      retryPolicy: "never",
      userAction: "open_logs",
      platform: "luogu",
      providerId: "luogu-lentille-page-adapter",
      requestId
    })
  );
}

function adapterError(caught: LuoguAdapterError, requestId?: string): OjError {
  const challenge = caught.code === "challenge.required";
  const retryable = caught.code === "rate_limited" || caught.code === "network.timeout" || caught.code === "upstream.unavailable";
  return {
    schemaVersion: "oj.error/v1",
    code: caught.code,
    layer:
      caught instanceof LuoguUpstreamAdmissionError
        ? "broker"
        : caught.code === "policy.blocked"
        ? "policy"
        : challenge
          ? "auth"
          : caught.code === "request.invalid"
            ? "broker"
            : "upstream",
    message: caught.message,
    retryPolicy: challenge ? "after_user_action" : retryable ? "safe_read" : "never",
    userAction: challenge ? "solve_challenge" : retryable ? "retry" : caught.code === "resource.not_found" ? "none" : "open_logs",
    platform: "luogu",
    providerId: "luogu-lentille-page-adapter",
    httpStatus: caught.httpStatus,
    requestId,
    retryAfterMs: caught.retryAfterMs
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
