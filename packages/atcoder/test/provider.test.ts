import {
  ojCapabilitiesSchema,
  ojProblemDocumentSchema,
  ojProviderHealthSchema,
  ojSearchResultSchema
} from "@kaiserunix/oj-mcp-contracts";
import { describe, expect, test, vi } from "vitest";
import { AtCoderHtmlClient } from "../src/client.js";
import { AtCoderProvider } from "../src/provider.js";
import { loadHtmlFixture } from "./fixtureLoader.js";

describe("AtCoderProvider", () => {
  test("fetches a canonical URL through the anonymous page adapter and returns the shared document schema", async () => {
    const html = await loadHtmlFixture("abc086-a-en.html");
    const provider = new AtCoderProvider({
      client: new AtCoderHtmlClient({
        fetchImpl: async () => new Response(html, { status: 200, headers: { "Content-Type": "text/html" } })
      }),
      now: () => 25,
      nowIso: () => "2026-07-11T00:00:00.000Z"
    });

    const document = await provider.fetchProblem({
      url: "https://atcoder.jp/contests/abc086/tasks/abc086_a?lang=en"
    });

    expect(document).toMatchObject({ title: "Product", locale: "en", ref: { nativeId: "abc086/abc086_a" } });
    expect(ojProblemDocumentSchema.parse(document)).toEqual(document);
  });

  test("advertises only anonymous read capabilities and explicitly rejects run, auth, and submit workflows", async () => {
    const provider = new AtCoderProvider({ nowIso: () => "2026-07-11T00:00:00.000Z" });

    const capabilities = await provider.getCapabilities("remote_http");

    expect(capabilities.operations).toMatchObject({
      searchProblems: { status: "available", toolName: "oj_search_problems", auth: "none", risk: "R0_public_read" },
      fetchProblem: { status: "available", toolName: "oj_fetch_problem", auth: "none", risk: "R0_public_read" },
      localRun: { status: "unsupported", risk: "R2_local_execute" },
      prepareSubmission: { status: "unsupported", risk: "R3_prepare_write" },
      commitSubmission: { status: "unsupported", risk: "R4_real_submit" }
    });
    expect(Object.values(capabilities.operations).every((operation) => operation.auth === "none")).toBe(true);
    expect(capabilities.source).toMatchObject({ kind: "page_adapter", confidence: "derived" });
    expect(ojCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
  });

  test("reports passive readiness without probing AtCoder from the health operation", async () => {
    let requests = 0;
    const provider = new AtCoderProvider({
      client: new AtCoderHtmlClient({
        fetchImpl: async () => {
          requests += 1;
          return new Response("", { status: 500 });
        }
      }),
      nowIso: () => "2026-07-11T00:00:00.000Z"
    });

    const health = await provider.getHealth();

    expect(requests).toBe(0);
    expect(health).toMatchObject({
      overall: "healthy",
      layers: { transport: "pass", protocol: "pass", schema: "unknown", auth: "not_required", upstream: "pass" }
    });
    expect(health.message).toContain("not yet observed");
    expect(ojProviderHealthSchema.parse(health)).toEqual(health);
  });

  test("reports the latest anonymous rate limit without making another health request", async () => {
    let now = 100;
    let requests = 0;
    const provider = new AtCoderProvider({
      client: new AtCoderHtmlClient({
        fetchImpl: async () => {
          requests += 1;
          now = 140;
          return new Response("slow down", { status: 429, headers: { "Retry-After": "4" } });
        }
      }),
      now: () => now,
      nowIso: () => "2026-07-11T00:00:00.000Z"
    });

    await expect(provider.fetchProblem({ contestId: "abc086", taskId: "abc086_a", locale: "en" })).rejects.toMatchObject({
      code: "rate_limited"
    });
    const health = await provider.getHealth();

    expect(requests).toBe(1);
    expect(health).toMatchObject({
      overall: "degraded",
      latencyMs: 40,
      retryAfterMs: 4_000,
      layers: { schema: "unknown", upstream: "rate_limited" }
    });
  });

  test("reports network timeouts as transport failures", async () => {
    const provider = new AtCoderProvider({
      client: new AtCoderHtmlClient({
        timeoutMs: 1,
        fetchImpl: async (_input, init) =>
          new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))
      }),
      nowIso: () => "2026-07-11T00:00:00.000Z"
    });

    await expect(provider.fetchProblem({ contestId: "abc086", taskId: "abc086_a", locale: "en" })).rejects.toMatchObject({
      code: "network.timeout"
    });
    await expect(provider.getHealth()).resolves.toMatchObject({
      overall: "degraded",
      layers: { transport: "fail", upstream: "timeout" }
    });
  });

  test("does not persist health when all consumers cancel a coalesced read", async () => {
    let request = 0;
    let pendingSignal: AbortSignal | undefined;
    const provider = new AtCoderProvider({
      client: new AtCoderHtmlClient({
        timeoutMs: 10_000,
        fetchImpl: async (_input, init) => {
          request += 1;
          if (request === 1) return new Response("limited", { status: 429 });
          pendingSignal = init?.signal ?? undefined;
          return new Promise((_resolve, reject) =>
            pendingSignal!.addEventListener("abort", () => reject(pendingSignal!.reason), { once: true })
          );
        }
      }),
      nowIso: () => "2026-07-11T00:00:00.000Z"
    });
    await expect(provider.fetchProblem({ contestId: "abc086", taskId: "abc086_a", locale: "en" })).rejects.toMatchObject({
      code: "rate_limited"
    });
    const firstConsumer = new AbortController();
    const secondConsumer = new AbortController();

    const first = provider.fetchProblem(
      { contestId: "abc087", taskId: "abc087_a", locale: "en" },
      firstConsumer.signal
    );
    const second = provider.fetchProblem(
      { contestId: "abc087", taskId: "abc087_a", locale: "en" },
      secondConsumer.signal
    );
    firstConsumer.abort();
    await expect(first).rejects.toMatchObject({ transportCause: "consumer_cancelled" });
    expect(pendingSignal?.aborted).toBe(false);
    secondConsumer.abort();
    await expect(second).rejects.toMatchObject({ transportCause: "consumer_cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(request).toBe(2);
    expect(pendingSignal?.aborted).toBe(true);
    await expect(provider.getHealth()).resolves.toMatchObject({ overall: "degraded", layers: { upstream: "rate_limited" } });
  });

  test("does not overwrite prior health when the sole consumer cancels during digest normalization", async () => {
    const html = await loadHtmlFixture("abc086-a-en.html");
    let request = 0;
    const provider = new AtCoderProvider({
      client: new AtCoderHtmlClient({
        fetchImpl: async () => {
          request += 1;
          return request === 1
            ? new Response("limited", { status: 429 })
            : new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
        }
      }),
      nowIso: () => "2026-07-11T00:00:00.000Z"
    });
    await expect(provider.fetchProblem({ contestId: "abc087", taskId: "abc087_a", locale: "en" })).rejects.toMatchObject({
      code: "rate_limited"
    });

    const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    let digestStarted!: () => void;
    let releaseDigest!: () => void;
    const started = new Promise<void>((resolve) => {
      digestStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseDigest = resolve;
    });
    const digestSpy = vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      digestStarted();
      await gate;
      return originalDigest(algorithm, data);
    });

    try {
      const consumer = new AbortController();
      const pending = provider.fetchProblem(
        { contestId: "abc086", taskId: "abc086_a", locale: "en" },
        consumer.signal
      );
      await started;
      consumer.abort();
      await expect(pending).rejects.toMatchObject({ transportCause: "consumer_cancelled" });

      releaseDigest();
      await vi.waitFor(() => expect(digestSpy).toHaveBeenCalledTimes(4));
      await Promise.all(digestSpy.mock.results.map((result) => result.value));
      await new Promise((resolve) => setTimeout(resolve, 0));

      await expect(provider.getHealth()).resolves.toMatchObject({
        overall: "degraded",
        layers: { upstream: "rate_limited" }
      });
    } finally {
      digestSpy.mockRestore();
      releaseDigest();
    }
  });

  test("does not let normal not-found reads overwrite prior upstream health", async () => {
    let request = 0;
    const provider = new AtCoderProvider({
      client: new AtCoderHtmlClient({
        fetchImpl: async () => {
          request += 1;
          return request === 1
            ? new Response("limited", { status: 429 })
            : new Response("missing", { status: 404 });
        }
      }),
      nowIso: () => "2026-07-11T00:00:00.000Z"
    });

    await expect(provider.fetchProblem({ contestId: "abc086", taskId: "abc086_a", locale: "en" })).rejects.toMatchObject({
      code: "rate_limited"
    });
    await expect(provider.fetchProblem({ contestId: "abc999", taskId: "abc999_z", locale: "en" })).rejects.toMatchObject({
      code: "resource.not_found"
    });
    await expect(provider.getHealth()).resolves.toMatchObject({ overall: "degraded", layers: { upstream: "rate_limited" } });
  });

  test("keeps health ordered by request admission under concurrent completion", async () => {
    const html = await loadHtmlFixture("abc086-a-en.html");
    let releaseFirst!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    const provider = new AtCoderProvider({
      client: new AtCoderHtmlClient({
        fetchImpl: async (input) => (String(input).includes("abc086_a") ? first : new Response("limited", { status: 429 }))
      }),
      nowIso: () => "2026-07-11T00:00:00.000Z"
    });

    const older = provider.fetchProblem({ contestId: "abc086", taskId: "abc086_a", locale: "en" });
    await expect(provider.fetchProblem({ contestId: "abc087", taskId: "abc087_a", locale: "en" })).rejects.toMatchObject({
      code: "rate_limited"
    });
    releaseFirst(new Response(html, { status: 200, headers: { "Content-Type": "text/html" } }));
    await older;

    await expect(provider.getHealth()).resolves.toMatchObject({ overall: "degraded", layers: { upstream: "rate_limited" } });
  });

  test("resolves an exact contest/task id to one shared problem summary", async () => {
    const html = await loadHtmlFixture("abc086-a-en.html");
    const provider = new AtCoderProvider({
      client: new AtCoderHtmlClient({
        fetchImpl: async () => new Response(html, { status: 200, headers: { "Content-Type": "text/html" } })
      }),
      nowIso: () => "2026-07-11T00:00:00.000Z"
    });

    const result = await provider.search({
      schemaVersion: "oj.search-request/v1",
      requestId: "search-1",
      platform: "atcoder",
      query: "abc086/abc086_a",
      locale: "en",
      limit: 10
    });

    expect(result).toMatchObject({
      requestId: "search-1",
      items: [{ title: "Product", contestLabel: "abc086", ref: { nativeId: "abc086/abc086_a" } }]
    });
    expect(ojSearchResultSchema.parse(result)).toEqual(result);
  });

  test("preserves the locale from an exact canonical URL when search does not explicitly supply one", async () => {
    const html = await loadHtmlFixture("arc065-a-ja.html");
    let requestedUrl = "";
    const provider = new AtCoderProvider({
      client: new AtCoderHtmlClient({
        fetchImpl: async (input) => {
          requestedUrl = String(input);
          return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
        }
      }),
      nowIso: () => "2026-07-11T00:00:00.000Z"
    });

    const result = await provider.search({
      schemaVersion: "oj.search-request/v1",
      requestId: "search-ja-url",
      platform: "atcoder",
      query: "https://atcoder.jp/contests/arc065/tasks/arc065_a?lang=ja",
      limit: 10
    });

    expect(requestedUrl).toBe("https://atcoder.jp/contests/arc065/tasks/arc065_a?lang=ja");
    expect(result).toMatchObject({
      items: [{ title: "白昼夢", source: { sourceUrl: "https://atcoder.jp/contests/arc065/tasks/arc065_a?lang=ja" } }]
    });
  });

  test("lets an explicit search locale override the canonical URL locale", async () => {
    const html = await loadHtmlFixture("abc086-a-en.html");
    let requestedUrl = "";
    const provider = new AtCoderProvider({
      client: new AtCoderHtmlClient({
        fetchImpl: async (input) => {
          requestedUrl = String(input);
          return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
        }
      }),
      nowIso: () => "2026-07-11T00:00:00.000Z"
    });

    await provider.search({
      schemaVersion: "oj.search-request/v1",
      requestId: "search-explicit-en",
      platform: "atcoder",
      query: "https://atcoder.jp/contests/abc086/tasks/abc086_a?lang=ja",
      locale: "en",
      limit: 10
    });

    expect(requestedUrl).toBe("https://atcoder.jp/contests/abc086/tasks/abc086_a?lang=en");
  });

  test("rejects free-text search without crawling AtCoder", async () => {
    let requests = 0;
    const provider = new AtCoderProvider({
      client: new AtCoderHtmlClient({
        fetchImpl: async () => {
          requests += 1;
          return new Response("", { status: 500 });
        }
      })
    });

    await expect(
      provider.search({
        schemaVersion: "oj.search-request/v1",
        requestId: "search-free-text",
        platform: "atcoder",
        query: "Product",
        limit: 10
      })
    ).rejects.toMatchObject({ code: "request.invalid" });
    expect(requests).toBe(0);
  });
});
