import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ojCapabilitiesSchema,
  ojErrorSchema,
  ojImportPreviewSchema,
  ojImportWindowRequestSchema,
  ojImportWindowSchema,
  ojPrepareSubmissionRequestSchema,
  ojProblemDocumentSchema,
  ojProviderHealthSchema,
  ojRunRequestSchema,
  ojRunResultSchema,
  ojSearchResultSchema,
  ojSubmitCommitRequestSchema,
  ojSubmitPreviewSchema,
  ojSubmitResultSchema,
  type OjSubmitPreview,
  type OjRunRequest,
  type OjError,
  type OjErrorCode
} from "@kaiserunix/oj-mcp-contracts";
import { toOjToolOutputSchema, toToolError, toToolResult } from "@kaiserunix/oj-mcp-server-common";
import { z } from "zod";
import { nowCoderAuthStatusSchema } from "./auth.js";
import { NowCoderAdapterError } from "./errors.js";
import { nowCoderProfileSchema } from "./profile.js";
import { NowCoderProvider, nowCoderProfileInputSchema, nowCoderSearchInputSchema, nowCoderSubmissionsInputSchema } from "./provider.js";
import { nowCoderSubmissionListSchema } from "./submissions.js";
import type { NowCoderProblemLocator } from "./url.js";

export const NOWCODER_MCP_TOOL_NAMES = [
  "oj_capabilities",
  "oj_health",
  "oj_fetch_problem",
  "oj_search_problems",
  "oj_open_import_window",
  "oj_complete_import",
  "oj_fetch_profile",
  "oj_list_submissions",
  "oj_prepare_submission",
  "oj_commit_submission",
  "oj_poll_submission",
  "oj_platform_run",
  "nowcoder_auth_status"
] as const;

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
const completeImportInputSchema = z.object({
  windowId: z.string().min(1).max(100)
}).strict();
const commitSubmissionInputSchema = ojSubmitCommitRequestSchema.omit({ confirmationProof: true }).strict();
const pollSubmissionInputSchema = z.object({
  requestId: z.string().min(1).max(200),
  submissionOperationId: z.string().min(1).max(200)
}).strict();

const tools: Tool[] = [
  tool(
    "oj_capabilities",
    "NowCoder Provider Capabilities",
    "Report the active NowCoder tools, authentication mode, operation risk, and judge language IDs.",
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
    "oj_platform_run",
    "Run on NowCoder",
    "Show an MCP-native confirmation prompt, upload the immutable code artifact for one NowCoder sample, and return the platform result.",
    ojRunRequestSchema,
    ojRunResultSchema,
    true,
    "localAction"
  ),
  tool(
    "oj_prepare_submission",
    "Prepare NowCoder Submission",
    "Validate the account, problem, language, and immutable code artifact, then return a two-minute submission preview without submitting.",
    ojPrepareSubmissionRequestSchema,
    ojSubmitPreviewSchema,
    true,
    "localAction"
  ),
  tool(
    "oj_commit_submission",
    "Submit to NowCoder",
    "Show an MCP-native confirmation prompt and submit the exact prepared code to NowCoder once after the user accepts.",
    commitSubmissionInputSchema,
    ojSubmitResultSchema,
    true,
    "realSubmit"
  ),
  tool(
    "oj_poll_submission",
    "Poll NowCoder Submission",
    "Poll a submission operation created by this local process without resubmitting code.",
    pollSubmissionInputSchema,
    ojSubmitResultSchema,
    true
  ),
  tool(
    "oj_list_submissions",
    "List NowCoder Submissions",
    "List compact server-rendered submission metadata for a public or signed-in NowCoder competition profile.",
    nowCoderSubmissionsInputSchema,
    nowCoderSubmissionListSchema,
    true
  ),
  tool(
    "oj_fetch_profile",
    "Fetch NowCoder Profile",
    "Return a compact NowCoder competition profile by account ID, or resolve the signed-in account from the local session.",
    nowCoderProfileInputSchema,
    nowCoderProfileSchema,
    true
  ),
  tool(
    "oj_open_import_window",
    "Open Browser Import Window",
    "Open a short-lived loopback receiver for one NowCoder problem sent by Competitive Companion.",
    ojImportWindowRequestSchema,
    ojImportWindowSchema,
    false,
    "localAction"
  ),
  tool(
    "oj_complete_import",
    "Complete Browser Import",
    "Wait for the selected Competitive Companion window and return its typed NowCoder problem preview.",
    completeImportInputSchema,
    ojImportPreviewSchema,
    false,
    "localAction"
  ),
  tool(
    "oj_search_problems",
    "Search NowCoder Problems",
    "Search the official NowCoder ACM problem catalog by keyword with bounded cursor pagination.",
    nowCoderSearchInputSchema,
    ojSearchResultSchema,
    true
  ),
  tool(
    "oj_fetch_problem",
    "Fetch NowCoder Problem",
    "Fetch and normalize one official NowCoder ACM problem page with statement, limits, samples, tags, provenance, and hashes.",
    fetchProblemInputSchema,
    ojProblemDocumentSchema,
    true
  ),
  tool(
    "nowcoder_auth_status",
    "NowCoder Login Status",
    "Validate the configured local session without returning account identity or cookie data.",
    emptyInputSchema,
    nowCoderAuthStatusSchema,
    true
  )
];

