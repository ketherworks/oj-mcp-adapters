import { ojCapabilitiesSchema, ojProblemDocumentSchema, ojProviderHealthSchema, ojSearchResultSchema } from "@kaiserunix/oj-mcp-contracts";
import { describe, expect, test } from "vitest";
import { LuoguAdapterError, LuoguPageClient, LuoguRequestCancelledError, type LuoguPageReader } from "../src/client.js";
import { LuoguProvider } from "../src/provider.js";
import { loadJsonFixture } from "./fixtureLoader.js";

describe("LuoguProvider", () => {
  test("paginates fixture search results with a bounded opaque cursor", async () => {
    const payload = await loadJsonFixture("problem-search-ok.json");
    const reader = fixtureReader(payload, await loadJsonFixture("problem-ok.json"));
    const provider = new LuoguProvider({ reader, nowIso: fixedNow, transport: "local_stdio" });

    const first = await provider.search({
      schemaVersion: "oj.search-request/v1",
      requestId: "search-1",
      platform: "luogu",
      query: "tree",
      limit: 2
    });
    const second = await provider.search({
      schemaVersion: "oj.search-request/v1",
      requestId: "search-2",
      platform: "luogu",
      query: "tree",
      cursor: first.nextCursor,
      limit: 2
    });

    expect(() => ojSearchResultSchema.parse(first)).not.toThrow();
    expect(first.items.map((item) => item.ref.nativeId)).toEqual(["P1305", "P4913"]);
    expect(first.nextCursor).toBe("v1:1:2:3");
    expect(second.items.map((item) => item.ref.nativeId)).toEqual(["B3642"]);
    expect(second.nextCursor).toBe("v1:2:0:3");
  });

  test("reports only anonymous public reads as available", async () => {
    const provider = new LuoguProvider({ reader: fixtureReader({}, {}), nowIso: fixedNow, transport: "remote_http" });
    const capabilities = await provider.getCapabilities();

    expect(() => ojCapabilitiesSchema.parse(capabilities)).not.toThrow();
    expect(capabilities.operations.searchProblems).toMatchObject({
      status: "available",
      toolName: "oj_search_problems",
      transport: "remote_http",
      auth: "none",
      risk: "R0_public_read"
    });
    expect(capabilities.operations.fetchProblem.status).toBe("available");
    expect(capabilities.operations.fetchProfile.status).toBe("disabled_by_policy");
    expect(capabilities.operations.localRun.status).toBe("unsupported");
    expect(capabilities.operations.commitSubmission.status).toBe("disabled_by_policy");
    expect(capabilities.operations.fetchProfile.auth).toBe("none");
    expect(capabilities.operations.listSubmissions).toMatchObject({
      status: "disabled_by_policy",
      auth: "session_cookie"
    });
    expect(capabilities.operations.listSubmissions.reason).toContain("auth_required");
    expect(capabilities.operations.platformRun.auth).toBe("session_cookie");
    expect(capabilities.operations.commitSubmission.auth).toBe("session_cookie");
  });

  test("fetches a fixture through the provider into a shared problem document", async () => {
    const problemPayload = await loadJsonFixture("problem-ok.json");
    const provider = new LuoguProvider({ reader: fixtureReader({}, problemPayload), nowIso: fixedNow });

    const document = await provider.fetchProblem({ nativeId: "p1305", maxContentChars: 500 });

    expect(() => ojProblemDocumentSchema.parse(document)).not.toThrow();
    expect(document).toMatchObject({
      schemaVersion: "oj.problem-document/v1",
      title: "新二叉树",
      ref: { nativeId: "P1305", platform: "luogu" },
      source: { kind: "page_adapter", rawRef: "P1305" }
    });
    expect(document.samples).toHaveLength(2);
  });

  test("returns an empty shared result when Luogu has no matches", async () => {
    const reader = fixtureReader({ data: { problems: { count: 0, result: [] } } }, {});
    const provider = new LuoguProvider({ reader, nowIso: fixedNow });

    const result = await provider.search({
      schemaVersion: "oj.search-request/v1",
      requestId: "search-empty",
      platform: "luogu",
      query: "no such problem",
      limit: 10
    });

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  test("classifies a nonzero upstream count with an empty page as schema drift", async () => {
    const reader = fixtureReader({ data: { problems: { count: 1, result: [] } } }, {});
    const provider = new LuoguProvider({ reader, nowIso: fixedNow });

    await expect(
      provider.search({
        schemaVersion: "oj.search-request/v1",
        requestId: "search-inconsistent-count",
        platform: "luogu",
        query: "tree",
        limit: 10
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test.each(["v1:1:0:50", "v1:1:1:50"])(
    "classifies an in-range empty cursor page as drift before offset validation (%s)",
    async (cursor) => {
      const reader = fixtureReader({ data: { problems: { count: 100, result: [] } } }, {});
      const provider = new LuoguProvider({ reader, nowIso: fixedNow });

      await expect(
        provider.search({
          schemaVersion: "oj.search-request/v1",
          requestId: "search-empty-cursor-page",
          platform: "luogu",
          query: "tree",
          cursor,
          limit: 10
        })
      ).rejects.toMatchObject({ code: "upstream.schema_changed" });
    }
  );

  test("accepts the documented maximum page in a search cursor", async () => {
    const fixture = (await loadJsonFixture("problem-search-ok.json")) as {
      data: { problems: { count: number; result: unknown[] } };
    };
    const payload = { data: { problems: { ...fixture.data.problems, count: 30_000 } } };
    const pages: number[] = [];
    const reader: LuoguPageReader = {
      searchProblems: async ({ query, page }) => {
        pages.push(page);
        return {
          payload,
          sourceUrl: `https://www.luogu.com.cn/problem/list?type=P&keyword=${encodeURIComponent(query)}&page=${page}`
        };
      },
      fetchProblem: async () => {
        throw new Error("not used");
      }
    };
    const provider = new LuoguProvider({ reader, nowIso: fixedNow });

    const result = await provider.search({
      schemaVersion: "oj.search-request/v1",
      requestId: "search-page-10000",
      platform: "luogu",
      query: "tree",
      cursor: "v1:10000:0:3",
      limit: 2
    });

    expect(pages).toEqual([10_000]);
    expect(result.nextCursor).toBe("v1:10000:2:3");
  });

  test("classifies a cursor page starting at or beyond total as request.invalid without poisoning health", async () => {
    const healthyPayload = await loadJsonFixture("problem-search-ok.json");
    const reader: LuoguPageReader = {
      searchProblems: async ({ query, page }) => ({
        payload: page === 1 ? healthyPayload : { data: { problems: { count: 1, result: [] } } },
        sourceUrl: `https://www.luogu.com.cn/problem/list?type=P&keyword=${encodeURIComponent(query)}&page=${page}`
      }),
      fetchProblem: async () => {
        throw new LuoguAdapterError("resource.not_found", "missing fixture");
      }
    };
    const provider = new LuoguProvider({ reader, nowIso: fixedNow });
    await provider.search({
      schemaVersion: "oj.search-request/v1",
      requestId: "healthy-before-invalid-cursor",
      platform: "luogu",
      query: "tree",
      limit: 2
    });

    await expect(
      provider.search({
        schemaVersion: "oj.search-request/v1",
        requestId: "out-of-range-cursor",
        platform: "luogu",
        query: "tree",
        cursor: "v1:2:0:50",
        limit: 10
      })
    ).rejects.toMatchObject({ code: "request.invalid" });
    expect((await provider.getHealth()).overall).toBe("healthy");

    await expect(provider.fetchProblem({ nativeId: "P9999", maxContentChars: 500 })).rejects.toMatchObject({
      code: "resource.not_found"
    });
    expect((await provider.getHealth()).overall).toBe("healthy");
  });

  test("keeps the newest started read as health truth when concurrent reads finish out of order", async () => {
    const payload = await loadJsonFixture("problem-search-ok.json");
    let firstReject: ((error: unknown) => void) | undefined;
    let firstStartedResolve: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedResolve = resolve;
    });
    let calls = 0;
    const reader: LuoguPageReader = {
      searchProblems: async ({ query, page }) => {
        calls += 1;
        if (calls === 1) {
          firstStartedResolve?.();
          return new Promise((_resolve, reject) => {
            firstReject = reject;
          });
        }
        return {
          payload,
          sourceUrl: `https://www.luogu.com.cn/problem/list?type=P&keyword=${encodeURIComponent(query)}&page=${page}`
        };
      },
      fetchProblem: async () => {
        throw new Error("not used");
      }
    };
    const provider = new LuoguProvider({ reader, nowIso: fixedNow });
    const older = provider
      .search({
        schemaVersion: "oj.search-request/v1",
        requestId: "older-read",
        platform: "luogu",
        query: "tree",
        limit: 2
      })
      .catch((error: unknown) => error);
    await firstStarted;
    await provider.search({
      schemaVersion: "oj.search-request/v1",
      requestId: "newer-read",
      platform: "luogu",
      query: "tree",
      limit: 2
    });
    firstReject?.(new LuoguAdapterError("upstream.unavailable", "older failure"));
    await older;

    expect((await provider.getHealth()).overall).toBe("healthy");
  });

  test("keeps health unchanged when the caller cancels an in-flight problem fetch", async () => {
    const payload = await loadJsonFixture("problem-ok.json");
    let calls = 0;
    const client = new LuoguPageClient({
      fetchImpl: async (_input, init) => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
        }
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    });
    const provider = new LuoguProvider({ reader: client, nowIso: fixedNow });
    await provider.fetchProblem({ nativeId: "P1305", maxContentChars: 500 });
    const healthBefore = await provider.getHealth();
    const controller = new AbortController();
    const pending = provider.fetchProblem(
      { nativeId: "P1305", maxContentChars: 500 },
      { signal: controller.signal }
    );
    controller.abort(new DOMException("Caller cancelled", "AbortError"));

    await expect(pending).rejects.toBeInstanceOf(LuoguRequestCancelledError);
    expect(await provider.getHealth()).toEqual(healthBefore);
  });

  test("preserves caller cancellation distinctly when a reader rejects with the signal reason", async () => {
    const payload = await loadJsonFixture("problem-ok.json");
    let calls = 0;
    const reader: LuoguPageReader = {
      searchProblems: async () => {
        throw new Error("not used");
      },
      fetchProblem: async (_nativeId, options) => {
        calls += 1;
        if (calls === 1) {
          return { payload, sourceUrl: "https://www.luogu.com.cn/problem/P1305" };
        }
        const signal = options?.signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    };
    const provider = new LuoguProvider({ reader, nowIso: fixedNow });
    await provider.fetchProblem({ nativeId: "P1305", maxContentChars: 500 });
    const healthBefore = await provider.getHealth();
    const controller = new AbortController();
    const pending = provider.fetchProblem(
      { nativeId: "P1305", maxContentChars: 500 },
      { signal: controller.signal }
    );
    controller.abort(new DOMException("Caller cancelled", "AbortError"));

    await expect(pending).rejects.toBeInstanceOf(LuoguRequestCancelledError);
    expect(await provider.getHealth()).toEqual(healthBefore);
  });

  test("keeps health unchanged when the caller cancels problem body streaming", async () => {
    const payload = await loadJsonFixture("problem-ok.json");
    let calls = 0;
    let bodyCancelled = false;
    const client = new LuoguPageClient({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
        }
        const body = new ReadableStream<Uint8Array>({
          pull() {
            return new Promise(() => undefined);
          },
          cancel() {
            bodyCancelled = true;
          }
        });
        return new Response(body, { headers: { "content-type": "application/json" } });
      }
    });
    const provider = new LuoguProvider({ reader: client, nowIso: fixedNow });
    await provider.fetchProblem({ nativeId: "P1305", maxContentChars: 500 });
    const healthBefore = await provider.getHealth();
    const controller = new AbortController();
    const pending = provider.fetchProblem(
      { nativeId: "P1305", maxContentChars: 500 },
      { signal: controller.signal }
    );
    await Promise.resolve();
    controller.abort(new DOMException("Caller cancelled", "AbortError"));

    await expect(pending).rejects.toBeInstanceOf(LuoguRequestCancelledError);
    expect(bodyCancelled).toBe(true);
    expect(await provider.getHealth()).toEqual(healthBefore);
  });

  test("degrades health when the private timeout aborts an upstream fetch", async () => {
    const payload = await loadJsonFixture("problem-ok.json");
    let calls = 0;
    const client = new LuoguPageClient({
      timeoutMs: 10,
      fetchImpl: async (_input, init) => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
        }
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    });
    const provider = new LuoguProvider({ reader: client, nowIso: fixedNow });
    await provider.fetchProblem({ nativeId: "P1305", maxContentChars: 500 });

    await expect(provider.fetchProblem({ nativeId: "P1305", maxContentChars: 500 })).rejects.toMatchObject({
      code: "network.timeout"
    });
    expect(await provider.getHealth()).toMatchObject({
      overall: "degraded",
      layers: { upstream: "timeout" }
    });
  });

  test("surfaces drift in health after a failed read", async () => {
    const reader: LuoguPageReader = {
      searchProblems: async () => {
        throw new LuoguAdapterError("upstream.schema_changed", "fixture drift");
      },
      fetchProblem: async () => {
        throw new Error("not used");
      }
    };
    const provider = new LuoguProvider({ reader, nowIso: fixedNow });

    await expect(
      provider.search({
        schemaVersion: "oj.search-request/v1",
        requestId: "search-drift",
        platform: "luogu",
        query: "tree",
        limit: 10
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
    const health = await provider.getHealth();

    expect(() => ojProviderHealthSchema.parse(health)).not.toThrow();
    expect(health).toMatchObject({ overall: "degraded", layers: { schema: "drift", upstream: "fail" } });
  });

  test("rejects forged or unbounded cursors", async () => {
    const provider = new LuoguProvider({ reader: fixtureReader({}, {}) });

    await expect(
      provider.search({
        schemaVersion: "oj.search-request/v1",
        requestId: "bad-cursor",
        platform: "luogu",
        query: "tree",
        cursor: "../../page/999999",
        limit: 10
      })
    ).rejects.toMatchObject({ code: "request.invalid" });
  });
});

function fixtureReader(searchPayload: unknown, problemPayload: unknown): LuoguPageReader {
  return {
    searchProblems: async ({ query, page }) => ({
      payload: searchPayload,
      sourceUrl: `https://www.luogu.com.cn/problem/list?type=P&keyword=${encodeURIComponent(query)}&page=${page}`
    }),
    fetchProblem: async (nativeId) => ({
      payload: problemPayload,
      sourceUrl: `https://www.luogu.com.cn/problem/${nativeId}`
    })
  };
}

function fixedNow(): string {
  return "2026-07-11T08:00:00.000Z";
}
