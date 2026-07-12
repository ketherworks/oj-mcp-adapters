import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test, vi } from "vitest";
import { NowCoderPageClient } from "../src/client.js";
import { NowCoderAdapterError } from "../src/errors.js";
import { NowCoderProvider } from "../src/provider.js";
import { createNowCoderMcpServer, NOWCODER_MCP_TOOL_NAMES } from "../src/server.js";
import { loadFixture } from "./fixtureLoader.js";

const url = "https://ac.nowcoder.com/acm/problem/218144";

describe("NowCoder MCP server", () => {
  test("lists exactly the approved read-only tools and returns an OjProblemDocument", async () => {
    const html = await loadFixture("acm-problem.html");
    const provider = new NowCoderProvider({
      client: new NowCoderPageClient({ requester: async () => ({
        status: 200,
        body: html,
        headers: { "content-type": "text/html" }
      }) }),
      nowIso: () => "2026-07-11T01:02:03.000Z"
    });
    const { client, server } = await connect(provider);

    const listed = await client.listTools();
    const urlResult = await client.callTool({ name: "oj_fetch_problem", arguments: { url } });
    const nativeIdResult = await client.callTool({ name: "oj_fetch_problem", arguments: { nativeId: "NC218144" } });

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...NOWCODER_MCP_TOOL_NAMES].sort());
    expect(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(listed.tools.some((tool) => /search|run|submit|cookie|browser/i.test(tool.name))).toBe(false);
    expect(listed.tools.every((tool) => JSON.stringify(tool.outputSchema).includes("oj.error/v1"))).toBe(true);
    expect("structuredContent" in urlResult && urlResult.structuredContent).toMatchObject({
      schemaVersion: "oj.problem-document/v1",
      ref: { platform: "nowcoder", nativeId: "NC218144" }
    });
    expect("structuredContent" in nativeIdResult && nativeIdResult.structuredContent).toMatchObject({
      schemaVersion: "oj.problem-document/v1",
      ref: { platform: "nowcoder", nativeId: "NC218144" }
    });

    await client.close();
    await server.close();
  });

  test.each(["218144", "NC001", "11244/a", "11244/../A", "11244//A"])(
    "rejects ambiguous or unsafe native ID %s before fetching",
    async (nativeId) => {
      let requests = 0;
      const provider = new NowCoderProvider({
        client: new NowCoderPageClient({ requester: async () => {
          requests += 1;
          return { status: 500, body: "", headers: {} };
        } })
      });
      const { client, server } = await connect(provider);

      const result = await client.callTool({ name: "oj_fetch_problem", arguments: { nativeId } });

      expect(result.isError).toBe(true);
      expect(requests).toBe(0);
      await client.close();
      await server.close();
    }
  );

  test("requires exactly one URL or native ID locator", async () => {
    let requests = 0;
    const provider = new NowCoderProvider({
      client: new NowCoderPageClient({ requester: async () => {
        requests += 1;
        return { status: 500, body: "", headers: {} };
      } })
    });
    const { client, server } = await connect(provider);

    const both = await client.callTool({ name: "oj_fetch_problem", arguments: { url, nativeId: "NC218144" } });
    const neither = await client.callTool({ name: "oj_fetch_problem", arguments: {} });

    expect(both.isError).toBe(true);
    expect(neither.isError).toBe(true);
    expect(requests).toBe(0);
    await client.close();
    await server.close();
  });

  test("retains challenge action while passive health becomes degraded", async () => {
    const challenge = await loadFixture("challenge.html");
    const provider = new NowCoderProvider({
      client: new NowCoderPageClient({ requester: async () => ({
        status: 200,
        body: challenge,
        headers: { "content-type": "text/html" }
      }) }),
      nowIso: () => "2026-07-11T01:02:03.000Z"
    });
    const { client, server } = await connect(provider);

    const result = await client.callTool({ name: "oj_fetch_problem", arguments: { nativeId: "NC218144" } });
    const health = await client.callTool({ name: "oj_health", arguments: {} });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        code: "challenge.required",
        layer: "auth",
        retryPolicy: "after_user_action",
        userAction: "solve_challenge"
      }
    });
    expect(health).toMatchObject({
      structuredContent: {
        overall: "degraded",
        layers: { auth: "challenge", upstream: "blocked" }
      }
    });
    await client.close();
    await server.close();
  });

  test("returns contract-shaped rate-limit errors through MCP", async () => {
    const provider = new NowCoderProvider({
      client: new NowCoderPageClient({ requester: async () => ({
        status: 429,
        body: await loadFixture("rate-limit.html"),
        headers: { "content-type": "text/html", "retry-after": "4" }
      }) }),
      nowIso: () => "2026-07-11T01:02:03.000Z"
    });
    const { client, server } = await connect(provider);

    const result = await client.callTool({ name: "oj_fetch_problem", arguments: { url } });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        schemaVersion: "oj.error/v1",
        code: "rate_limited",
        layer: "upstream",
        retryPolicy: "safe_read",
        userAction: "retry",
        platform: "nowcoder",
        providerId: "nowcoder-public-page",
        httpStatus: 429,
        retryAfterMs: 4000
      }
    });

    await client.close();
    await server.close();
  });

  test("falls back to a valid internal OjError when adapter metadata is malformed at runtime", async () => {
    const provider = new NowCoderProvider();
    const malformed = new NowCoderAdapterError("internal", "Malformed adapter failure.");
    Object.defineProperty(malformed, "code", { value: "not-an-oj-code" });
    Object.defineProperty(malformed, "options", {
      value: { httpStatus: 999, retryAfterMs: Number.POSITIVE_INFINITY }
    });
    vi.spyOn(provider, "fetchProblem").mockRejectedValue(malformed);
    const { client, server } = await connect(provider);

    const result = await client.callTool({ name: "oj_fetch_problem", arguments: { nativeId: "NC218144" } });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        schemaVersion: "oj.error/v1",
        code: "internal",
        layer: "broker",
        retryPolicy: "never",
        userAction: "open_logs",
        platform: "nowcoder",
        providerId: "nowcoder-public-page"
      }
    });
    expect(result.structuredContent).not.toHaveProperty("httpStatus");
    expect(result.structuredContent).not.toHaveProperty("retryAfterMs");

    await client.close();
    await server.close();
  });

  test("propagates MCP cancellation without degrading passive health", async () => {
    let upstreamSignal: AbortSignal | undefined;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const provider = new NowCoderProvider({
      client: new NowCoderPageClient({ requester: async (_url, context) => {
        upstreamSignal = context.signal;
        startedResolve?.();
        return await new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
        });
      } })
    });
    const { client, server } = await connect(provider);
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "oj_fetch_problem", arguments: { nativeId: "NC218144" } },
      undefined,
      { signal: controller.signal, timeout: 1_000 }
    );
    await started;
    controller.abort(new DOMException("Cancelled", "AbortError"));

    await expect(pending).rejects.toThrow();
    expect(upstreamSignal?.aborted).toBe(true);
    await expect(provider.getHealth()).resolves.toMatchObject({
      overall: "healthy",
      layers: { schema: "unknown", upstream: "pass" }
    });
    await client.close();
    await server.close();
  });
});

async function connect(provider: NowCoderProvider): Promise<{ client: Client; server: ReturnType<typeof createNowCoderMcpServer> }> {
  const server = createNowCoderMcpServer({ provider });
  const client = new Client({ name: "nowcoder-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}
