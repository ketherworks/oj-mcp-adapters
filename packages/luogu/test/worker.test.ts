import { ojErrorSchema, ojProblemDocumentSchema } from "@kaiserunix/oj-mcp-contracts";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LUOGU_MCP_TOOL_NAMES } from "../src/server.js";
import worker, { createLuoguWorker } from "../src/worker.js";
import { loadJsonFixture } from "./fixtureLoader.js";

describe("Luogu Cloudflare Worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("publishes an anonymous stateless health document", async () => {
    const response = await worker.fetch(new Request("https://example.com/healthz"), {});
    const body = (await response.json()) as {
      authentication: string;
      state: string;
      cookies: string;
      mcpEndpoint: string;
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      authentication: "none",
      state: "stateless",
      cookies: "never accepted or forwarded",
      mcpEndpoint: "/mcp"
    });
  });

  test("lists only the four public read tools over stateless Streamable HTTP", async () => {
    const response = await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }), {});
    const body = await parseMcpResponse<{ tools: ListedTool[] }>(response);
    const tools = body.result.tools;

    expect(response.status).toBe(200);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...LUOGU_MCP_TOOL_NAMES].sort());
    expect(tools.some((tool) => /profile|private|cookie|run|submit/i.test(tool.name))).toBe(false);
  });

  test("rejects browser origins unless explicitly allowlisted", async () => {
    const denied = await worker.fetch(mcpRequest({}, { origin: "https://evil.example" }), {});
    const allowed = await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { origin: "https://app.example" }), {
      LUOGU_MCP_ALLOWED_ORIGINS: "https://app.example"
    });

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example");
  });

  test("rejects cookies on the anonymous remote endpoint", async () => {
    const response = await worker.fetch(mcpRequest({}, { cookie: "session=secret" }), {});
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("credentials");
  });

  test("fetches a fixture end to end through the Worker MCP endpoint", async () => {
    const payload = await loadJsonFixture("problem-ok.json");
    const upstreamCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        upstreamCalls.push(String(input));
        return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch
    );
    const response = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "oj_fetch_problem", arguments: { nativeId: "P1305", maxContentChars: 500 } }
      }),
      {}
    );
    const body = await parseMcpResponse<{ structuredContent?: unknown; isError?: boolean }>(response);

    expect(response.status).toBe(200);
    expect(body.result.isError).not.toBe(true);
    expect(ojProblemDocumentSchema.safeParse(body.result.structuredContent).success).toBe(true);
    expect(body.result.structuredContent).toMatchObject({ title: "新二叉树", ref: { nativeId: "P1305" } });
    expect(upstreamCalls).toEqual(["https://www.luogu.com.cn/problem/P1305"]);
  });

  test("rejects declared oversized bodies and preserves 413 when cancellation fails", async () => {
    let cancelled = false;
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks >= 2) {
          controller.close();
          return;
        }
        chunks += 1;
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        cancelled = true;
        throw new Error("cancel failed");
      }
    });
    const response = await worker.fetch(
      streamingMcpRequest(body, { "content-length": "1000000" }),
      {}
    );
    const error = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(error.error.message).toContain("too large");
  });

  test("does not hold request admission when oversized-body cancellation never settles", async () => {
    let cancelStarted = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelStarted = true;
        return new Promise<void>(() => undefined);
      }
    });
    const boundedWorker = createLuoguWorker({ maxConcurrentRequests: 1, maxQueuedRequests: 0 });

    const rejected = await settleWithin(
      boundedWorker.fetch(streamingMcpRequest(body, { "content-length": "1000000" }), {}),
      100
    );
    await rejected.text();
    const admitted = await settleWithin(
      boundedWorker.fetch(mcpRequest({ jsonrpc: "2.0", id: 65, method: "tools/list" }), {}),
      100
    );

    expect(cancelStarted).toBe(true);
    expect(rejected.status).toBe(413);
    expect(admitted.status).toBe(200);
  });

  test("cancels chunked bodies that cross the inbound byte cap before full buffering", async () => {
    const chunk = new Uint8Array(32 * 1024).fill(120);
    let chunks = 0;
    let cancelled = false;
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks >= 4) {
          closed = true;
          controller.close();
          return;
        }
        chunks += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      }
    });
    const response = await worker.fetch(streamingMcpRequest(body), {});

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(closed).toBe(false);
  });

  test("returns a bounded 400 JSON-RPC error for malformed JSON", async () => {
    const response = await worker.fetch(rawMcpRequest("{not-json"), {});
    const error = (await response.json()) as { error: { code: number; message: string } };

    expect(response.status).toBe(400);
    expect(error.error).toMatchObject({ code: -32700, message: "Malformed JSON request body." });
  });

  test("maps a tools/call request missing its SDK-required name to shared structured error", async () => {
    const response = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { arguments: {} } }),
      {}
    );
    const body = await parseMcpResponse<{ structuredContent?: unknown; isError?: boolean }>(response);

    expect(response.status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(ojErrorSchema.safeParse(body.result.structuredContent).success).toBe(true);
    expect(body.result.structuredContent).toMatchObject({ code: "request.invalid", layer: "broker" });
  });

  test("rejects every JSON-RPC batch before SDK dispatch", async () => {
    const batch = [{ jsonrpc: "2.0", id: 31, method: "tools/list" }];
    const response = await worker.fetch(rawMcpRequest(JSON.stringify(batch)), {});
    const error = (await response.json()) as { error: { code: number; message: string } };

    expect(response.status).toBe(400);
    expect(error.error.code).toBe(-32600);
    expect(error.error.message).toContain("batch");
  });

  test("cancels and unlocks an inbound body when the HTTP request is aborted", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      }
    });
    const request = streamingMcpRequest(body, {}, controller.signal);
    const pending = worker.fetch(request, {});

    await Promise.resolve();
    controller.abort(new DOMException("client disconnected", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("times out, cancels, and unlocks a stalled inbound body", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        }
      });
      const boundedWorker = createLuoguWorker({ ingressTimeoutMs: 25 });
      const pending = boundedWorker.fetch(streamingMcpRequest(body), {});

      await vi.advanceTimersByTimeAsync(25);
      const response = await pending;
      const error = (await response.json()) as { error: { data?: unknown; message: string } };

      expect(response.status).toBe(408);
      expect(error.error.message).toContain("timed out");
      expect(ojErrorSchema.safeParse(error.error.data).success).toBe(true);
      expect(error.error.data).toMatchObject({ code: "network.timeout", retryPolicy: "safe_read" });
      expect(cancelled).toBe(true);
      expect(body.locked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds concurrent Worker requests, queues one, and releases admission on cancellation", async () => {
    const boundedWorker = createLuoguWorker({
      ingressTimeoutMs: 1_000,
      maxConcurrentRequests: 1,
      maxQueuedRequests: 1,
      requestQueueTimeoutMs: 1_000
    });
    const firstController = new AbortController();
    let firstCancelled = false;
    const firstBody = new ReadableStream<Uint8Array>({
      cancel() {
        firstCancelled = true;
      }
    });
    const first = boundedWorker.fetch(streamingMcpRequest(firstBody, {}, firstController.signal), {});
    await Promise.resolve();
    const queued = boundedWorker.fetch(mcpRequest({ jsonrpc: "2.0", id: 60, method: "tools/list" }), {});
    await Promise.resolve();

    const overloaded = await boundedWorker.fetch(mcpRequest({ jsonrpc: "2.0", id: 61, method: "tools/list" }), {});
    const overloadedBody = (await overloaded.json()) as { error: { data?: unknown } };

    expect(overloaded.status).toBe(503);
    expect(ojErrorSchema.safeParse(overloadedBody.error.data).success).toBe(true);
    expect(overloadedBody.error.data).toMatchObject({ code: "rate_limited", retryPolicy: "safe_read" });

    firstController.abort(new DOMException("release request admission", "AbortError"));
    await first.catch(() => undefined);
    const queuedResponse = await queued;

    expect(firstCancelled).toBe(true);
    expect(firstBody.locked).toBe(false);
    expect(queuedResponse.status).toBe(200);
  });

  test("holds request admission through a full-body slow tool response stream", async () => {
    const payload = await loadJsonFixture("problem-ok.json");
    const calls: Array<{ resolve: (response: Response) => void }> = [];
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Promise<Response>((resolve) => {
          calls.push({ resolve });
        })) as typeof fetch
    );
    const boundedWorker = createLuoguWorker({
      maxConcurrentRequests: 1,
      maxQueuedRequests: 0,
      maxConcurrentUpstream: 2,
      maxQueuedUpstream: 0
    });
    const firstPending = boundedWorker.fetch(fetchProblemRequest(62), {});
    await waitFor(() => calls.length === 1);

    const secondResponse = await boundedWorker.fetch(fetchProblemRequest(63), {});
    const upstreamCallsBeforeRelease = calls.length;
    for (const call of calls) {
      call.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
    }
    const firstResponse = await firstPending;
    await parseMcpResponse(firstResponse);
    if (secondResponse.status === 200) await parseMcpResponse(secondResponse);

    expect(secondResponse.status).toBe(503);
    expect(upstreamCallsBeforeRelease).toBe(1);
  });

  test("bounds upstream concurrency, queues one call, and releases the slot when the active call is cancelled", async () => {
    const payload = await loadJsonFixture("problem-ok.json");
    const calls: Array<{ signal?: AbortSignal; resolve: (response: Response) => void }> = [];
    vi.stubGlobal(
      "fetch",
      (async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal ?? undefined;
          calls.push({ signal, resolve });
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        })) as typeof fetch
    );
    const boundedWorker = createLuoguWorker({
      maxConcurrentRequests: 4,
      maxQueuedRequests: 4,
      maxConcurrentUpstream: 1,
      maxQueuedUpstream: 1,
      upstreamQueueTimeoutMs: 1_000
    });
    const firstController = new AbortController();
    const first = boundedWorker.fetch(fetchProblemRequest(70, firstController.signal), {});
    await waitFor(() => calls.length === 1);
    const queued = boundedWorker.fetch(fetchProblemRequest(71), {});
    await Promise.resolve();
    const overloadedResponse = await boundedWorker.fetch(fetchProblemRequest(72), {});
    const overloaded = await parseMcpResponse<{ structuredContent?: unknown; isError?: boolean }>(overloadedResponse);

    expect(calls).toHaveLength(1);
    expect(overloaded.result.isError).toBe(true);
    expect(ojErrorSchema.safeParse(overloaded.result.structuredContent).success).toBe(true);
    expect(overloaded.result.structuredContent).toMatchObject({ code: "rate_limited", retryPolicy: "safe_read" });

    firstController.abort(new DOMException("release upstream admission", "AbortError"));
    await first.catch(() => undefined);
    await waitFor(() => calls.length === 2);
    calls[1]!.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
    const queuedResult = await parseMcpResponse<{ isError?: boolean }>(await queued);

    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(queuedResult.result.isError).not.toBe(true);
  });

  test("maps a full local upstream queue to broker overload without changing provider health", async () => {
    const payload = await loadJsonFixture("problem-ok.json");
    let calls = 0;
    let releaseActive!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Promise<Response>((resolve) => {
          releaseActive = resolve;
        });
      }) as typeof fetch
    );
    const boundedWorker = createLuoguWorker({
      maxConcurrentRequests: 4,
      maxQueuedRequests: 4,
      maxConcurrentUpstream: 1,
      maxQueuedUpstream: 0
    });
    await parseMcpResponse(await boundedWorker.fetch(fetchProblemRequest(80), {}));
    const activePending = boundedWorker.fetch(fetchProblemRequest(81), {});
    await waitFor(() => calls === 2);

    const overloaded = await parseMcpResponse<{ structuredContent?: unknown; isError?: boolean }>(
      await boundedWorker.fetch(fetchProblemRequest(82), {})
    );
    const health = await readWorkerHealth(boundedWorker, 83);
    releaseActive(new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
    await parseMcpResponse(await activePending);

    expect(overloaded.result).toMatchObject({
      isError: true,
      structuredContent: { code: "rate_limited", layer: "broker", retryPolicy: "safe_read", userAction: "retry" }
    });
    expect(health).toMatchObject({ overall: "healthy", layers: { upstream: "pass" } });
    expect(calls).toBe(2);
  });

  test("maps a local upstream queue timeout to broker overload without changing provider health", async () => {
    const payload = await loadJsonFixture("problem-ok.json");
    let calls = 0;
    let releaseActive!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Promise<Response>((resolve) => {
          releaseActive = resolve;
        });
      }) as typeof fetch
    );
    const boundedWorker = createLuoguWorker({
      maxConcurrentRequests: 4,
      maxQueuedRequests: 4,
      maxConcurrentUpstream: 1,
      maxQueuedUpstream: 1,
      upstreamQueueTimeoutMs: 20
    });
    await parseMcpResponse(await boundedWorker.fetch(fetchProblemRequest(84), {}));
    const activePending = boundedWorker.fetch(fetchProblemRequest(85), {});
    await waitFor(() => calls === 2);

    const timedOut = await parseMcpResponse<{ structuredContent?: unknown; isError?: boolean }>(
      await boundedWorker.fetch(fetchProblemRequest(86), {})
    );
    const health = await readWorkerHealth(boundedWorker, 87);
    releaseActive(new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
    await parseMcpResponse(await activePending);

    expect(timedOut.result).toMatchObject({
      isError: true,
      structuredContent: { code: "rate_limited", layer: "broker", retryPolicy: "safe_read", userAction: "retry" }
    });
    expect(health).toMatchObject({ overall: "healthy", layers: { upstream: "pass" } });
    expect(calls).toBe(2);
  });

  test("persists the latest bounded health observation across Worker requests", async () => {
    const payload = await loadJsonFixture("problem-ok.json");
    vi.stubGlobal(
      "fetch",
      (async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch
    );
    const establishedResponse = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 40,
        method: "tools/call",
        params: { name: "oj_fetch_problem", arguments: { nativeId: "P1305", maxContentChars: 500 } }
      }),
      {}
    );
    const established = await parseMcpResponse<{ isError?: boolean }>(establishedResponse);
    expect(established.result.isError).not.toBe(true);
    const healthResponse = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "oj_health", arguments: {} } }),
      {}
    );
    const health = await parseMcpResponse<{ structuredContent?: { overall?: string } }>(healthResponse);

    expect(health.result.structuredContent?.overall).toBe("healthy");
  });

  test("aborts upstream on same-request HTTP cancellation without changing shared health", async () => {
    const payload = await loadJsonFixture("problem-ok.json");
    let upstreamCalls = 0;
    let upstreamSignal: AbortSignal | undefined;
    let blockedStartedResolve: (() => void) | undefined;
    const blockedStarted = new Promise<void>((resolve) => {
      blockedStartedResolve = resolve;
    });
    vi.stubGlobal(
      "fetch",
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        upstreamCalls += 1;
        if (upstreamCalls === 1) {
          return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
        }
        upstreamSignal = init?.signal ?? undefined;
        blockedStartedResolve?.();
        return new Promise<Response>((_resolve, reject) => {
          const cleanup = setTimeout(() => reject(new Error("blocked fetch cleanup")), 100);
          upstreamSignal?.addEventListener(
            "abort",
            () => {
              clearTimeout(cleanup);
              reject(upstreamSignal?.reason);
            },
            { once: true }
          );
        });
      }) as typeof fetch
    );
    const establishedResponse = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 50,
        method: "tools/call",
        params: { name: "oj_fetch_problem", arguments: { nativeId: "P1305", maxContentChars: 500 } }
      }),
      {}
    );
    const established = await parseMcpResponse<{ isError?: boolean }>(establishedResponse);
    expect(established.result.isError).not.toBe(true);
    const beforeResponse = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "oj_health", arguments: {} } }),
      {}
    );
    const before = await parseMcpResponse<{ structuredContent?: { overall?: string; layers?: unknown; message?: string } }>(
      beforeResponse
    );
    const controller = new AbortController();
    const pending = worker.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 52,
          method: "tools/call",
          params: { name: "oj_fetch_problem", arguments: { nativeId: "P1305", maxContentChars: 500 } }
        },
        {},
        controller.signal
      ),
      {}
    );
    await blockedStarted;
    controller.abort(new DOMException("HTTP client disconnected", "AbortError"));
    await pending.catch(() => undefined);
    const afterResponse = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", id: 53, method: "tools/call", params: { name: "oj_health", arguments: {} } }),
      {}
    );
    const after = await parseMcpResponse<{ structuredContent?: { overall?: string; layers?: unknown; message?: string } }>(
      afterResponse
    );

    expect(upstreamSignal?.aborted).toBe(true);
    expect(before.result.structuredContent).toMatchObject({ overall: "healthy" });
    expect(after.result.structuredContent).toMatchObject({
      overall: before.result.structuredContent?.overall,
      layers: before.result.structuredContent?.layers,
      message: before.result.structuredContent?.message
    });
  });
});

