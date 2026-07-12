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

  test("preserves a Durable Object gateway timeout as network.timeout", async () => {
    const client = new CodeforcesApiClient({
      fetchImpl: async () => new Response("", { status: 504 }),
      limiter: immediateLimiter()
    });

    await expect(client.getProblemset()).rejects.toMatchObject({ code: "network.timeout" });
  });

  test.each([
    { status: 301, location: "http://127.0.0.1/admin" },
    { status: 302, location: "http://localhost/internal" },
    { status: 307, location: "http://169.254.169.254/latest/meta-data" },
    { status: 308, location: "http://[::1]/private" }
  ])("does not follow HTTP $status redirects to $location", async ({ status, location }) => {
    let calls = 0;
    let observedRedirect: RequestRedirect | undefined;
    const client = new CodeforcesApiClient({
      fetchImpl: async (_input, init) => {
        calls += 1;
        observedRedirect = init?.redirect;
        return new Response(null, { status, headers: { Location: location } });
      },
      limiter: immediateLimiter()
    });

    await expect(client.getProblemset()).rejects.toMatchObject({ code: "upstream.unavailable" });
    expect(calls).toBe(1);
    expect(observedRedirect).toBe("manual");
  });

  test("accepts official custom problemset identities without contestId", async () => {
    const client = new CodeforcesApiClient({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            status: "OK",
            result: {
              problems: [
                {
                  problemsetName: "acmsguru",
                  index: "100",
                  name: "A+B",
                  type: "PROGRAMMING",
                  tags: []
                }
              ],
              problemStatistics: [{ index: "100", solvedCount: 1 }]
            }
          })
        ),
      limiter: immediateLimiter()
    });

    await expect(client.getProblemset()).resolves.toMatchObject({
      result: { problems: [{ problemsetName: "acmsguru", index: "100" }] }
    });
  });

  test("rejects problems without an official identity and unknown problem types", async () => {
    const payloads = [
      {
        status: "OK",
        result: {
          problems: [{ index: "A", name: "Missing identity", type: "PROGRAMMING", tags: [] }],
          problemStatistics: []
        }
      },
      {
        status: "OK",
        result: {
          problems: [{ contestId: 1, index: "A", name: "Unknown type", type: "ESSAY", tags: [] }],
          problemStatistics: []
        }
      }
    ];

    for (const payload of payloads) {
      const client = new CodeforcesApiClient({
        fetchImpl: async () => new Response(JSON.stringify(payload)),
        limiter: immediateLimiter()
      });
      await expect(client.getProblemset()).rejects.toMatchObject({ code: "upstream.schema_changed" });
    }
  });

  test("uses a finite timeout signal and preserves caller cancellation", async () => {
    let observedSignal: AbortSignal | undefined;
    const client = new CodeforcesApiClient({
      timeoutMs: 25,
      fetchImpl: async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), { once: true });
        });
      },
      limiter: immediateLimiter()
    });

    await expect(client.getProblemset()).rejects.toMatchObject({ code: "network.timeout" });
    expect(observedSignal).toBeDefined();

    const controller = new AbortController();
    const cancelled = client.getProblemset({ signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "CodeforcesRequestCancelledError" });
  });

  test("cancels an upstream error body without reading it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      }
    });
    const client = new CodeforcesApiClient({
      fetchImpl: async () => new Response(body, { status: 503 }),
      limiter: immediateLimiter()
    });

    await expect(client.getProblemset()).rejects.toMatchObject({ code: "upstream.unavailable" });
    expect(cancelled).toBe(true);
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
