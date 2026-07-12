import { z } from "zod";
import { abortable, BoundedAdmission, CodeforcesQueueFullError, throwIfAborted } from "./admission.js";
import {
  CodeforcesApiError,
  CodeforcesRequestCancelledError,
  codeforcesProblemsetResponseSchema
} from "./client.js";

export interface CoordinatorStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(keys: string | string[]): Promise<unknown>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

export const codeforcesUpstreamHealthObservationSchema = z
  .object({
    checkedAt: z.iso.datetime(),
    code: z
      .enum(["rate_limited", "network.timeout", "upstream.unavailable", "upstream.schema_changed"])
      .optional(),
    retryAfterMs: z.number().nonnegative().optional(),
    latencyMs: z.number().nonnegative().optional()
  })
  .strict();

export type CodeforcesUpstreamHealthObservation = z.infer<typeof codeforcesUpstreamHealthObservationSchema>;

export interface CodeforcesUpstreamCoordinatorOptions {
  storage: CoordinatorStorage;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  cacheTtlMs?: number;
  intervalMs?: number;
  timeoutMs?: number;
  maxQueued?: number;
  maxResponseBytes?: number;
  cacheChunkCharacters?: number;
}

interface CachedResponse {
  generation: string;
  expiresAt: number;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  bodyChunkCount: number;
}

interface CapturedResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;
}

const CACHE_KEY = "problemset-response/v2";
const CACHE_CHUNK_PREFIX = "problemset-response-chunk/v2/";
const LAST_STARTED_AT_KEY = "upstream-last-started-at/v1";
const LAST_HEALTH_KEY = "upstream-last-health/v1";
const DEFAULT_CACHE_CHUNK_CHARACTERS = 250_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_CHUNKS = 512;
const cachedResponseSchema = z
  .object({
    generation: z.string().regex(/^[a-z0-9-]{1,80}$/i),
    expiresAt: z.number().finite(),
    status: z.number().int().min(100).max(599),
    statusText: z.string().max(128),
    headers: z.array(z.tuple([z.string().max(256), z.string().max(8_192)])).max(64),
    bodyChunkCount: z.number().int().min(1).max(MAX_CACHE_CHUNKS)
  })
  .strict();

export class CodeforcesUpstreamCoordinator {
  private readonly storage: CoordinatorStorage;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly cacheTtlMs: number;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly cacheChunkCharacters: number;
  private readonly admission: BoundedAdmission;

  constructor(options: CodeforcesUpstreamCoordinatorOptions) {
    this.storage = options.storage;
    const fetchImpl = options.fetchImpl ?? fetch;
    this.fetchImpl = (input, init) => fetchImpl(input, init);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.cacheTtlMs = options.cacheTtlMs ?? 10 * 60_000;
    this.intervalMs = options.intervalMs ?? 2_000;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.cacheChunkCharacters = options.cacheChunkCharacters ?? DEFAULT_CACHE_CHUNK_CHARACTERS;
    this.admission = new BoundedAdmission(1, options.maxQueued ?? 32, "Codeforces Durable Object");
    assertPositiveLimit(this.timeoutMs, "timeoutMs");
    assertPositiveLimit(this.maxResponseBytes, "maxResponseBytes");
    assertPositiveLimit(this.cacheChunkCharacters, "cacheChunkCharacters");
    if (this.cacheChunkCharacters > DEFAULT_CACHE_CHUNK_CHARACTERS) {
      throw new RangeError(`cacheChunkCharacters must not exceed ${DEFAULT_CACHE_CHUNK_CHARACTERS}.`);
    }
  }

  fetchProblemset(options: { signal?: AbortSignal } = {}): Promise<Response> {
    return this.admission.run(options.signal, () => this.fetchProblemsetSerialized(options.signal));
  }

  async getLastHealth(): Promise<CodeforcesUpstreamHealthObservation | undefined> {
    const parsed = codeforcesUpstreamHealthObservationSchema.safeParse(
      await this.storage.get<unknown>(LAST_HEALTH_KEY)
    );
    return parsed.success ? parsed.data : undefined;
  }