export function createNowCoderMcpServer(options: { provider?: NowCoderProvider } = {}): McpServer {
  const provider = options.provider ?? new NowCoderProvider();
  const server = new McpServer({ name: "nowcoder-mcp-server", version: "0.2.0" });
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
        case "nowcoder_auth_status":
          parseInput(emptyInputSchema, input, request.params.name);
          return provider.getAuthStatus({ signal: extra.signal });
        case "oj_fetch_problem":
          return provider.fetchProblem(parseInput(fetchProblemInputSchema, input, request.params.name) as NowCoderProblemLocator, {
            signal: extra.signal
          });
        case "oj_search_problems":
          return provider.search(parseInput(nowCoderSearchInputSchema, input, request.params.name), {
            signal: extra.signal
          });
        case "oj_open_import_window":
          return provider.openImportWindow(parseInput(ojImportWindowRequestSchema, input, request.params.name));
        case "oj_complete_import":
          return provider.completeImport(parseInput(completeImportInputSchema, input, request.params.name).windowId);
        case "oj_fetch_profile":
          return provider.fetchProfile(parseInput(nowCoderProfileInputSchema, input, request.params.name), {
            signal: extra.signal
          });
        case "oj_list_submissions":
          return provider.listSubmissions(parseInput(nowCoderSubmissionsInputSchema, input, request.params.name), {
            signal: extra.signal
          });
        case "oj_prepare_submission":
          return provider.prepareSubmission(parseInput(ojPrepareSubmissionRequestSchema, input, request.params.name), extra.signal);
        case "oj_commit_submission": {
          const parsed = parseInput(commitSubmissionInputSchema, input, request.params.name);
          const preview = provider.getSubmissionPreview(parsed.intentId);
          const authorized = await confirmRealSubmission(server, preview, extra.signal);
          return provider.commitSubmission({
            ...parsed,
            confirmationProof: "mcp-form-elicitation"
          }, authorized, extra.signal);
        }
        case "oj_poll_submission":
          return provider.pollSubmission(parseInput(pollSubmissionInputSchema, input, request.params.name), extra.signal);
        case "oj_platform_run": {
          const parsed = parseInput(ojRunRequestSchema, input, request.params.name);
          const authorized = await confirmPlatformRun(server, parsed, extra.signal);
          return provider.platformRun(parsed, authorized, extra.signal);
        }
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
  openWorldHint: boolean,
  behavior: "read" | "localAction" | "realSubmit" = "read"
): Tool {
  return {
    name,
    title,
    description,
    inputSchema: z.toJSONSchema(inputSchema) as Tool["inputSchema"],
    outputSchema: toOjToolOutputSchema(successSchema) as Tool["outputSchema"],
    annotations: behavior === "read"
      ? readAnnotations(openWorldHint)
      : behavior === "realSubmit"
        ? realSubmitAnnotations(openWorldHint)
        : localActionAnnotations(openWorldHint)
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
  if (code === "policy.blocked" || code.startsWith("confirmation.")) return "policy";
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

function localActionAnnotations(openWorldHint: boolean) {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint
  } as const;
}

function realSubmitAnnotations(openWorldHint: boolean) {
  return {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint
  } as const;
}

async function confirmRealSubmission(
  server: McpServer,
  preview: OjSubmitPreview,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const result = await server.server.elicitInput({
      mode: "form",
      message: [
        `确认提交到牛客：${preview.problem.nativeId}`,
        `账号：${preview.account.displayName} (${preview.account.accountId})`,
        `语言：${preview.languageKey} / ${preview.platformLanguageId}`,
        `文件：${preview.fileLabel}`,
        `代码：${preview.codeBytes} bytes / SHA-256 ${preview.codeSha256}`
      ].join("\n"),
      requestedSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            title: "确认真实提交",
            description: "勾选后将立即向牛客提交一次。",
            default: false
          }
        },
        required: ["confirm"]
      }
    }, { signal });
    return result.action === "accept" && result.content?.confirm === true;
  } catch {
    throw new NowCoderAdapterError("confirmation.required", "The MCP client must show and accept the real-submission confirmation form.");
  }
}

async function confirmPlatformRun(server: McpServer, request: OjRunRequest, signal?: AbortSignal): Promise<boolean> {
  try {
    const result = await server.server.elicitInput({
      mode: "form",
      message: [
        `确认上传源码到牛客自测：${request.problem.nativeId}`,
        `语言：${request.code.languageKey} / ${request.code.platformLanguageId ?? "未指定"}`,
        `文件：${request.code.fileName ?? "student-code"}`,
        `代码：${request.code.bytes} bytes / SHA-256 ${request.code.sha256}`,
        `样例：${request.sampleOrdinals?.[0] ?? 1}`
      ].join("\n"),
      requestedSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            title: "确认平台自测",
            description: "勾选后将把这份源码上传到牛客并运行一次。",
            default: false
          }
        },
        required: ["confirm"]
      }
    }, { signal });
    return result.action === "accept" && result.content?.confirm === true;
  } catch {
    throw new NowCoderAdapterError("confirmation.required", "The MCP client must show and accept the platform-run confirmation form.");
  }
}
