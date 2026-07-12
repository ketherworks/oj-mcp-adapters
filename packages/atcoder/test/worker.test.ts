import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { describe, expect, test, vi } from "vitest";
import { ATCODER_MCP_TOOL_NAMES } from "../src/server.js";
import { createAtCoderWorker } from "../src/worker.js";
import { loadHtmlFixture } from "./fixtureLoader.js";

describe("AtCoder Cloudflare Worker", () => {
  test("serves independent stateless MCP requests and fetches through the fixture-backed official page client", async () => {
    const html = await loadHtmlFixture("abc086-a-en.html");
    const worker = createAtCoderWorker({
      fetchImpl: async () => new Response(html, { status: 200, headers: { "Content-Type": "text/html" } }),
      nowIso: () => "2026-07-11T00:00:00.000Z"
    });

    const listedResponse = await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }), {});
    const listed = await parseMcpResponse(listedResponse);
    const fetchedResponse = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "oj_fetch_problem", arguments: { contestId: "abc086", taskId: "abc086_a", locale: "en" } }
      }),
      {}
    );
    const fetched = await parseMcpResponse(fetchedResponse);

    expect(listed.result.tools!.map((tool) => tool.name).sort()).toEqual([...ATCODER_MCP_TOOL_NAMES].sort());
    expect(fetched.result.structuredContent).toMatchObject({ title: "Product", locale: "en" });
    expect(listedResponse.headers.has("mcp-session-id")).toBe(false);
    expect(fetchedResponse.headers.has("mcp-session-id")).toBe(false);
  });

  test("publishes keyless stateless readiness metadata", async () => {
    const worker = createAtCoderWorker();

    const response = await worker.fetch(new Request("https://worker.example/healthz"), {});

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      stateless: true,
      authentication: "none",
      mcpEndpoint: "/mcp",
      tools: ATCODER_MCP_TOOL_NAMES
    });
  });

  test("production Worker reports remote_http capabilities", async () => {
    const worker = createAtCoderWorker();

    const response = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "oj_capabilities", arguments: {} }
      }),
      {}
    );
    const envelope = await parseMcpResponse(response);
    const operations = (envelope.result.structuredContent as {
      operations: Record<string, { transport: string }>;
    }).operations;

    expect(Object.values(operations).every((operation) => operation.transport === "remote_http")).toBe(true);
  });

  test("rejects browser origins unless they are explicitly allowed", async () => {
    const worker = createAtCoderWorker();

    const response = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: "https://evil.example" }),
      {}
    );

    expect(response.status).toBe(403);
  });

  test.each(["authorization", "cookie"])("rejects %s before invoking the MCP SDK", async (header) => {
    const handleRequest = vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, "handleRequest");
    const worker = createAtCoderWorker();

    const response = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { [header]: "secret" }),
      {}
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Authentication headers are not accepted." });
    expect(handleRequest).not.toHaveBeenCalled();
    handleRequest.mockRestore();
  });

  test.each(["authorization", "cookie"])(
    "does not await hanging %s body cancellation or bypass admission",
    async (header) => {
      const worker = createAtCoderWorker({ maxConcurrentRequests: 1, ingressTimeoutMs: 10_000 });
      const rejectedBody = hangingCancellationStream();
      const rejected = worker.fetch(
        streamingMcpRequest(rejectedBody.body, undefined, { [header]: "secret" }),
        {}
      );
      await rejectedBody.cancelStarted;

      expect(await settledWithin(rejected, 100)).toMatchObject({
        status: "fulfilled",
        value: { status: 400 }
      });
      expect((await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 4, method: "tools/list" }), {})).status).toBe(200);

      let markReading!: () => void;
      const reading = new Promise<void>((resolve) => {
        markReading = resolve;
      });
      const occupiedController = new AbortController();
      const occupied = worker.fetch(
        streamingMcpRequest(
          new ReadableStream<Uint8Array>({
            pull() {
              markReading();
            }
          }),
          occupiedController.signal
        ),
        {}
      );
      await reading;

      const capacityRejectedBody = hangingCancellationStream();
      const capacityRejected = worker.fetch(
        streamingMcpRequest(capacityRejectedBody.body, undefined, { [header]: "secret" }),
        {}
      );
      await capacityRejectedBody.cancelStarted;
      expect(await settledWithin(capacityRejected, 100)).toMatchObject({
        status: "fulfilled",
        value: { status: 503 }
      });

      occupiedController.abort();
      await expect(occupied).rejects.toMatchObject({ name: "AbortError" });
      expect((await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 5, method: "tools/list" }), {})).status).toBe(200);
    }
  );

  test("rejects declared and streamed oversized request bodies with 413 before SDK parsing", async () => {
    const worker = createAtCoderWorker({ maxInboundBytes: 64 });
    let cancelled = 0;
    const declared = new Request("https://worker.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "65" },
      body: new ReadableStream({
        cancel() {
          cancelled += 1;
        }
      }),
      duplex: "half"
    } as RequestInit);

    const declaredResponse = await worker.fetch(declared, {});
    const streamedResponse = await worker.fetch(
      new Request("https://worker.example/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(65)
      }),
      {}
    );

    expect(declaredResponse.status).toBe(413);
    expect(streamedResponse.status).toBe(413);
    expect(cancelled).toBe(1);
  });

  test("does not await hanging cancellation for a declared oversized body and releases admission", async () => {
    const worker = createAtCoderWorker({ maxInboundBytes: 64, maxConcurrentRequests: 1 });
    const oversizedBody = hangingCancellationStream();
    const rejected = worker.fetch(
      streamingMcpRequest(oversizedBody.body, undefined, { "content-length": "65" }),
      {}
    );
    await oversizedBody.cancelStarted;

    expect(await settledWithin(rejected, 100)).toMatchObject({
      status: "fulfilled",
      value: { status: 413 }
    });
    expect((await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 6, method: "tools/list" }), {})).status).toBe(200);
  });

  test("rejects JSON-RPC batches before SDK parsing", async () => {
    const worker = createAtCoderWorker();

    const response = await worker.fetch(mcpRequest([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]), {});

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "JSON-RPC batches are not supported." });
  });

  test("returns structured invalid-call errors over HTTP", async () => {
    const worker = createAtCoderWorker();

    const response = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "oj_health", arguments: { unexpected: true } }
      }),
      {}
    );
    const envelope = await parseMcpResponse(response);

    expect(envelope.result).toMatchObject({
      isError: true,
      structuredContent: { schemaVersion: "oj.error/v1", code: "request.invalid" }
    });
  });

  test("persists provider health across stateless Worker requests", async () => {
    const worker = createAtCoderWorker({ fetchImpl: async () => new Response("limited", { status: 429 }) });
    await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "oj_fetch_problem", arguments: { contestId: "abc086", taskId: "abc086_a", locale: "en" } }
      }),
      {}
    );

    const health = await parseMcpResponse(
      await worker.fetch(
        mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "oj_health", arguments: {} } }),
        {}
      )
    );

    expect(health.result.structuredContent).toMatchObject({ overall: "degraded", layers: { upstream: "rate_limited" } });
  });

  test("coalesces concurrent identical task reads across Worker requests", async () => {
    const html = await loadHtmlFixture("abc086-a-en.html");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let upstreamReads = 0;
    const worker = createAtCoderWorker({
      fetchImpl: async () => {
        upstreamReads += 1;
        await gate;
        return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
      }
    });
    const body = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "oj_fetch_problem", arguments: { contestId: "abc086", taskId: "abc086_a", locale: "en" } }
    };

    const first = worker.fetch(mcpRequest({ ...body, id: 1 }), {});
    const second = worker.fetch(mcpRequest({ ...body, id: 2 }), {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upstreamReads).toBe(1);
    release();
    expect((await parseMcpResponse(await first)).result.structuredContent).toMatchObject({ title: "Product" });
    expect((await parseMcpResponse(await second)).result.structuredContent).toMatchObject({ title: "Product" });
  });

  test("rejects excess concurrent requests through bounded admission", async () => {
    const html = await loadHtmlFixture("abc086-a-en.html");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = createAtCoderWorker({
      maxConcurrentRequests: 1,
      fetchImpl: async () => {
        await gate;
        return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
      }
    });
    const call = (id: number) =>
      mcpRequest({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "oj_fetch_problem", arguments: { contestId: "abc086", taskId: "abc086_a", locale: "en" } }
      });

    const first = worker.fetch(call(1), {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rejected = await worker.fetch(call(2), {});
    expect(rejected.status).toBe(503);
    release();
    await first;
  });

  test("aborts a stalled upload, cancels its reader, and releases admission", async () => {
    let cancelled = false;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let markReading!: () => void;
    const reading = new Promise<void>((resolve) => {
      markReading = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      pull() {
        markReading();
      },
      cancel() {
        cancelled = true;
      }
    });
    const controller = new AbortController();
    const worker = createAtCoderWorker({ maxConcurrentRequests: 1, ingressTimeoutMs: 10_000 });
    const stalled = worker.fetch(streamingMcpRequest(body, controller.signal), {});
    await reading;

    expect((await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 90, method: "tools/list" }), {})).status).toBe(503);
    controller.abort();
    const outcome = await settledWithin(stalled, 100);
    if (outcome.status === "pending") {
      streamController.close();
      await stalled;
    }

    expect(outcome).toMatchObject({ status: "rejected", reason: { name: "AbortError" } });
    expect(cancelled).toBe(true);
    expect((await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 91, method: "tools/list" }), {})).status).toBe(200);
  });

  test("times out a stalled upload, cancels its reader, and releases admission", async () => {
    let cancelled = false;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        cancelled = true;
      }
    });
    const worker = createAtCoderWorker({ maxConcurrentRequests: 1, ingressTimeoutMs: 20 });
    const stalled = worker.fetch(streamingMcpRequest(body), {});

    const outcome = await settledWithin(stalled, 100);
    if (outcome.status === "pending") {
      streamController.close();
      await stalled;
    }

    expect(outcome).toMatchObject({ status: "fulfilled", value: { status: 408 } });
    expect(cancelled).toBe(true);
    expect((await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 92, method: "tools/list" }), {})).status).toBe(200);
  });

  test.each(["abort", "timeout"] as const)(
    "does not await a reader cancellation that never settles after ingress %s",
    async (failureMode) => {
      let markReading!: () => void;
      let markCancelStarted!: () => void;
      const reading = new Promise<void>((resolve) => {
        markReading = resolve;
      });
      const cancelStarted = new Promise<void>((resolve) => {
        markCancelStarted = resolve;
      });
      const body = new ReadableStream<Uint8Array>({
        pull() {
          markReading();
        },
        cancel() {
          markCancelStarted();
          return new Promise<void>(() => {});
        }
      });
      const controller = new AbortController();
      const worker = createAtCoderWorker({
        maxConcurrentRequests: 1,
        ingressTimeoutMs: failureMode === "timeout" ? 20 : 10_000
      });
      const stalled = worker.fetch(
        streamingMcpRequest(body, failureMode === "abort" ? controller.signal : undefined),
        {}
      );
      await reading;
      if (failureMode === "abort") controller.abort();
      await cancelStarted;

      const outcome = await settledWithin(stalled, 100);
      expect(outcome).toMatchObject(
        failureMode === "abort"
          ? { status: "rejected", reason: { name: "AbortError" } }
          : { status: "fulfilled", value: { status: 408 } }
      );
      expect((await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 93, method: "tools/list" }), {})).status).toBe(200);
    }
  );

  test("closes request-scoped MCP server and transport resources", async () => {
    const serverClose = vi.spyOn(Server.prototype, "close");
    const transportClose = vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, "close");
    const worker = createAtCoderWorker();

    const response = await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }), {});
    await response.text();

    expect(serverClose).toHaveBeenCalled();
    expect(transportClose).toHaveBeenCalled();
    serverClose.mockRestore();
    transportClose.mockRestore();
  });

  test("releases admission even when request-scoped cleanup fails", async () => {
    const transportClose = vi
      .spyOn(WebStandardStreamableHTTPServerTransport.prototype, "close")
      .mockRejectedValueOnce(new Error("close failed"));
    const worker = createAtCoderWorker({ maxConcurrentRequests: 1 });

    await expect(
      worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }), {})
    ).rejects.toThrow("close failed");
    transportClose.mockRestore();
    const next = await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }), {});

    expect(next.status).toBe(200);
  });
});

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://worker.example/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

