import type { OjError } from "@kaiserunix/oj-mcp-contracts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { LuoguPageClient, LuoguUpstreamAdmissionError, type LuoguPageReader, type LuoguPageResponse } from "./client.js";
import { LuoguHealthStore, LuoguProvider } from "./provider.js";
import { createLuoguMcpServer, LUOGU_MCP_TOOL_NAMES } from "./server.js";

export interface LuoguWorkerEnv {
  LUOGU_MCP_ALLOWED_ORIGINS?: string;
}

export interface LuoguWorkerOptions {
  ingressTimeoutMs?: number;
  maxConcurrentRequests?: number;
  maxQueuedRequests?: number;
  requestQueueTimeoutMs?: number;
  maxConcurrentUpstream?: number;
  maxQueuedUpstream?: number;
  upstreamQueueTimeoutMs?: number;
}

const MCP_PATH = "/mcp";
const CORS_HEADERS = "content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id";
const MAX_MCP_BODY_BYTES = 64 * 1024;
const DEFAULT_INGRESS_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 16;
const DEFAULT_MAX_QUEUED_REQUESTS = 32;
const DEFAULT_REQUEST_QUEUE_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_CONCURRENT_UPSTREAM = 4;
const DEFAULT_MAX_QUEUED_UPSTREAM = 16;
const DEFAULT_UPSTREAM_QUEUE_TIMEOUT_MS = 2_000;
const OVERLOAD_RETRY_AFTER_MS = 1_000;

export function createLuoguWorker(options: LuoguWorkerOptions = {}) {
  const ingressTimeoutMs = positiveInteger(options.ingressTimeoutMs ?? DEFAULT_INGRESS_TIMEOUT_MS, "ingressTimeoutMs");
  const requestAdmission = new AdmissionGate(
    positiveInteger(options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS, "maxConcurrentRequests"),
    nonNegativeInteger(options.maxQueuedRequests ?? DEFAULT_MAX_QUEUED_REQUESTS, "maxQueuedRequests"),
    positiveInteger(options.requestQueueTimeoutMs ?? DEFAULT_REQUEST_QUEUE_TIMEOUT_MS, "requestQueueTimeoutMs")
  );
  const upstreamAdmission = new AdmissionGate(
    positiveInteger(options.maxConcurrentUpstream ?? DEFAULT_MAX_CONCURRENT_UPSTREAM, "maxConcurrentUpstream"),
    nonNegativeInteger(options.maxQueuedUpstream ?? DEFAULT_MAX_QUEUED_UPSTREAM, "maxQueuedUpstream"),
    positiveInteger(options.upstreamQueueTimeoutMs ?? DEFAULT_UPSTREAM_QUEUE_TIMEOUT_MS, "upstreamQueueTimeoutMs")
  );
  const healthStore = new LuoguHealthStore();

  return {
    async fetch(request: Request, env: LuoguWorkerEnv): Promise<Response> {
      const url = new URL(request.url);
      const credentialError = rejectCredentials(request);
      if (credentialError) {
        return credentialError;
      }
      if (url.pathname === "/" || url.pathname === "/healthz") {
        return jsonResponse({
          name: "luogu-mcp-server",
          transport: "streamable-http",
          state: "stateless",
          authentication: "none",
          cookies: "never accepted or forwarded",
          mcpEndpoint: MCP_PATH,
          tools: LUOGU_MCP_TOOL_NAMES
        });
      }
      if (url.pathname !== MCP_PATH) {
        return jsonResponse({ error: "Not found", mcpEndpoint: MCP_PATH }, 404);
      }
      if (request.method === "OPTIONS") {
        const originError = validateOrigin(request, env);
        return originError ?? new Response(null, { status: 204, headers: corsHeaders(request, env) });
      }
      const originError = validateOrigin(request, env);
      if (originError) {
        return originError;
      }

      let admission: AdmissionResult;
      try {
        admission = await requestAdmission.acquire(request.signal);
      } catch (caught) {
        cancelBody(request.body, caught);
        throw caught;
      }
      if (admission.kind === "overloaded") {
        cancelBody(request.body);
        return withCorsHeaders(overloadResponse("request", admission.reason), request, env);
      }

      try {
        const parsed = request.method === "POST" ? await parseBoundedMcpBody(request, ingressTimeoutMs) : undefined;
        if (parsed instanceof Response) {
          return holdAdmissionUntilResponseCompletes(withCorsHeaders(parsed, request, env), admission, request.signal);
        }

        const provider = new LuoguProvider({
          reader: new AdmittedLuoguPageReader(new LuoguPageClient(), upstreamAdmission),
          transport: "remote_http",
          healthStore
        });
        const server = createLuoguMcpServer({ provider, requestSignal: request.signal });
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        const response = withCorsHeaders(await transport.handleRequest(request, { parsedBody: parsed }), request, env);
        return holdAdmissionUntilResponseCompletes(response, admission, request.signal);
      } catch (caught) {
        admission.release();
        throw caught;
      }
    }
  };
}

