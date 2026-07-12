import { describe, expect, test } from "vitest";
import { CodeforcesUpstreamCoordinator, type CoordinatorStorage } from "../src/coordinator.js";

describe("CodeforcesUpstreamCoordinator", () => {
  test("calls the Worker global fetch without binding a receiver", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function (this: unknown) {
      if (this !== undefined) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve(new Response("{}", { status: 503 }));
    } as typeof fetch;

    try {
      const coordinator = new CodeforcesUpstreamCoordinator({ storage: new MemoryStorage(), now: () => 0 });
      await expect(coordinator.fetchProblemset()).resolves.toMatchObject({ status: 503 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    { status: 301, location: "http://127.0.0.1/admin" },
    { status: 302, location: "http://localhost/internal" },
    { status: 307, location: "http://169.254.169.254/latest/meta-data" },
    { status: 308, location: "http://[::1]/private" }
  ])("does not follow HTTP $status redirects to $location", async ({ status, location }) => {
    let calls = 0;
    let observedRedirect: RequestRedirect | undefined;
    const coordinator = new CodeforcesUpstreamCoordinator({
      storage: new MemoryStorage(),
      fetchImpl: async (_input, init) => {
        calls += 1;
        observedRedirect = init?.redirect;
        return new Response(null, { status, headers: { Location: location } });
      },
      intervalMs: 0
    });

    const response = await coordinator.fetchProblemset();
    expect(response.status).toBe(status);
    expect(response.headers.get("location")).toBe(location);
    expect(calls).toBe(1);
    expect(observedRedirect).toBe("manual");
  });

  test("coalesces concurrent cache misses into one official API request", async () => {
    const storage = new MemoryStorage();
    let fetchCount = 0;
    const coordinator = new CodeforcesUpstreamCoordinator({
      storage,
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({ status: "OK", result: { problems: [], problemStatistics: [] } }), { status: 200 });
      },
      now: () => 1_000,
      cacheTtlMs: 60_000
    });

    const responses = await Promise.all([coordinator.fetchProblemset(), coordinator.fetchProblemset()]);

    expect(fetchCount).toBe(1);
    await expect(responses[0].json()).resolves.toMatchObject({ status: "OK" });
    await expect(responses[1].json()).resolves.toMatchObject({ status: "OK" });
  });

  test("chunks problemset responses larger than a Durable Object SQLite value", async () => {
    const storage = new MemoryStorage(1_000_000);
    const largeBody = problemsetBody(`large-${"x".repeat(2_100_000)}`);
    let fetchCount = 0;
    const coordinator = new CodeforcesUpstreamCoordinator({
      storage,
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response(largeBody, { status: 200 });
      },
      now: () => 1_000,
      cacheTtlMs: 60_000
    });

    const first = await coordinator.fetchProblemset();
    const second = await coordinator.fetchProblemset();

    expect(fetchCount).toBe(1);
    expect((await first.text()).length).toBe(largeBody.length);
    expect((await second.text()).length).toBe(largeBody.length);
  });

  test("serializes uncached upstream requests at least two seconds apart", async () => {
    const storage = new MemoryStorage();
    let now = 0;
    const startedAt: number[] = [];
    const coordinator = new CodeforcesUpstreamCoordinator({
      storage,
      fetchImpl: async () => {
        startedAt.push(now);
        return new Response("{}", { status: 503 });
      },
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      cacheTtlMs: 0,
      intervalMs: 2_000
    });

    await Promise.all([coordinator.fetchProblemset(), coordinator.fetchProblemset(), coordinator.fetchProblemset()]);

    expect(startedAt).toEqual([0, 2_000, 4_000]);
  });

  test("never caches API FAILED or schema-drift payloads", async () => {
    for (const body of [
      JSON.stringify({ status: "FAILED", comment: "Call limit exceeded" }),
      JSON.stringify({ status: "OK", result: { problems: "drift", problemStatistics: [] } })
    ]) {
      const storage = new MemoryStorage();
      let fetchCount = 0;
      const coordinator = new CodeforcesUpstreamCoordinator({
        storage,
        fetchImpl: async () => {
          fetchCount += 1;
          return new Response(body, { status: 200 });
        },
        now: () => 1_000,
        intervalMs: 0
      });

      await coordinator.fetchProblemset();
      await coordinator.fetchProblemset();
      expect(fetchCount).toBe(2);
    }
  });

  test("publishes generation metadata after chunks and removes prior and stale generations", async () => {
    const storage = new MemoryStorage();
    let now = 0;
    let body = problemsetBody("first");
    const coordinator = new CodeforcesUpstreamCoordinator({
      storage,
      fetchImpl: async () => new Response(body),
      now: () => now,
      cacheTtlMs: 10,
      intervalMs: 0,
      cacheChunkCharacters: 32
    });

    await coordinator.fetchProblemset();
    const firstMetadata = storage.value<{ generation: string }>("problemset-response/v2");
    expect(firstMetadata?.generation).toBeTruthy();
    expect(storage.puts.at(-1)).toBe("problemset-response/v2");
    await storage.put("problemset-response-chunk/v2/stale/0", "stale");

    now = 20;
    body = problemsetBody("second");
    await coordinator.fetchProblemset();
    const secondMetadata = storage.value<{ generation: string }>("problemset-response/v2");
    expect(secondMetadata?.generation).not.toBe(firstMetadata?.generation);
    const chunkKeys = storage.keys().filter((key) => key.startsWith("problemset-response-chunk/v2/"));
    expect(chunkKeys.length).toBeGreaterThan(0);
    expect(chunkKeys.every((key) => key.includes(`/${secondMetadata?.generation}/`))).toBe(true);
  });

  test("bounds the Durable Object queue and removes a cancelled waiter", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new CodeforcesUpstreamCoordinator({
      storage: new MemoryStorage(),
      fetchImpl: async () => {
        await gate;
        return new Response(problemsetBody("ok"));
      },
      now: () => 0,
      intervalMs: 0,
      maxQueued: 1
    });
    const active = coordinator.fetchProblemset();
    const controller = new AbortController();
    const queued = coordinator.fetchProblemset({ signal: controller.signal });

    await expect(coordinator.fetchProblemset()).rejects.toMatchObject({ name: "CodeforcesQueueFullError" });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    const replacement = coordinator.fetchProblemset();
    release();
    await active;
    await replacement;
  });

  test("times out upstream work and persists the last health observation", async () => {
    const storage = new MemoryStorage();
    let observedSignal: AbortSignal | undefined;
    const coordinator = new CodeforcesUpstreamCoordinator({
      storage,
      fetchImpl: async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), { once: true });
        });
      },
      timeoutMs: 20,
      intervalMs: 0
    });

    await expect(coordinator.fetchProblemset()).rejects.toMatchObject({ code: "network.timeout" });
    expect(observedSignal?.aborted).toBe(true);
    await expect(coordinator.getLastHealth()).resolves.toMatchObject({ code: "network.timeout" });

    const restarted = new CodeforcesUpstreamCoordinator({ storage, intervalMs: 0 });
    await expect(restarted.getLastHealth()).resolves.toMatchObject({ code: "network.timeout" });
  });

  test("returns fresh bodyless responses after cancelling 429 and non-OK bodies", async () => {
    for (const testCase of [
      { status: 429, headers: { "Retry-After": "7", "X-Upstream": "rate" } },
      { status: 503, headers: { "X-Upstream": "unavailable" } }
    ]) {
      let cancelled = false;
      const upstream = new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          }
        }),
        testCase
      );
      const coordinator = new CodeforcesUpstreamCoordinator({
        storage: new MemoryStorage(),
        fetchImpl: async () => upstream,
        intervalMs: 0
      });

      const returned = await coordinator.fetchProblemset();
      expect(cancelled).toBe(true);
      expect(returned).not.toBe(upstream);
      expect(returned.status).toBe(testCase.status);
      expect(returned.headers.get("x-upstream")).toBe(testCase.headers["X-Upstream"]);
      expect(returned.headers.get("retry-after")).toBe(testCase.status === 429 ? "7" : null);
      expect(returned.bodyUsed).toBe(false);
      await expect(returned.text()).resolves.toBe("");
    }
  });

  test("releases Durable Object admission when response cancellation never settles", async () => {
    let calls = 0;
    let cancelStarted = false;
    const coordinator = new CodeforcesUpstreamCoordinator({
      storage: new MemoryStorage(),
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelStarted = true;
                return new Promise<void>(() => undefined);
              }
            }),
            { status: 429 }
          );
        }
        return new Response(problemsetBody("after-cancel"));
      },
      intervalMs: 0,
      cacheTtlMs: 0,
      maxQueued: 0
    });

    const limited = await settleWithin(coordinator.fetchProblemset(), 100);
    const admitted = await settleWithin(coordinator.fetchProblemset(), 100);

    expect(limited.status).toBe(429);
    expect(admitted.status).toBe(200);
    expect(cancelStarted).toBe(true);
  });

  test("releases coordinator reader locks when bounded cancellation never settles", async () => {
    let cancelStarted = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(13));
      },
      cancel() {
        cancelStarted = true;
        return new Promise<void>(() => undefined);
      }
    });
    const coordinator = new CodeforcesUpstreamCoordinator({
      storage: new MemoryStorage(),
      fetchImpl: async () => new Response(body),
      intervalMs: 0,
      maxResponseBytes: 12,
      maxQueued: 0
    });

    await expect(settleWithin(coordinator.fetchProblemset(), 100)).rejects.toMatchObject({
      code: "upstream.schema_changed"
    });
    expect(cancelStarted).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("preserves timeout health when a post-header body read is cancelled", async () => {
    const storage = new MemoryStorage();
    let cancelStarted = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelStarted = true;
        return new Promise<void>(() => undefined);
      }
    });
    const coordinator = new CodeforcesUpstreamCoordinator({
      storage,
      fetchImpl: async () => new Response(body),
      intervalMs: 0,
      timeoutMs: 20
    });

    await expect(settleWithin(coordinator.fetchProblemset(), 100)).rejects.toMatchObject({ code: "network.timeout" });
    await expect(coordinator.getLastHealth()).resolves.toMatchObject({ code: "network.timeout" });
    expect(cancelStarted).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("rolls back attempted generation chunks when chunk or metadata publication fails", async () => {
    for (const failedKey of ["problemset-response-chunk/v2/", "problemset-response/v2"]) {
      const storage = new MemoryStorage();
      storage.failNextPutMatching((key) => key.startsWith(failedKey));
      const coordinator = new CodeforcesUpstreamCoordinator({
        storage,
        fetchImpl: async () => new Response(problemsetBody("rollback")),
        cacheChunkCharacters: 32,
        intervalMs: 0
      });

      await expect(coordinator.fetchProblemset()).rejects.toThrow("injected storage failure");
      expect(storage.keys().some((key) => key.startsWith("problemset-response-chunk/v2/"))).toBe(false);
      expect(storage.value("problemset-response/v2")).toBeUndefined();
    }
  });
});

class MemoryStorage implements CoordinatorStorage {
  private readonly values = new Map<string, unknown>();
  private failPut?: (key: string) => boolean;

  constructor(private readonly maxSerializedChars = Number.POSITIVE_INFINITY) {}

  readonly puts: string[] = [];

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    if (this.failPut?.(key)) {
      this.failPut = undefined;
      throw new Error("injected storage failure");
    }
    if (JSON.stringify(value).length > this.maxSerializedChars) {
      throw new Error("string or blob too big: SQLITE_TOOBIG");
    }
    this.values.set(key, value);
    this.puts.push(key);
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }

  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.values.entries()].filter(([key]) => key.startsWith(options.prefix)) as Array<[string, T]>
    );
  }

  value<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  keys(): string[] {
    return [...this.values.keys()];
  }

  failNextPutMatching(predicate: (key: string) => boolean): void {
    this.failPut = predicate;
  }
}

function problemsetBody(name: string): string {
  return JSON.stringify({
    status: "OK",
    result: {
      problems: [{ contestId: 1, index: "A", name, type: "PROGRAMMING", tags: [] }],
      problemStatistics: [{ contestId: 1, index: "A", solvedCount: 1 }]
    }
  });
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Promise did not settle within ${timeoutMs}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
