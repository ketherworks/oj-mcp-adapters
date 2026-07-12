import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { abortable, BoundedAdmission, CodeforcesQueueFullError } from "./admission.js";
import { CodeforcesApiClient } from "./client.js";
import {
  CodeforcesCoordinator,
  codeforcesUpstreamHealthObservationSchema,
  type CodeforcesUpstreamHealthObservation
} from "./coordinator.js";
import { CodeforcesProvider } from "./provider.js";
import { CodeforcesRateLimiter } from "./rateLimiter.js";
import { CODEFORCES_MCP_TOOL_NAMES, createCodeforcesMcpServer } from "./server.js";

interface CoordinatorStub {
  fetch(request: Request): Promise<Response>;
}

interface CoordinatorNamespace {
  getByName(name: string): CoordinatorStub;
}

export interface CodeforcesWorkerEnv {
  CODEFORCES_COORDINATOR?: CoordinatorNamespace;
  CODEFORCES_MCP_ALLOWED_ORIGINS?: string;
}

export interface CodeforcesWorkerOptions {
  maxRequestBytes?: number;
  maxConcurrentRequests?: number;
  maxQueuedRequests?: number;
  upstreamTimeoutMs?: number;
  ingressTimeoutMs?: number;
}

const MCP_PATH = "/mcp";
const CORS_HEADERS = "content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id";
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;

export function createCodeforcesWorker(options: CodeforcesWorkerOptions = {}) {
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? 15_000;
  const ingressTimeoutMs = options.ingressTimeoutMs ?? 10_000;
  assertBound(maxRequestBytes, 1, 8 * 1024 * 1024, "maxRequestBytes");
  assertBound(upstreamTimeoutMs, 1, 120_000, "upstreamTimeoutMs");
  assertBound(ingressTimeoutMs, 1, 120_000, "ingressTimeoutMs");
  const admission = new BoundedAdmission(
    options.maxConcurrentRequests ?? 8,
    options.maxQueuedRequests ?? 32,
    "Codeforces Worker"
  );

  return {
    async fetch(request: Request, env: CodeforcesWorkerEnv): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/" || url.pathname === "/healthz") {
        return respondBeforeBodyRead(
          request,
          jsonResponse({
            name: "codeforces-mcp-server",
            transport: "streamable-http",
            mcpEndpoint: MCP_PATH,
            authentication: "none",
            tools: CODEFORCES_MCP_TOOL_NAMES
          })
        );
      }
      if (url.pathname !== MCP_PATH) {
        return respondBeforeBodyRead(request, jsonResponse({ error: "Not found", mcpEndpoint: MCP_PATH }, 404));
      }
      if (request.method === "OPTIONS") {
        const originError = validateOrigin(request, env);
        return respondBeforeBodyRead(
          request,
          originError ?? new Response(null, { status: 204, headers: corsHeaders(request, env) })
        );
      }
      const originError = validateOrigin(request, env);
      if (originError) return respondBeforeBodyRead(request, originError);
      if (request.headers.has("cookie") || request.headers.has("authorization")) {
        return respondBeforeBodyRead(
          request,
          withCorsHeaders(jsonResponse({ error: "Credential-bearing requests are not accepted." }, 400), request, env)
        );
      }

      try {
        return await admission.run(request.signal, () =>
          handleMcpRequest(request, env, maxRequestBytes, upstreamTimeoutMs, ingressTimeoutMs)
        );
      } catch (error) {
        if (error instanceof CodeforcesQueueFullError) {
          cancelRequestBody(request);
          return withCorsHeaders(
            jsonResponse({ error: error.message, retryAfterMs: 2_000 }, 429, { "Retry-After": "2" }),
            request,
            env
          );
        }
        throw error;
      }
    }
  };
}

const worker = createCodeforcesWorker();

export { CodeforcesCoordinator };
export default worker;

