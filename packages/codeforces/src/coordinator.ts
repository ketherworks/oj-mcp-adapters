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
  body: string;
}

const CACHE_KEY = "problemset-response/v1";
const LAST_STARTED_AT_KEY = "upstream-last-started-at/v1";

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
      return restoreResponse(cached);
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
    const record = await captureResponse(response, this.now() + this.cacheTtlMs);
    if (response.ok && this.cacheTtlMs > 0) {
      await this.storage.put(CACHE_KEY, record);
    }
    return restoreResponse(record);
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

async function captureResponse(response: Response, expiresAt: number): Promise<CachedResponse> {
  const headers: Array<[string, string]> = [];
  response.headers.forEach((value, key) => headers.push([key, value]));
  return {
    expiresAt,
    status: response.status,
    statusText: response.statusText,
    headers,
    body: await response.text()
  };
}

function restoreResponse(record: CachedResponse): Response {
  return new Response(record.body, {
    status: record.status,
    statusText: record.statusText,
    headers: record.headers
  });
}
