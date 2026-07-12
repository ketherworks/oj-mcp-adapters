import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import {
  ojCapabilitiesSchema,
  ojProblemDocumentSchema,
  ojProviderHealthSchema,
  ojSearchResultSchema,
  type OjCapability,
  type OjError
} from "@kaiserunix/oj-mcp-contracts";
import { toOjToolOutputSchema, toToolError, toToolResult } from "@kaiserunix/oj-mcp-server-common";
import { z } from "zod";
import { AtCoderClientError } from "./client.js";
import {
  AtCoderProvider,
  atCoderFetchProblemInputSchema,
  atCoderSearchInputSchema
} from "./provider.js";

export const ATCODER_MCP_TOOL_NAMES = ["oj_capabilities", "oj_health", "oj_fetch_problem", "oj_search_problems"] as const;

const emptyInputSchema = z.object({}).strict();

export interface AtCoderMcpServerOptions {
  provider?: AtCoderProvider;
  transport: OjCapability["transport"];
}

export function createAtCoderMcpServer(options: AtCoderMcpServerOptions): Server {
  const provider = options.provider ?? new AtCoderProvider();
  const server = new Server(
    { name: "atcoder-mcp-server", version: "0.1.0" },
    { capabilities: { tools: { listChanged: false } } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions() }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const input = request.params.arguments ?? {};
    switch (request.params.name) {
      case "oj_capabilities":
        return callSafely(emptyInputSchema, input, () => provider.getCapabilities(options.transport));
      case "oj_health":
        return callSafely(emptyInputSchema, input, () => provider.getHealth());
      case "oj_fetch_problem":
        return callSafely(atCoderFetchProblemInputSchema, input, (parsed) => provider.fetchProblem(parsed, extra.signal));
      case "oj_search_problems":
        return callSafely(atCoderSearchInputSchema, input, (parsed) => provider.search(parsed, extra.signal));
      default:
        return mapError(new AtCoderClientError("request.invalid", `Unknown AtCoder tool '${request.params.name}'.`));
    }
  });

  return server;
}

function toolDefinitions(): Tool[] {
  return [
    {
      name: "oj_capabilities",
      title: "AtCoder Provider Capabilities",
      description: "Report the audited anonymous AtCoder read surface and explicitly unsupported operations.",
      inputSchema: jsonObjectSchema(emptyInputSchema),
      outputSchema: ojOutputSchema(ojCapabilitiesSchema),
      annotations: readAnnotations(false)
    },
    {
      name: "oj_health",
      title: "AtCoder Provider Health",
      description: "Report local readiness and the latest observed AtCoder page-read status without probing upstream.",
      inputSchema: jsonObjectSchema(emptyInputSchema),
      outputSchema: ojOutputSchema(ojProviderHealthSchema),
      annotations: readAnnotations(false)
    },
    {
      name: "oj_fetch_problem",
      title: "Fetch AtCoder Problem",
      description:
        "Fetch one public problem statement from an exact contest/task pair or canonical atcoder.jp task URL. Returns sanitized HTML with preserved math, samples, limits, hashes, and source provenance.",
      inputSchema: jsonObjectSchema(atCoderFetchProblemInputSchema),
      outputSchema: ojOutputSchema(ojProblemDocumentSchema),
      annotations: readAnnotations(true)
    },
    {
      name: "oj_search_problems",
      title: "Find Exact AtCoder Problem",
      description:
        "Resolve exactly one contest/task id, atcoder:contest/task id, or canonical task URL. Free-text and catalog crawling are not supported.",
      inputSchema: jsonObjectSchema(atCoderSearchInputSchema),
      outputSchema: ojOutputSchema(ojSearchResultSchema),
      annotations: readAnnotations(true)
    }
  ];
}

function jsonObjectSchema(schema: z.ZodType): Tool["inputSchema"] {
  return { type: "object", ...z.toJSONSchema(schema, { target: "draft-2020-12" }) } as Tool["inputSchema"];
}

function ojOutputSchema(schema: z.ZodType): NonNullable<Tool["outputSchema"]> {
  return toOjToolOutputSchema(schema) as NonNullable<Tool["outputSchema"]>;
}

async function callSafely<T>(
  schema: z.ZodType<T>,
  input: unknown,
  operation: (parsed: T) => Promise<object>
): Promise<CallToolResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return mapError(
      new AtCoderClientError(
        "request.invalid",
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join(" ")
      )
    );
  }
  try {
    return toToolResult((await operation(parsed.data)) as Record<string, unknown>);
  } catch (caught) {
    return mapError(caught);
  }
}

function mapError(caught: unknown): CallToolResult {
  if (caught instanceof AtCoderClientError) {
    return toToolError(
      ojError(
        caught.code,
        caught.message,
        retryPolicy(caught.code),
        userAction(caught.code),
        caught.httpStatus,
        caught.retryAfterMs
      )
    );
  }
  if (caught instanceof z.ZodError) {
    return toToolError(ojError("request.invalid", "AtCoder request failed schema validation.", "never", "none"));
  }
  return toToolError(ojError("internal", "AtCoder provider failed.", "never", "open_logs"));
}

function ojError(
  code: OjError["code"],
  message: string,
  retryPolicyValue: OjError["retryPolicy"],
  userActionValue: OjError["userAction"],
  httpStatus?: number,
  retryAfterMs?: number
): OjError {
  return {
    schemaVersion: "oj.error/v1",
    code,
    layer: errorLayer(code),
    message,
    retryPolicy: retryPolicyValue,
    userAction: userActionValue,
    platform: "atcoder",
    providerId: "atcoder-page-adapter",
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
  };
}

function errorLayer(code: OjError["code"]): OjError["layer"] {
  if (code === "policy.blocked") return "policy";
  if (code === "network.timeout") return "transport";
  if (code === "request.invalid") return "protocol";
  if (code === "challenge.required") return "auth";
  if (code === "resource.not_found" || code === "rate_limited" || code.startsWith("upstream.")) return "upstream";
  return "broker";
}

function retryPolicy(code: OjError["code"]): OjError["retryPolicy"] {
  return code === "rate_limited" || code === "network.timeout" || code === "upstream.unavailable" || code === "challenge.required"
    ? "safe_read"
    : "never";
}

function userAction(code: OjError["code"]): OjError["userAction"] {
  if (code === "rate_limited" || code === "network.timeout" || code === "upstream.unavailable" || code === "challenge.required") {
    return "retry";
  }
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