  private async fetchProblemsetSerialized(signal?: AbortSignal): Promise<Response> {
    const cached = await this.storage.get<unknown>(CACHE_KEY);
    const restored = await this.restoreCachedResponse(cached);
    if (restored) return restored;

    const lastStartedAt = await this.storage.get<number>(LAST_STARTED_AT_KEY);
    if (lastStartedAt !== undefined) {
      const remaining = this.intervalMs - (this.now() - lastStartedAt);
      if (remaining > 0) await abortable(this.sleep(remaining), signal);
    }
    throwIfAborted(signal);
    await this.storage.put(LAST_STARTED_AT_KEY, this.now());

    const startedAt = this.now();
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const upstreamSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImpl("https://codeforces.com/api/problemset.problems", {
        headers: { Accept: "application/json", "User-Agent": "oj-mcp-codeforces/0.1.0" },
        redirect: "manual",
        signal: upstreamSignal
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const code: CodeforcesUpstreamHealthObservation["code"] =
        timeoutSignal.aborted || isTimeoutError(error) ? "network.timeout" : "upstream.unavailable";
      const mapped = new CodeforcesApiError(code, error instanceof Error ? error.message : String(error));
      await this.recordHealth(code, startedAt, mapped.retryAfterMs);
      throw mapped;
    }

    if (response.status === 429) {
      const retryAfterMs = retryAfterMilliseconds(response);
      const returned = bodylessResponse(response);
      cancelResponseBody(response);
      await this.recordHealth("rate_limited", startedAt, retryAfterMs);
      return returned;
    }
    if (!response.ok) {
      const returned = bodylessResponse(response);
      cancelResponseBody(response);
      await this.recordHealth(response.status === 504 ? "network.timeout" : "upstream.unavailable", startedAt);
      return returned;
    }

    let captured: CapturedResponse;
    try {
      captured = await captureResponse(response, this.maxResponseBytes, upstreamSignal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const code = timeoutSignal.aborted || isTimeoutError(error) ? "network.timeout" : "upstream.schema_changed";
      await this.recordHealth(code, startedAt);
      throw new CodeforcesApiError(code, "Codeforces response could not be captured within audited bounds.");
    }

    const classification = classifyProblemsetBody(captured.body);
    await this.recordHealth(classification.code, startedAt, classification.retryAfterMs);
    if (!classification.code && this.cacheTtlMs > 0) {
      await this.publishCache(captured);
    }
    return restoreResponse(captured, captured.body);
  }

  private async publishCache(captured: CapturedResponse): Promise<void> {
    const generation = `${this.now().toString(36)}-${crypto.randomUUID()}`;
    const chunks = chunkString(captured.body, this.cacheChunkCharacters);
    if (chunks.length > MAX_CACHE_CHUNKS) return;
    const generationPrefix = `${CACHE_CHUNK_PREFIX}${generation}/`;
    const generationKeys = chunks.map((_, index) => `${generationPrefix}${index}`);
    const writes = await Promise.allSettled(
      chunks.map((chunk, index) => this.storage.put(generationKeys[index], chunk))
    );
    const failedWrite = writes.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failedWrite) {
      await this.rollbackGeneration(generationKeys, failedWrite.reason);
    }
    const metadata: CachedResponse = {
      generation,
      expiresAt: this.now() + this.cacheTtlMs,
      status: captured.status,
      statusText: captured.statusText,
      headers: captured.headers,
      bodyChunkCount: chunks.length
    };
    try {
      await this.storage.put(CACHE_KEY, metadata);
    } catch (error) {
      await this.rollbackGeneration(generationKeys, error);
    }
    const allChunks = await this.storage.list<string>({ prefix: CACHE_CHUNK_PREFIX });
    const staleKeys = [...allChunks.keys()].filter((key) => !key.startsWith(generationPrefix));
    if (staleKeys.length > 0) await this.storage.delete(staleKeys);
  }

  private async rollbackGeneration(generationKeys: string[], publicationError: unknown): Promise<never> {
    try {
      await this.storage.delete(generationKeys);
    } catch (cleanupError) {
      throw new AggregateError([publicationError, cleanupError], "Codeforces cache publication and rollback both failed.");
    }
    throw publicationError;
  }

  private async restoreCachedResponse(value: unknown): Promise<Response | undefined> {
    const metadata = parseCachedResponse(value);
    if (!metadata || metadata.expiresAt <= this.now()) return undefined;
    const prefix = `${CACHE_CHUNK_PREFIX}${metadata.generation}/`;
    const chunks = await Promise.all(
      Array.from({ length: metadata.bodyChunkCount }, (_, index) => this.storage.get<string>(`${prefix}${index}`))
    );
    if (chunks.some((chunk) => typeof chunk !== "string" || chunk.length > this.cacheChunkCharacters)) return undefined;
    const body = chunks.join("");
    if (new TextEncoder().encode(body).byteLength > this.maxResponseBytes) return undefined;
    if (classifyProblemsetBody(body).code) return undefined;
    return restoreResponse(metadata, body);
  }

  private async recordHealth(
    code: CodeforcesUpstreamHealthObservation["code"],
    startedAt: number,
    retryAfterMs?: number
  ): Promise<void> {
    await this.storage.put(
      LAST_HEALTH_KEY,
      codeforcesUpstreamHealthObservationSchema.parse({
        checkedAt: new Date(this.now()).toISOString(),
        code,
        retryAfterMs,
        latencyMs: Math.max(0, this.now() - startedAt)
      })
    );
  }
}

export interface DurableObjectStateLike {
  storage: CoordinatorStorage;
}

export class CodeforcesCoordinator {
  private readonly coordinator: CodeforcesUpstreamCoordinator;

