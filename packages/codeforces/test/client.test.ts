import { describe, expect, test } from "vitest";
import { CodeforcesApiClient, CodeforcesApiError } from "../src/client.js";
import type { CodeforcesRateLimiter } from "../src/rateLimiter.js";
import { loadFixture } from "./fixtureLoader.js";

describe("CodeforcesApiClient", () => {
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
});

function immediateLimiter(): CodeforcesRateLimiter {
  return { schedule: (operation) => operation() } as CodeforcesRateLimiter;
}
