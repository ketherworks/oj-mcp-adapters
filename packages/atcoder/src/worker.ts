import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AtCoderHtmlClient } from "./client.js";
import { AtCoderProvider } from "./provider.js";
import { ATCODER_MCP_TOOL_NAMES, createAtCoderMcpServer } from "./server.js";

export interface AtCoderWorkerEnv {
  ATCODER_MCP_ALLOWED_ORIGINS?: string;
}

export interface AtCoderWorkerOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  nowIso?: () => string;
  maxInboundBytes?: number;
  maxConcurrentRequests?: number;
  ingressTimeoutMs?: number;
}

export interface AtCoderWorker {
  fetch(request: Request, env: AtCoderWorkerEnv): Promise<Response>;
}

const MCP_PATH = "/mcp";
const CORS_HEADERS = "content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id";
const DEFAULT_MAX_INBOUND_BYTES = 64 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 8;
const DEFAULT_INGRESS_TIMEOUT_MS = 10_000;

export function createAtCoderWorker(options: AtCoderWorkerOptions = {}): AtCoderWorker {
  const maxInboundBytes = positiveInteger(options.maxInboundBytes ?? DEFAULT_MAX_INBOUND_BYTES, "maxInboundBytes");
  const ingressTimeoutMs = positiveInteger(options.ingressTimeoutMs ?? DEFAULT_INGRESS_TIMEOUT_MS, "ingressTimeoutMs");
  const admission = new BoundedAdmission(
    positiveInteger(options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS, "maxConcurrentRequests")
  );
  const provider = new AtCoderProvider({
    client: new AtCoderHtmlClient({ ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.nowIso ? { nowIso: options.nowIso } : {})
  });
  return {
    async fetch(request: Request, env: AtCoderWorkerEnv): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/" || url.pathname === "/healthz") {
        return jsonResponse({
          name: "atcoder-mcp-server",
          transport: "streamable-http",
          stateless: true,
          mcpEndpoint: MCP_PATH,
          authentication: "none",
          tools: ATCODER_MCP_TOOL_NAMES
        });
      }
      if (url.pathname !== MCP_PATH) return jsonResponse({ error: "Not found", mcpEndpoint: MCP_PATH }, 404);
      if (request.method === "OPTIONS") {
        const originError = validateOrigin(request, env);
        return originError ?? new Response(null, { status: 204, headers: corsHeaders(request, env) });
      }
      const originError = validateOrigin(request, env);
      if (originError) return originError;

      const release = admission.tryAcquire();
      if (!release) {
        cancelRequestBody(request);
        return withCorsHeaders(jsonResponse({ error: "AtCoder MCP request capacity is full." }, 503), request, env);
      }

      let transport: WebStandardStreamableHTTPServerTransport | undefined;
      let server: ReturnType<typeof createAtCoderMcpServer> | undefined;
      try {
        if (request.headers.has("authorization") || request.headers.has("cookie")) {
          cancelRequestBody(request);
          return withCorsHeaders(
            jsonResponse({ error: "Authentication headers are not accepted." }, 400),
            request,
            env
          );
        }
        const prepared =
          request.method === "POST"
            ? await prepareBoundedPost(request, maxInboundBytes, ingressTimeoutMs)
            : request;
        if (prepared instanceof Response) return withCorsHeaders(prepared, request, env);
        transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true
        });
        server = createAtCoderMcpServer({ provider, transport: "remote_http" });
        await server.connect(transport);
        return withCorsHeaders(await transport.handleRequest(prepared), request, env);
      } finally {
        try {
          if (server) await server.close();
          else await transport?.close();
        } finally {
          release();
        }
      }
    }
  };
}

function validateOrigin(request: Request, env: AtCoderWorkerEnv): Response | undefined {
  const origin = request.headers.get("origin");
  if (!origin) return undefined;
  const allowed = csv(env.ATCODER_MCP_ALLOWED_ORIGINS);
  if (allowed.includes("*") || allowed.includes(origin)) return undefined;
  return jsonResponse({ error: "Origin is not allowed." }, 403);
}

function withCorsHeaders(response: Response, request: Request, env: AtCoderWorkerEnv): Response {
  if (!request.headers.get("origin")) return response;
  const headers = new Headers(response.headers);
  corsHeaders(request, env).forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function corsHeaders(request: Request, env: AtCoderWorkerEnv): Headers {
  const headers = new Headers();
  const origin = request.headers.get("origin");
  const allowed = csv(env.ATCODER_MCP_ALLOWED_ORIGINS);
  if (origin && (allowed.includes("*") || allowed.includes(origin))) {
    headers.set("Access-Control-Allow-Origin", allowed.includes("*") ? "*" : origin);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", CORS_HEADERS);
  headers.set("Access-Control-Expose-Headers", "mcp-session-id");
  return headers;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

class BoundedAdmission {
  private active = 0;

  constructor(private readonly maximum: number) {}

  tryAcquire(): (() => void) | undefined {
    if (this.active >= this.maximum) return undefined;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

async function prepareBoundedPost(
  request: Request,
  maximumBytes: number,
  ingressTimeoutMs: number
): Promise<Request | Response> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^[0-9]+$/.test(declared)) {
      cancelRequestBody(request);
      return jsonResponse({ error: "Invalid Content-Length." }, 400);
    }
    if (Number(declared) > maximumBytes) {
      cancelRequestBody(request);
      return jsonResponse({ error: "MCP request body is too large." }, 413);
    }
  }

  const body = await readBoundedRequestBody(request, maximumBytes, ingressTimeoutMs);
  if (body instanceof Response) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return jsonResponse({ error: "MCP request body must be valid JSON." }, 400);
  }
  if (Array.isArray(parsed)) return jsonResponse({ error: "JSON-RPC batches are not supported." }, 400);
  if (!parsed || typeof parsed !== "object") return jsonResponse({ error: "MCP request body must be a JSON object." }, 400);

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body,
    signal: request.signal
  });
}

async function readBoundedRequestBody(
  request: Request,
  maximumBytes: number,
  ingressTimeoutMs: number
): Promise<string | Response> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const timeoutSignal = AbortSignal.timeout(ingressTimeoutMs);
  const signal = AbortSignal.any([request.signal, timeoutSignal]);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        cancelReader(reader);
        return jsonResponse({ error: "MCP request body is too large." }, 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    cancelReader(reader);
    if (request.signal.aborted) {
      throw request.signal.reason ?? new DOMException("The request was aborted.", "AbortError");
    }
    if (timeoutSignal.aborted) {
      return jsonResponse(
        { error: `MCP request body did not complete within ${ingressTimeoutMs} milliseconds.` },
        408
      );
    }
    throw error;
  } finally {
    releaseReader(reader);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return jsonResponse({ error: "MCP request body must be valid UTF-8." }, 400);
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  cancelBestEffort(() => reader.cancel());
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // Cleanup must not replace the intended ingress response or abort.
  }
}

function cancelRequestBody(request: Request): void {
  if (!request.body || request.body.locked) return;
  cancelBestEffort(() => request.body!.cancel());
}

function cancelBestEffort(cancel: () => Promise<void>): void {
  try {
    void cancel().catch(() => {
      // Cleanup must not replace the intended ingress response or abort.
    });
  } catch {
    // Cleanup must not replace the intended ingress response or abort.
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer.`);
  return value;
}

const worker = createAtCoderWorker();
export default worker;