function holdAdmissionUntilResponseCompletes(
  response: Response,
  admission: AdmissionLease,
  signal: AbortSignal
): Response {
  if (!response.body) {
    admission.release();
    return response;
  }

  const reader = response.body.getReader();
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
    admission.release();
  };
  const onAbort = () => {
    cancelReader(reader, signal.reason);
    finalize();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          finalize();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (caught) {
        controller.error(caught);
        finalize();
      }
    },
    cancel(reason) {
      cancelReader(reader, reason);
      finalize();
    }
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function parseBoundedMcpBody(request: Request, ingressTimeoutMs: number): Promise<unknown | Response> {
  if (declaredBodyTooLarge(request.headers.get("content-length"))) {
    cancelBody(request.body);
    return jsonRpcError(413, -32000, `MCP request body is too large; maximum is ${MAX_MCP_BODY_BYTES} bytes.`);
  }

  const bytes = await readBoundedRequestBytes(request.body, request.signal, ingressTimeoutMs);
  if (bytes instanceof Response) {
    return bytes;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonRpcError(400, -32700, "Malformed JSON request body.");
  }
  if (Array.isArray(parsed)) {
    return jsonRpcError(400, -32600, "JSON-RPC batch requests are not supported.");
  }
  return parsed;
}

async function readBoundedRequestBytes(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  timeoutMs: number
): Promise<Uint8Array | Response> {
  if (!body) return new Uint8Array();
  if (signal.aborted) throw abortReason(signal);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let timedOut = false;
  const onAbort = () => void cancelReader(reader, signal.reason);
  const timeout = setTimeout(() => {
    timedOut = true;
    void cancelReader(reader, new DOMException("MCP request body ingress timed out.", "TimeoutError"));
  }, timeoutMs);
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw abortReason(signal);
      if (timedOut) return ingressTimeoutResponse();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_MCP_BODY_BYTES) {
        cancelReader(reader);
        return jsonRpcError(413, -32000, `MCP request body is too large; maximum is ${MAX_MCP_BODY_BYTES} bytes.`);
      }
      chunks.push(value);
    }
  } catch (caught) {
    cancelReader(reader, caught);
    if (signal.aborted) throw abortReason(signal);
    if (timedOut) return ingressTimeoutResponse();
    return jsonRpcError(400, -32700, "MCP request body could not be read.");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

class AdmittedLuoguPageReader implements LuoguPageReader {
  constructor(
    private readonly reader: LuoguPageReader,
    private readonly admission: AdmissionGate
  ) {}

  async searchProblems(options: {
    query: string;
    page: number;
    signal?: AbortSignal;
  }): Promise<LuoguPageResponse<unknown>> {
    return this.run(options.signal, () => this.reader.searchProblems(options));
  }

  async fetchProblem(nativeId: string, options: { signal?: AbortSignal } = {}): Promise<LuoguPageResponse<unknown>> {
    return this.run(options.signal, () => this.reader.fetchProblem(nativeId, options));
  }

  private async run<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const admission = await this.admission.acquire(signal);
    if (admission.kind === "overloaded") {
      throw new LuoguUpstreamAdmissionError(admission.reason, OVERLOAD_RETRY_AFTER_MS);
    }
    try {
      return await operation();
    } finally {
      admission.release();
    }
  }
}

type AdmissionResult = AdmissionLease | AdmissionOverload;
type AdmissionOverload = { kind: "overloaded"; reason: "queue_full" | "queue_timeout" };
type AdmissionLease = { kind: "acquired"; release: () => void };

interface AdmissionWaiter {
  resolve: (result: AdmissionResult) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timeout: ReturnType<typeof setTimeout>;
}

class AdmissionGate {
  private active = 0;
  private readonly queue: AdmissionWaiter[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
    private readonly queueTimeoutMs: number
  ) {}

