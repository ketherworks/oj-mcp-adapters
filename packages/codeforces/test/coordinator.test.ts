import { describe, expect, test } from "vitest";
import { CodeforcesUpstreamCoordinator, type CoordinatorStorage } from "../src/coordinator.js";

describe("CodeforcesUpstreamCoordinator", () => {
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

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
}
