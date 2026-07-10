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
    const largeBody = JSON.stringify({ status: "OK", result: { payload: "x".repeat(2_100_000) } });
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
});

class MemoryStorage implements CoordinatorStorage {
  private readonly values = new Map<string, unknown>();

  constructor(private readonly maxSerializedChars = Number.POSITIVE_INFINITY) {}

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    if (JSON.stringify(value).length > this.maxSerializedChars) {
      throw new Error("string or blob too big: SQLITE_TOOBIG");
    }
    this.values.set(key, value);
  }
}