  constructor(state: DurableObjectStateLike) {
    this.coordinator = new CodeforcesUpstreamCoordinator({ storage: state.storage });
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/health") {
      return jsonResponse((await this.coordinator.getLastHealth()) ?? null);
    }
    if (pathname !== "/problemset.problems") return new Response("Not found", { status: 404 });
    try {
      return await this.coordinator.fetchProblemset({ signal: request.signal });
    } catch (error) {
      if (error instanceof CodeforcesQueueFullError) {
        return jsonResponse({ error: error.message }, 429, { "Retry-After": "2" });
      }
      if (error instanceof CodeforcesRequestCancelledError || request.signal.aborted) throw error;
      if (error instanceof CodeforcesApiError) {
        return jsonResponse(
          { error: error.message },
          error.code === "network.timeout" ? 504 : 503,
          error.retryAfterMs === undefined ? undefined : { "Retry-After": String(error.retryAfterMs / 1_000) }
        );
      }
      return jsonResponse({ error: "Codeforces coordinator failed." }, 503);
    }
  }
}

function classifyProblemsetBody(body: string): Pick<CodeforcesUpstreamHealthObservation, "code" | "retryAfterMs"> {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return { code: "upstream.schema_changed" };
  }
  if (isFailedResponse(payload)) {
    const rateLimited = /call limit exceeded/i.test(payload.comment ?? "");
    return { code: rateLimited ? "rate_limited" : "upstream.unavailable", retryAfterMs: rateLimited ? 2_000 : undefined };
  }
  return codeforcesProblemsetResponseSchema.safeParse(payload).success ? {} : { code: "upstream.schema_changed" };
}

function parseCachedResponse(value: unknown): CachedResponse | undefined {
  const parsed = cachedResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

async function captureResponse(response: Response, maxBytes: number, signal: AbortSignal): Promise<CapturedResponse> {
  const headers: Array<[string, string]> = [];
  response.headers.forEach((value, key) => headers.push([key, value]));
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: await readResponseTextBounded(response, maxBytes, signal)
  };
}

async function readResponseTextBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  const onAbort = () => cancelReader(reader);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        cancelReader(reader);
        throw new RangeError("Codeforces response exceeded the coordinator byte limit.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    cancelReader(reader);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function chunkString(body: string, size: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < body.length; offset += size) chunks.push(body.slice(offset, offset + size));
  return chunks;
}

function restoreResponse(metadata: Pick<CachedResponse, "status" | "statusText" | "headers">, body: string): Response {
  return new Response(body, { status: metadata.status, statusText: metadata.statusText, headers: metadata.headers });
}

function bodylessResponse(response: Response): Response {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers)
  });
}

function isFailedResponse(value: unknown): value is { status: "FAILED"; comment?: string } {
  return Boolean(value && typeof value === "object" && "status" in value && value.status === "FAILED");
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } };
  return (
    candidate.name === "TimeoutError" ||
    candidate.code === "ETIMEDOUT" ||
    candidate.code === "UND_ERR_CONNECT_TIMEOUT" ||
    candidate.cause?.code === "ETIMEDOUT" ||
    candidate.cause?.code === "UND_ERR_CONNECT_TIMEOUT"
  );
}

function cancelResponseBody(response: Response): void {
  if (!response.body || response.body.locked) return;
  cancelBestEffort(() => response.body!.cancel());
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  cancelBestEffort(() => reader.cancel());
}

function cancelBestEffort(cancel: () => Promise<void>): void {
  try {
    void cancel().catch(() => {
      // Cleanup must not replace the upstream classification.
    });
  } catch {
    // Cleanup must not replace the upstream classification.
  }
}

function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders }
  });
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer.`);
}
