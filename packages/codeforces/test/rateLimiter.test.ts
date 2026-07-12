import { describe, expect, test } from "vitest";
import { CodeforcesRateLimiter } from "../src/rateLimiter.js";

describe("CodeforcesRateLimiter", () => {
  test("serializes concurrent upstream calls at least two seconds apart", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const limiter = new CodeforcesRateLimiter({
      intervalMs: 2_000,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      }
    });
    const startedAt: number[] = [];

    await Promise.all([
      limiter.schedule(async () => startedAt.push(now)),
      limiter.schedule(async () => startedAt.push(now)),
      limiter.schedule(async () => startedAt.push(now))
    ]);

    expect(startedAt).toEqual([0, 2_000, 4_000]);
    expect(sleeps).toEqual([2_000, 2_000]);
  });

  test("bounds its wait queue and removes a cancelled waiter", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const limiter = new CodeforcesRateLimiter({ intervalMs: 0, maxQueued: 1 });
    const active = limiter.schedule(async () => gate);
    const controller = new AbortController();
    const queued = limiter.schedule(async () => undefined, controller.signal);

    await expect(limiter.schedule(async () => undefined)).rejects.toMatchObject({ name: "CodeforcesQueueFullError" });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    const replacement = limiter.schedule(async () => "replacement");
    release();
    await expect(replacement).resolves.toBe("replacement");
    await active;
  });
});
