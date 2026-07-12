import { once } from "node:events";
import { request } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { createNodeHttpServer, type WebWorker } from "../src/bridge.js";

const servers: Array<ReturnType<typeof createNodeHttpServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    )
  );
});

describe("createNodeHttpServer", () => {
  test("forwards a bounded HTTP request to a Web worker and streams its response", async () => {
    const worker: WebWorker = {
      async fetch(inbound) {
        expect(new URL(inbound.url).pathname).toBe("/mcp");
        expect(inbound.headers.get("x-forwarded-test")).toBe("yes");
        expect(await inbound.text()).toBe('{"ping":true}');
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: first\n\n"));
              controller.enqueue(new TextEncoder().encode("data: second\n\n"));
              controller.close();
            }
          }),
          { status: 202, headers: { "content-type": "text/event-stream", "x-worker": "ok" } }
        );
      }
    };
    const server = createNodeHttpServer({ worker });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address.");

    const response = await send(address.port, "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-test": "yes" },
      body: '{"ping":true}'
    });

    expect(response).toEqual({
      status: 202,
      headers: expect.objectContaining({ "content-type": "text/event-stream", "x-worker": "ok" }),
      body: "data: first\n\ndata: second\n\n"
    });
  });

  test("requires the configured internal key without forwarding rejected requests", async () => {
    let calls = 0;
    const server = createNodeHttpServer({
      worker: { fetch: async () => (calls += 1, new Response("unexpected")) },
      internalKey: "correct-horse-battery-staple"
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address.");

    expect(await send(address.port, "/healthz")).toMatchObject({ status: 401 });
    expect(await send(address.port, "/healthz", { headers: { "x-oj-mcp-key": "wrong" } })).toMatchObject({ status: 401 });
    expect(
      await send(address.port, "/healthz", { headers: { "x-oj-mcp-key": "correct-horse-battery-staple" } })
    ).toMatchObject({ status: 200, body: "unexpected" });
    expect(calls).toBe(1);
  });

  test("aborts the worker request when the HTTP client disconnects", async () => {
    let observedSignal: AbortSignal | undefined;
    let resolveObserved: (() => void) | undefined;
    const observed = new Promise<void>((resolve) => (resolveObserved = resolve));
    const server = createNodeHttpServer({
      worker: {
        fetch: async (inbound) => {
          observedSignal = inbound.signal;
          resolveObserved?.();
          await new Promise<void>((resolve) => inbound.signal.addEventListener("abort", () => resolve(), { once: true }));
          return new Response(null, { status: 499 });
        }
      }
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address.");

    const client = request({ hostname: "127.0.0.1", port: address.port, path: "/mcp", method: "POST" });
    client.on("error", () => undefined);
    client.write("{");
    client.end();
    await observed;
    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(observedSignal?.aborted).toBe(true);
  });
});

async function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return await new Promise((resolve, reject) => {
    const outbound = request(
      { hostname: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    outbound.on("error", reject);
    if (options.body) outbound.write(options.body);
    outbound.end();
  });
}