interface ListedTool {
  name: string;
}

interface McpResponse<T> {
  result: T;
}

function mcpRequest(body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Request {
  return rawMcpRequest(JSON.stringify(body), headers, signal);
}

function rawMcpRequest(body: string, headers: Record<string, string> = {}, signal?: AbortSignal): Request {
  return new Request("https://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers
    },
    body,
    signal
  });
}

function streamingMcpRequest(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
  signal?: AbortSignal
): Request {
  return new Request("https://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers
    },
    body,
    signal,
    duplex: "half"
  } as RequestInit & { duplex: "half" });
}

function fetchProblemRequest(id: number, signal?: AbortSignal): Request {
  return mcpRequest(
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "oj_fetch_problem", arguments: { nativeId: "P1305", maxContentChars: 500 } }
    },
    {},
    signal
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for test condition.");
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

async function readWorkerHealth(
  targetWorker: ReturnType<typeof createLuoguWorker>,
  id: number
): Promise<Record<string, unknown>> {
  const response = await targetWorker.fetch(
    mcpRequest({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "oj_health", arguments: {} } }),
    {}
  );
  const parsed = await parseMcpResponse<{ structuredContent: Record<string, unknown> }>(response);
  return parsed.result.structuredContent;
}

async function parseMcpResponse<T>(response: Response): Promise<McpResponse<T>> {
  const responseText = await response.text();
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return JSON.parse(responseText) as McpResponse<T>;
  }
  const dataLines = responseText.split("\n").filter((line) => line.startsWith("data: ") && line.length > 6);
  return JSON.parse(dataLines.at(-1)!.slice(6)) as McpResponse<T>;
}
