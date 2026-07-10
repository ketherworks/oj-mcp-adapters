import { describe, expect, test } from "vitest";
import { CodeforcesApiClient, CodeforcesApiError } from "../src/client.js";
import type { CodeforcesRateLimiter } from "../src/rateLimiter.js";
import { loadFixture } from "./fixtureLoader.js";

describe("CodeforcesApiClient", () => {
  test("calls the default fetch without binding a receiver", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function (this: unknown) {
      if (this !== undefined) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve(new Response(JSON.stringify({ status: "OK", result: { problems: [], problemStatistics: [] } })));
    } as typeof fetch;

    try {
      const client = new CodeforcesApiClient({ limiter: immediateLimiter() });
      await expect(client.getProblemset()).resolves.toMatchObject({ status: "OK" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fetches and validates the official problemset response", async () => {
    const payload = await loadFixture("problemset-ok.json");
    const client = new CodeforcesApiClient({
      fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
      limiter: immediateLimiter()
    });

    await expect(client.getProblemset()).resolves.toMatchObject({ status: "OK" });
  });

  test("maps HTTP 429 and API FAILED to actionable rate limits", async () => {
    const httpClient = new CodeforcesApiClient({
      fetchImpl: async () => new Response("", { status: 429, headers: { "Retry-After": "3" } }),
      limiter: immediateLimiter()
    });
    const failedPayload = await loadFixture("api-failed.json");
    const apiClient = new CodeforcesApiClient({
      fetchImpl: async () => new Response(JSON.stringify(failedPayload), { status: 200 }),
      limiter: immediateLimiter()
    });

    await expect(httpClient.getProblemset()).rejects.toMatchObject<Partial<CodeforcesApiError>>({
      code: "rate_limited",
      retryAfterMs: 3_000
    });
    await expect(apiClient.getProblemset()).rejects.toMatchObject<Partial<CodeforcesApiError>>({ code: "rate_limited" });
  });

  test("rejects missing official fields as schema drift", async () => {
    const payload = await loadFixture("schema-drift.json");
    const client = new CodeforcesApiClient({
      fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
      limiter: immediateLimiter()
    });

    await expect(client.getProblemset()).rejects.toMatchObject<Partial<CodeforcesApiError>>({ code: "upstream.schema_changed" });
  });

  test("distinguishes real timeouts from other upstream fetch failures", async () => {
    const unavailable = new CodeforcesApiClient({
      fetchImpl: async () => {
        throw new Error("Durable Object storage failed");
      },
      limiter: immediateLimiter()
    });
    const timeout = new CodeforcesApiClient({
      fetchImpl: async () => {
        throw new DOMException("Timed out", "TimeoutError");
      },
      limiter: immediateLimiter()
    });

    await expect(unavailable.getProblemset()).rejects.toMatchObject({ code: "upstream.unavailable" });
    await expect(timeout.getProblemset()).rejects.toMatchObject({ code: "network.timeout" });
  });
});

function immediateLimiter(): CodeforcesRateLimiter {
  return { schedule: (operation) => operation() } as CodeforcesRateLimiter;
}