async function handleMcpRequest(
  request: Request,
  env: CodeforcesWorkerEnv,
  maxRequestBytes: number,
  upstreamTimeoutMs: number,
  ingressTimeoutMs: number
): Promise<Response> {
  let parsedBody: unknown;
  if (request.method === "POST") {
    try {
      parsedBody = await readRequestJsonBounded(request, maxRequestBytes, ingressTimeoutMs);
    } catch (error) {
      if (request.signal.aborted) {
        throw request.signal.reason ?? new DOMException("The request was aborted.", "AbortError");
      }
      const response =
        error instanceof InboundRequestError
          ? jsonResponse({ error: error.message }, error.status)
          : jsonResponse({ error: "Invalid request body." }, 400);
      return withCorsHeaders(response, request, env);
    }
    if (Array.isArray(parsedBody)) {
      return withCorsHeaders(jsonRpcBatchUnsupportedResponse(), request, env);
    }
  }

  const stub = coordinatorStub(env);
  const provider = new CodeforcesProvider({
    client: new CodeforcesApiClient({
      limiter: new CodeforcesRateLimiter({ intervalMs: 0 }),
      timeoutMs: upstreamTimeoutMs,
      fetchImpl: async (_input, init) =>
        stub.fetch(new Request("https://coordinator/problemset.problems", { signal: init?.signal }))
    }),
    healthReader: async ({ signal } = {}) => readCoordinatorHealth(stub, signal, upstreamTimeoutMs)
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createCodeforcesMcpServer({ provider, transport: "remote_http" });
  await server.connect(transport);
  return withCorsHeaders(await transport.handleRequest(request, { parsedBody }), request, env);
}

function coordinatorStub(env: CodeforcesWorkerEnv): CoordinatorStub {
  const namespace = env.CODEFORCES_COORDINATOR;
  if (!namespace) {
    return {
      fetch: async () => {
        throw new Error("CODEFORCES_COORDINATOR binding is unavailable.");
      }
    };
  }
  return namespace.getByName("codeforces-official-api-v1");
}

async function readCoordinatorHealth(
  stub: CoordinatorStub,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<CodeforcesUpstreamHealthObservation | undefined> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await stub.fetch(new Request("https://coordinator/health", { signal: combined }));
  if (!response.ok) {
    cancelResponseBody(response);
    return undefined;
  }
  const parsed = codeforcesUpstreamHealthObservationSchema.nullable().safeParse(await response.json());
  return parsed.success ? parsed.data ?? undefined : undefined;
}

class InboundRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function readRequestJsonBounded(request: Request, maxBytes: number, timeoutMs: number): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      cancelRequestBody(request);
      throw new InboundRequestError(400, "Invalid Content-Length.");
    }
    if (BigInt(declared) > BigInt(maxBytes)) {
      cancelRequestBody(request);
      throw new InboundRequestError(413, `MCP request body exceeds ${maxBytes} bytes.`);
    }
  }
  const reader = request.body?.getReader();
  if (!reader) throw new InboundRequestError(400, "MCP POST request body is required.");
  const decoder = new TextDecoder();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([request.signal, timeoutSignal]);
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        cancelReader(reader);
        throw new InboundRequestError(413, `MCP request body exceeds ${maxBytes} bytes.`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    cancelReader(reader);
    if (request.signal.aborted) {
      throw request.signal.reason ?? new DOMException("The request was aborted.", "AbortError");
    }
    if (timeoutSignal.aborted) {
      throw new InboundRequestError(408, `MCP request body did not complete within ${timeoutMs} milliseconds.`);
    }
    throw error;
  }
  try {
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch {
    throw new InboundRequestError(400, "MCP request body must be valid JSON.");
  }
}

function jsonRpcBatchUnsupportedResponse(): Response {
  return jsonResponse(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "JSON-RPC batch requests are not supported."
      }
    },
    400
  );
}

function validateOrigin(request: Request, env: CodeforcesWorkerEnv): Response | undefined {
  const origin = request.headers.get("origin");
  if (!origin) return undefined;
  const allowed = csv(env.CODEFORCES_MCP_ALLOWED_ORIGINS);
  if (allowed.includes("*") || allowed.includes(origin)) return undefined;
  return jsonResponse({ error: "Origin is not allowed." }, 403);
}

function withCorsHeaders(response: Response, request: Request, env: CodeforcesWorkerEnv): Response {
  if (!request.headers.get("origin")) return response;
  const headers = new Headers(response.headers);
  corsHeaders(request, env).forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function corsHeaders(request: Request, env: CodeforcesWorkerEnv): Headers {
  const headers = new Headers();
  const origin = request.headers.get("origin");
  const allowed = csv(env.CODEFORCES_MCP_ALLOWED_ORIGINS);
  if (origin && (allowed.includes("*") || allowed.includes(origin))) {
    headers.set("Access-Control-Allow-Origin", allowed.includes("*") ? "*" : origin);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", CORS_HEADERS);
  headers.set("Access-Control-Expose-Headers", "mcp-session-id");
  return headers;
}

function respondBeforeBodyRead(request: Request, response: Response): Response {
  cancelRequestBody(request);
  return response;
}

function cancelRequestBody(request: Request): void {
  if (!request.body || request.body.locked) return;
  cancelBestEffort(() => request.body!.cancel());
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  cancelBestEffort(() => reader.cancel());
}

function cancelBestEffort(cancel: () => Promise<void>): void {
  try {
    void cancel().catch(() => {
      // Cleanup must not replace the intended ingress response.
    });
  } catch {
    // Cleanup must not replace the intended ingress response.
  }
}

function cancelResponseBody(response: Response): void {
  if (!response.body || response.body.locked) return;
  cancelBestEffort(() => response.body!.cancel());
}

function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders }
  });
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function assertBound(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be a safe integer between ${minimum} and ${maximum}.`);
  }
}
