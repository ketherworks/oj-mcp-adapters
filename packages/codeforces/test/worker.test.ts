import { describe, expect, test } from "vitest";
import worker, { createCodeforcesWorker } from "../src/worker.js";
import { CODEFORCES_MCP_TOOL_NAMES } from "../src/server.js";

describe("Codeforces Cloudflare Worker", () => {
  test("publishes a public health document without requiring a key", async () => {
    const response = await worker.fetch(new Request("https://example.com/healthz"), {} as never);
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ mcpEndpoint: "/mcp", authentication: "none" });
  });

  test("lists only approved read tools over stateless Streamable HTTP", async () => {
    const response = await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }), {} as never);
    const body = await parseMcpResponse(response);

    expect(response.status).toBe(200);
    expect(body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...CODEFORCES_MCP_TOOL_NAMES].sort());
    expect(body.result.tools.some((tool: { name: string }) => /submit|run/i.test(tool.name))).toBe(false);
  });

  test("rejects browser origins unless explicitly allowed", async () => {
    const request = mcpRequest({}, { origin: "https://evil.example" });
    const response = await worker.fetch(request, {} as never);

    expect(response.status).toBe(403);
  });

  test("enforces streamed request bytes before SDK dispatch", async () => {
    let cancelled = false;
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(33)));
      },
      cancel() {
        cancelled = true;
      }
    });
    const fixtureWorker = createCodeforcesWorker({ maxRequestBytes: 32 });
    const oversized = new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: oversizedBody,
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    const oversizedResponse = await fixtureWorker.fetch(oversized, {});
    expect(oversizedResponse.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  test("does not hold isolate admission when declared-body cancellation never settles", async () => {
    let cancelStarted = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelStarted = true;
        return new Promise<void>(() => undefined);
      }
    });
    const fixtureWorker = createCodeforcesWorker({
      maxRequestBytes: 512,
      maxConcurrentRequests: 1,
      maxQueuedRequests: 0
    });
    const oversized = new Request("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "content-length": "513"
      },
      body,
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    const rejected = await settleWithin(fixtureWorker.fetch(oversized, {}), 100);
    const admitted = await settleWithin(
      fixtureWorker.fetch(mcpRequest({ jsonrpc: "2.0", id: 93, method: "tools/list" }), {}),
      100
    );

    expect(cancelStarted).toBe(true);
    expect(rejected.status).toBe(413);
    expect(admitted.status).toBe(200);
  });

  test("rejects every JSON-RPC batch before SDK dispatch", async () => {
    const fixtureWorker = createCodeforcesWorker();
    const batches = [
      [],
      [{ jsonrpc: "2.0", id: 1, method: "tools/list" }],
      [
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" }
      ]
    ];

    for (const batch of batches) {
      const response = await fixtureWorker.fetch(mcpRequest(batch), {});
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: -32600, message: "JSON-RPC batch requests are not supported." }
      });
    }
  });

  test.each(["Cookie", "Authorization"])("rejects %s before reading the body or entering the SDK", async (header) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0"'));
      },
      cancel() {
        cancelled = true;
      }
    });
    const request = new Request("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        [header]: "secret"
      },
      body,
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    const response = await createCodeforcesWorker({ ingressTimeoutMs: 20 }).fetch(request, {});
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Credential-bearing requests are not accepted." });
    expect(cancelled).toBe(true);
  });

  test("passes the one-shot parsed body to the SDK", async () => {
    const fixtureWorker = createCodeforcesWorker();
    const response = await fixtureWorker.fetch(mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }), {});
    const body = await parseMcpResponse(response);

    expect(response.status).toBe(200);
    expect(body.result.tools).toHaveLength(CODEFORCES_MCP_TOOL_NAMES.length);
  });

  test("reports remote_http capabilities over the Worker transport", async () => {
    const response = await createCodeforcesWorker().fetch(callToolRequest(2, "oj_capabilities", {}), {});
    const body = await parseMcpResponse(response);
    const operations = Object.values(body.result.structuredContent.operations) as Array<{ transport: string }>;

    expect(response.status).toBe(200);
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every((operation) => operation.transport === "remote_http")).toBe(true);
  });

  test("bounds isolate admission and frees a cancelled queued request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const validBody = JSON.stringify({ status: "OK", result: { problems: [], problemStatistics: [] } });
    const env = {
      CODEFORCES_COORDINATOR: {
        getByName: () => ({
          fetch: async (request: Request) => {
            if (new URL(request.url).pathname === "/health") return new Response("null");
            await gate;
            return new Response(validBody);
          }
        })
      }
    };
    const fixtureWorker = createCodeforcesWorker({ maxConcurrentRequests: 1, maxQueuedRequests: 1 });
    const active = fixtureWorker.fetch(searchRequest(10), env);
    const controller = new AbortController();
    const queued = fixtureWorker.fetch(searchRequest(11, controller.signal), env);

    const overflow = await fixtureWorker.fetch(searchRequest(12), env);
    expect(overflow.status).toBe(429);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    const replacement = fixtureWorker.fetch(searchRequest(13), env);
    release();
    expect((await active).status).toBe(200);
    expect((await replacement).status).toBe(200);
  });

  test("reads persisted Durable Object health while healthz stays liveness-only", async () => {
    let healthReads = 0;
    const fixtureWorker = createCodeforcesWorker();
    const env = {
      CODEFORCES_COORDINATOR: {
        getByName: () => ({
          fetch: async (request: Request) => {
            if (new URL(request.url).pathname === "/health") {
              healthReads += 1;
              return new Response(
                JSON.stringify({ checkedAt: "2026-07-10T12:00:00.000Z", code: "upstream.schema_changed" })
              );
            }
            throw new Error("unexpected problemset request");
          }
        })
      }
    };
    const health = await fixtureWorker.fetch(callToolRequest(20, "oj_health", {}), env);
    const healthBody = await parseMcpResponse(health);
    const liveness = await fixtureWorker.fetch(new Request("https://example.com/healthz"), env);

    expect(healthBody.result.structuredContent).toMatchObject({ overall: "degraded", layers: { schema: "drift" } });
    expect(healthReads).toBe(1);
    expect(liveness.status).toBe(200);
  });

  test("aborts a stalled upload, cancels its reader, and releases the isolate slot", async () => {
    let cancelled = false;
    let markReading!: () => void;
    const reading = new Promise<void>((resolve) => {
      markReading = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      pull() {
        markReading();
      },
      cancel() {
        cancelled = true;
      }
    });
    const controller = new AbortController();
    const fixtureWorker = createCodeforcesWorker({
      maxConcurrentRequests: 1,
      maxQueuedRequests: 0,
      ingressTimeoutMs: 10_000
    });
    const stalledRequest = new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body,
      signal: controller.signal,
      duplex: "half"
    } as RequestInit & { duplex: "half" });
    const stalled = fixtureWorker.fetch(stalledRequest, {});
    await reading;

    expect((await fixtureWorker.fetch(mcpRequest({ jsonrpc: "2.0", id: 90, method: "tools/list" }), {})).status).toBe(429);
    controller.abort();
    await expect(stalled).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);

    const admitted = await fixtureWorker.fetch(mcpRequest({ jsonrpc: "2.0", id: 91, method: "tools/list" }), {});
    expect(admitted.status).toBe(200);
  });

  test("times out a stalled upload and releases the isolate slot", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      }
    });
    const fixtureWorker = createCodeforcesWorker({
      maxConcurrentRequests: 1,
      maxQueuedRequests: 0,
      ingressTimeoutMs: 20
    });
    const stalledRequest = new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body,
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    const timedOut = await fixtureWorker.fetch(stalledRequest, {});
    expect(timedOut.status).toBe(408);
    expect(cancelled).toBe(true);
    expect((await fixtureWorker.fetch(mcpRequest({ jsonrpc: "2.0", id: 92, method: "tools/list" }), {})).status).toBe(200);
  });
});

function searchRequest(id: number, signal?: AbortSignal): Request {
  return callToolRequest(id, "oj_search_problems", {
    schemaVersion: "oj.search-request/v1",
    requestId: `worker-${id}`,
    platform: "codeforces",
    query: "watermelon",
    limit: 10
  }, signal);
}

function callToolRequest(id: number, name: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Request {
  return mcpRequest({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_ } }, {}, signal);
}

function mcpRequest(body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Request {
  return new Request("https://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers
    },
    body: JSON.stringify(body),
    signal
  });
}

async function parseMcpResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return JSON.parse(text);
  }
  const dataLines = text.split("\n").filter((line) => line.startsWith("data: ") && line.length > 6);
  return JSON.parse(dataLines.at(-1)!.slice(6));
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
