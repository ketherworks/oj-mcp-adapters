export interface CoordinatorStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface CodeforcesUpstreamCoordinatorOptions {
  storage: CoordinatorStorage;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  cacheTtlMs?: number;
  intervalMs?: number;
}

interface CachedResponse {
  expiresAt: number;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  bodyChunkCount: number;
}

const CACHE_KEY = "problemset-response/v1";
const CACHE_CHUNK_PREFIX = "problemset-response-chunk/v1/";
const LAST_STARTED_AT_KEY = "upstream-last-started-at/v1";
const CACHE_CHUNK_CHARACTERS = 250_000;

export class CodeforcesUpstreamCoordinator {
  private readonly storage: CoordinatorStorage;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly cacheTtlMs: number;
  private readonly intervalMs: number;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: CodeforcesUpstreamCoordinatorOptions) {
    this.storage = options.storage;
    const fetchImpl = options.fetchImpl ?? fetch;
    this.fetchImpl = (input, init) => fetchImpl(input, init);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.cacheTtlMs = options.cacheTtlMs ?? 10 * 60_000;
    this.intervalMs = options.intervalMs ?? 2_000;
  }

  fetchProblemset(): Promise<Response> {
    const scheduled = this.tail.then(() => this.fetchProblemsetSerialized());
    this.tail = scheduled.then(
      () => undefined,
      () => undefined
    );
    return scheduled;
  }

  private async fetchProblemsetSerialized(): Promise<Response> {
    const cached = await this.storage.get<CachedResponse>(CACHE_KEY);
    if (cached && cached.expiresAt > this.now()) {
      const restored = await this.restoreCachedResponse(cached);
      if (restored) {
        return restored;
      }
    }

    const lastStartedAt = await this.storage.get<number>(LAST_STARTED_AT_KEY);
    if (lastStartedAt !== undefined) {
      const remaining = this.intervalMs - (this.now() - lastStartedAt);
      if (remaining > 0) {
        await this.sleep(remaining);
      }
    }
    await this.storage.put(LAST_STARTED_AT_KEY, this.now());

    const response = await this.fetchImpl("https://codeforces.com/api/problemset.problems", {
      headers: { Accept: "application/json", "User-Agent": "oj-mcp-codeforces/0.1.0" }
    });
    const captured = await captureResponse(response, this.now() + this.cacheTtlMs);
    if (response.ok && this.cacheTtlMs > 0) {
      await Promise.all(captured.bodyChunks.map((chunk, index) => this.storage.put(`${CACHE_CHUNK_PREFIX}${index}`, chunk)));
      await this.storage.put(CACHE_KEY, captured.metadata);
    }
    return restoreResponse(captured.metadata, captured.body);
  }

  private async restoreCachedResponse(metadata: CachedResponse): Promise<Response | undefined> {
    const chunks = await Promise.all(
      Array.from({ length: metadata.bodyChunkCount }, (_, index) => this.storage.get<string>(`${CACHE_CHUNK_PREFIX}${index}`))
    );
    if (chunks.some((chunk) => chunk === undefined)) {
      return undefined;
    }
    return restoreResponse(metadata, chunks.join(""));
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
    if (new URL(request.url).pathname !== "/problemset.problems") {
      return new Response("Not found", { status: 404 });
    }
    return this.coordinator.fetchProblemset();
  }
}

async function captureResponse(
  response: Response,
  expiresAt: number
): Promise<{ metadata: CachedResponse; body: string; bodyChunks: string[] }> {
  const headers: Array<[string, string]> = [];
  response.headers.forEach((value, key) => headers.push([key, value]));
  const body = await response.text();
  const bodyChunks: string[] = [];
  for (let offset = 0; offset < body.length; offset += CACHE_CHUNK_CHARACTERS) {
    bodyChunks.push(body.slice(offset, offset + CACHE_CHUNK_CHARACTERS));
  }
  return {
    metadata: {
      expiresAt,
      status: response.status,
      statusText: response.statusText,
      headers,
      bodyChunkCount: bodyChunks.length
    },
    body,
    bodyChunks
  };
}

function restoreResponse(metadata: CachedResponse, body: string): Response {
  return new Response(body, {
    status: metadata.status,
    statusText: metadata.statusText,
    headers: metadata.headers
  });
}