  async acquire(signal?: AbortSignal): Promise<AdmissionResult> {
    if (signal?.aborted) throw abortReason(signal);
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return this.lease();
    }
    if (this.queue.length >= this.maxQueued) {
      return { kind: "overloaded", reason: "queue_full" };
    }

    return new Promise<AdmissionResult>((resolve, reject) => {
      const waiter: AdmissionWaiter = {
        resolve,
        reject,
        signal,
        timeout: setTimeout(() => {
          if (!this.remove(waiter)) return;
          this.cleanup(waiter);
          resolve({ kind: "overloaded", reason: "queue_timeout" });
        }, this.queueTimeoutMs)
      };
      if (signal) {
        waiter.onAbort = () => {
          if (!this.remove(waiter)) return;
          this.cleanup(waiter);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  private lease(): AdmissionLease {
    let released = false;
    return {
      kind: "acquired",
      release: () => {
        if (released) return;
        released = true;
        const waiter = this.queue.shift();
        if (waiter) {
          this.cleanup(waiter);
          waiter.resolve(this.lease());
        } else {
          this.active -= 1;
        }
      }
    };
  }

  private remove(waiter: AdmissionWaiter): boolean {
    const index = this.queue.indexOf(waiter);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    return true;
  }

  private cleanup(waiter: AdmissionWaiter): void {
    clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  }
}

function ingressTimeoutResponse(): Response {
  const message = "MCP request body ingress timed out.";
  return jsonRpcError(408, -32000, message, recoverableError("network.timeout", "transport", message));
}

function overloadResponse(scope: "request" | "upstream", reason: AdmissionOverload["reason"]): Response {
  const message = `Luogu ${scope} admission ${reason.replace("_", " ")}.`;
  return jsonRpcError(503, -32000, message, recoverableError("rate_limited", "broker", message));
}

function recoverableError(code: "network.timeout" | "rate_limited", layer: "transport" | "broker", message: string): OjError {
  return {
    schemaVersion: "oj.error/v1",
    code,
    layer,
    message,
    retryPolicy: "safe_read",
    userAction: "retry",
    platform: "luogu",
    providerId: "luogu-lentille-page-adapter",
    retryAfterMs: OVERLOAD_RETRY_AFTER_MS
  };
}

function declaredBodyTooLarge(value: string | null): boolean {
  if (!value || !/^\d+$/.test(value)) return false;
  try {
    return BigInt(value) > BigInt(MAX_MCP_BODY_BYTES);
  } catch {
    return true;
  }
}

function cancelBody(body: ReadableStream<Uint8Array> | null, reason?: unknown): void {
  if (!body || body.locked) return;
  cancelBestEffort(() => body.cancel(reason));
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void {
  cancelBestEffort(() => reader.cancel(reason));
}

function cancelBestEffort(cancel: () => Promise<void>): void {
  try {
    void cancel().catch(() => {
      // The response or cancellation reason remains authoritative.
    });
  } catch {
    // The response or cancellation reason remains authoritative.
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The MCP request was cancelled.", "AbortError");
}

function jsonRpcError(status: number, code: number, message: string, data?: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", error: { code, message, ...(data === undefined ? {} : { data }) }, id: null }, status);
}

function rejectCredentials(request: Request): Response | undefined {
  if (request.headers.has("cookie") || request.headers.has("authorization")) {
    return jsonResponse({ error: "This anonymous endpoint does not accept credentials." }, 400);
  }
  return undefined;
}

function validateOrigin(request: Request, env: LuoguWorkerEnv): Response | undefined {
  const origin = request.headers.get("origin");
  if (!origin) {
    return undefined;
  }
  const allowed = csv(env.LUOGU_MCP_ALLOWED_ORIGINS);
  if (allowed.includes("*") || allowed.includes(origin)) {
    return undefined;
  }
  return jsonResponse({ error: "Origin is not allowed." }, 403);
}

function withCorsHeaders(response: Response, request: Request, env: LuoguWorkerEnv): Response {
  if (!request.headers.get("origin")) {
    return response;
  }
  const headers = new Headers(response.headers);
  corsHeaders(request, env).forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function corsHeaders(request: Request, env: LuoguWorkerEnv): Headers {
  const headers = new Headers();
  const origin = request.headers.get("origin");
  const allowed = csv(env.LUOGU_MCP_ALLOWED_ORIGINS);
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

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer.`);
  return value;
}

const worker = createLuoguWorker();
export default worker;
