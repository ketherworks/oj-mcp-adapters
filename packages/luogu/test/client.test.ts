import { describe, expect, test } from "vitest";
import { LuoguAdapterError, LuoguPageClient, LuoguRequestCancelledError } from "../src/client.js";
import { loadJsonFixture, loadTextFixture } from "./fixtureLoader.js";

describe("LuoguPageClient fixtures", () => {
  test("uses the audited content-only endpoint without forwarding credentials", async () => {
    const payload = await loadJsonFixture("problem-search-ok.json");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new LuoguPageClient({
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init });
        return jsonResponse(payload);
      }
    });

    const response = await client.searchProblems({ query: "二叉树", page: 2 });
    const url = new URL(calls[0].url);
    const headers = new Headers(calls[0].init?.headers);

    expect(url.origin).toBe("https://www.luogu.com.cn");
    expect(url.pathname).toBe("/problem/list");
    expect(url.searchParams.get("type")).toBe("P");
    expect(url.searchParams.get("keyword")).toBe("二叉树");
    expect(url.searchParams.get("page")).toBe("2");
    expect(headers.get("x-lentille-request")).toBe("content-only");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    expect(calls[0].init).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(response.payload.data.problems.result[0].pid).toBe("P1305");
    expect(response.sourceUrl).toBe(url.toString());
  });

  test("fetches only bounded problem ids from the fixed Luogu origin", async () => {
    const payload = await loadJsonFixture("problem-ok.json");
    const calls: string[] = [];
    const client = new LuoguPageClient({
      fetchImpl: async (input) => {
        calls.push(String(input));
        return jsonResponse(payload);
      }
    });

    await client.fetchProblem("p1305");

    expect(calls).toEqual(["https://www.luogu.com.cn/problem/P1305"]);
    await expect(client.fetchProblem("../../user/1")).rejects.toMatchObject<Partial<LuoguAdapterError>>({ code: "request.invalid" });
  });

  test("classifies a changed fixture as upstream schema drift", async () => {
    const payload = await loadJsonFixture("schema-drift.json");
    const client = new LuoguPageClient({ fetchImpl: async () => jsonResponse(payload) });

    await expect(client.searchProblems({ query: "A+B", page: 1 })).rejects.toMatchObject<Partial<LuoguAdapterError>>({
      code: "upstream.schema_changed"
    });
  });

  test("classifies Luogu verification pages as a challenge without leaking their body", async () => {
    const challenge = await loadTextFixture("challenge.html");
    const client = new LuoguPageClient({
      fetchImpl: async () => new Response(challenge, { status: 403, headers: { "content-type": "text/html" } })
    });

    await expect(client.fetchProblem("P1305")).rejects.toMatchObject<Partial<LuoguAdapterError>>({
      code: "challenge.required",
      httpStatus: 403
    });
  });

  test("does not mistake challenge text inside a valid problem document for an access challenge", async () => {
    const payload = await loadJsonFixture("problem-ok.json");
    const problem = (payload as { data: { problem: { content: { description: string } } } }).data.problem;
    problem.content.description = "This challenge asks for a preorder traversal.";
    const client = new LuoguPageClient({ fetchImpl: async () => jsonResponse(payload) });

    await expect(client.fetchProblem("P1305")).resolves.toMatchObject({
      payload: { data: { problem: { pid: "P1305" } } }
    });
  });

  test("rejects cross-origin response sources and oversized payloads", async () => {
    const payload = await loadJsonFixture("problem-search-ok.json");
    const redirected = jsonResponse(payload);
    Object.defineProperty(redirected, "url", { value: "https://example.test/problem/list" });
    const redirectedClient = new LuoguPageClient({ fetchImpl: async () => redirected });
    const boundedClient = new LuoguPageClient({ fetchImpl: async () => jsonResponse(payload), maxResponseBytes: 32 });

    await expect(redirectedClient.searchProblems({ query: "tree", page: 1 })).rejects.toMatchObject<Partial<LuoguAdapterError>>({
      code: "policy.blocked"
    });
    await expect(boundedClient.searchProblems({ query: "tree", page: 1 })).rejects.toMatchObject<Partial<LuoguAdapterError>>({
      code: "upstream.schema_changed"
    });
  });

  test("cancels an oversized decompressed chunk stream before buffering the full body", async () => {
    const chunk = new TextEncoder().encode("12345678");
    let chunksEnqueued = 0;
    let cancelled = false;
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksEnqueued >= 3) {
          closed = true;
          controller.close();
          return;
        }
        chunksEnqueued += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      }
    });
    const client = new LuoguPageClient({
      fetchImpl: async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json", "content-encoding": "gzip" }
        }),
      maxResponseBytes: 12
    });

    await expect(client.searchProblems({ query: "tree", page: 1 })).rejects.toMatchObject<Partial<LuoguAdapterError>>({
      code: "upstream.schema_changed"
    });
    expect(cancelled).toBe(true);
    expect(closed).toBe(false);
  });

  test("cancels a declared oversized response body without masking the size error", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        throw new Error("upstream cancellation failed");
      }
    });
    const client = new LuoguPageClient({
      fetchImpl: async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "1000" }
        }),
      maxResponseBytes: 12
    });

    await expect(client.searchProblems({ query: "tree", page: 1 })).rejects.toMatchObject<Partial<LuoguAdapterError>>({
      code: "upstream.schema_changed"
    });
    expect(cancelled).toBe(true);
  });

  test("maps rate limits without automatically replaying page requests", async () => {
    let attempts = 0;
    const client = new LuoguPageClient({
      fetchImpl: async () => {
        attempts += 1;
        return new Response("limited", { status: 429, headers: { "retry-after": "3" } });
      }
    });

    await expect(client.searchProblems({ query: "tree", page: 1 })).rejects.toMatchObject<Partial<LuoguAdapterError>>({
      code: "rate_limited",
      retryAfterMs: 3_000
    });
    expect(attempts).toBe(1);
  });

  test("combines caller cancellation with the private request timeout", async () => {
    const controller = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    const client = new LuoguPageClient({
      timeoutMs: 100,
      fetchImpl: async (_input, init) => {
        fetchSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          fetchSignal?.addEventListener(
            "abort",
            () => reject(fetchSignal?.reason ?? new DOMException("Cancelled", "AbortError")),
            { once: true }
          );
        });
      }
    });

    const pending = client.fetchProblem("P1305", { signal: controller.signal });
    controller.abort(new DOMException("Caller cancelled", "AbortError"));

    await expect(pending).rejects.toBeInstanceOf(LuoguRequestCancelledError);
    expect(fetchSignal?.aborted).toBe(true);
  });

  test("aborts an in-flight fetch at the private timeout bound", async () => {
    let fetchSignal: AbortSignal | undefined;
    const client = new LuoguPageClient({
      timeoutMs: 10,
      fetchImpl: async (_input, init) => {
        fetchSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          fetchSignal?.addEventListener("abort", () => reject(fetchSignal?.reason), { once: true });
        });
      }
    });

    await expect(client.fetchProblem("P1305")).rejects.toMatchObject<Partial<LuoguAdapterError>>({ code: "network.timeout" });
    expect(fetchSignal?.aborted).toBe(true);
  });

  test("cancels response streaming when the caller aborts after headers", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => undefined);
      },
      cancel() {
        cancelled = true;
      }
    });
    const client = new LuoguPageClient({
      fetchImpl: async () => new Response(body, { headers: { "content-type": "application/json" } })
    });
    const controller = new AbortController();
    const pending = client.fetchProblem("P1305", { signal: controller.signal });
    await Promise.resolve();
    controller.abort(new DOMException("Caller cancelled", "AbortError"));

    await expect(pending).rejects.toBeInstanceOf(LuoguRequestCancelledError);
    expect(cancelled).toBe(true);
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}
