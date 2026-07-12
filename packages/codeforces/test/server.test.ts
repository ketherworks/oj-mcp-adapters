import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { createCodeforcesMcpServer, CODEFORCES_MCP_TOOL_NAMES } from "../src/server.js";
import { CodeforcesProvider } from "../src/provider.js";
import { CodeforcesApiError, CodeforcesRequestCancelledError } from "../src/client.js";
import { fixtureSource } from "./serverFixture.js";

describe("Codeforces MCP server", () => {
  test("lists only approved public read tools and returns structured search output", async () => {
    const provider = {
      getCapabilities: async () => capabilities(),
      getHealth: async () => health(),
      search: async (request: { requestId: string }) => ({
        schemaVersion: "oj.search-result/v1" as const,
        requestId: request.requestId,
        items: [],
        source: fixtureSource
      }),
      getProblemMetadata: async () => undefined
    } as unknown as CodeforcesProvider;
    const server = createCodeforcesMcpServer({ provider, transport: "local_stdio" });
    const client = new Client({ name: "codeforces-test-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const result = await client.callTool({
      name: "oj_search_problems",
      arguments: {
        schemaVersion: "oj.search-request/v1",
        requestId: "search-1",
        platform: "codeforces",
        query: "watermelon",
        limit: 10
      }
    });

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...CODEFORCES_MCP_TOOL_NAMES].sort());
    expect(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(listed.tools.every((tool) => Array.isArray((tool.outputSchema as { anyOf?: unknown[] }).anyOf))).toBe(true);
    expect("structuredContent" in result && result.structuredContent).toMatchObject({ requestId: "search-1" });

    await client.close();
    await server.close();
  });

  test("returns structured request.invalid for malformed and unsupported search arguments", async () => {
    const { client, close } = await connectedClient({
      search: async () => {
        throw new Error("provider should not receive invalid input");
      }
    });

    for (const arguments_ of [
      {
        schemaVersion: "oj.search-request/v1",
        requestId: "bad-platform",
        platform: "leetcode",
        query: "watermelon",
        limit: 10
      },
      {
        schemaVersion: "oj.search-request/v1",
        requestId: "bad-cursor",
        platform: "codeforces",
        query: "watermelon",
        limit: 10,
        cursor: "unsupported"
      },
      {
        schemaVersion: "oj.search-request/v1",
        requestId: "bad-locale",
        platform: "codeforces",
        query: "watermelon",
        limit: 10,
        locale: "en"
      }
    ]) {
      const result = await client.callTool({ name: "oj_search_problems", arguments: arguments_ });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { schemaVersion: "oj.error/v1", code: "request.invalid", layer: "broker" }
      });
    }
    await close();
  });

  test("injects local_stdio into stdio-hosted capabilities", async () => {
    const server = createCodeforcesMcpServer({
      provider: new CodeforcesProvider({ nowIso: () => "2026-07-10T12:00:00.000Z" }),
      transport: "local_stdio"
    });
    const client = new Client({ name: "codeforces-test-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({ name: "oj_capabilities", arguments: {} });
    const operations = Object.values((result.structuredContent as any).operations) as Array<{ transport: string }>;
    expect(operations.every((operation) => operation.transport === "local_stdio")).toBe(true);

    await client.close();
    await server.close();
  });

  test("maps not-found, rate-limit, timeout, and drift to explicit structured errors", async () => {
    const cases = [
      {
        name: "codeforces_get_problem_metadata",
        arguments: { nativeId: "9999/Z" },
        provider: { getProblemMetadata: async () => undefined },
        expected: { code: "resource.not_found", layer: "upstream", retryPolicy: "never", userAction: "none" }
      },
      {
        name: "oj_search_problems",
        arguments: searchArguments("rate"),
        provider: { search: async () => Promise.reject(new CodeforcesApiError("rate_limited", "Slow down", 2_000)) },
        expected: { code: "rate_limited", layer: "upstream", retryPolicy: "safe_read", userAction: "retry" }
      },
      {
        name: "oj_search_problems",
        arguments: searchArguments("timeout"),
        provider: { search: async () => Promise.reject(new CodeforcesApiError("network.timeout", "Timed out")) },
        expected: { code: "network.timeout", layer: "transport", retryPolicy: "safe_read", userAction: "retry" }
      },
      {
        name: "oj_search_problems",
        arguments: searchArguments("drift"),
        provider: { search: async () => Promise.reject(new CodeforcesApiError("upstream.schema_changed", "Drift")) },
        expected: { code: "upstream.schema_changed", layer: "upstream", retryPolicy: "never", userAction: "open_logs" }
      }
    ] as const;

    for (const testCase of cases) {
      const { client, close } = await connectedClient(testCase.provider);
      const result = await client.callTool({ name: testCase.name, arguments: testCase.arguments });
      expect(result).toMatchObject({ isError: true, structuredContent: testCase.expected });
      await close();
    }
  });

  test("propagates SDK cancellation into the provider signal", async () => {
    let observedSignal: AbortSignal | undefined;
    const { client, close } = await connectedClient({
      search: async (_input: unknown, options: { signal?: AbortSignal }) => {
        observedSignal = options.signal;
        return await new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new CodeforcesRequestCancelledError("cancelled")),
            { once: true }
          );
        });
      }
    });
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "oj_search_problems", arguments: searchArguments("cancel") },
      undefined,
      { signal: controller.signal }
    );
    controller.abort();

    await expect(pending).rejects.toThrow(/Abort/);
    expect(observedSignal?.aborted).toBe(true);
    await close();
  });
});

function searchArguments(requestId: string) {
  return {
    schemaVersion: "oj.search-request/v1",
    requestId,
    platform: "codeforces",
    query: "watermelon",
    limit: 10
  };
}

async function connectedClient(overrides: Record<string, unknown>) {
  const provider = {
    getCapabilities: async () => capabilities(),
    getHealth: async () => health(),
    search: async (request: { requestId: string }) => ({
      schemaVersion: "oj.search-result/v1" as const,
      requestId: request.requestId,
      items: [],
      source: fixtureSource
    }),
    getProblemMetadata: async () => undefined,
    ...overrides
  } as unknown as CodeforcesProvider;
  const server = createCodeforcesMcpServer({ provider, transport: "local_stdio" });
  const client = new Client({ name: "codeforces-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}

function capabilities() {
  return {
    schemaVersion: "oj.capabilities/v1",
    providerId: "codeforces-official-api",
    providerVersion: "0.1.0",
    platform: "codeforces",
    protocolVersion: "2025-11-25",
    operations: {},
    languages: [],
    source: fixtureSource
  };
}

function health() {
  return {
    schemaVersion: "oj.provider-health/v1",
    providerId: "codeforces-official-api",
    platform: "codeforces",
    checkedAt: "2026-07-10T12:00:00.000Z",
    overall: "healthy",
    layers: { transport: "pass", protocol: "pass", schema: "pass", auth: "not_required", upstream: "pass" },
    message: "Healthy"
  };
}