function streamingMcpRequest(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  headers: Record<string, string> = {}
): Request {
  return new Request("https://worker.example/mcp", {
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

function hangingCancellationStream(): {
  body: ReadableStream<Uint8Array>;
  cancelStarted: Promise<void>;
} {
  let markCancelStarted!: () => void;
  const cancelStarted = new Promise<void>((resolve) => {
    markCancelStarted = resolve;
  });
  return {
    body: new ReadableStream<Uint8Array>({
      cancel() {
        markCancelStarted();
        return new Promise<void>(() => {});
      }
    }),
    cancelStarted
  };
}

async function settledWithin<T>(
  promise: Promise<T>,
  milliseconds: number
): Promise<
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
  | { status: "pending" }
> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    ),
    new Promise<{ status: "pending" }>((resolve) =>
      (timeout = setTimeout(() => resolve({ status: "pending" }), milliseconds))
    )
  ]).finally(() => clearTimeout(timeout));
}

interface McpTestEnvelope {
  result: {
    tools?: Array<{ name: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
}

async function parseMcpResponse(response: Response): Promise<McpTestEnvelope> {
  const text = await response.text();
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return JSON.parse(text);
  const dataLines = text.split("\n").filter((line) => line.startsWith("data: ") && line.length > 6);
  return JSON.parse(dataLines.at(-1)!.slice(6));
}
