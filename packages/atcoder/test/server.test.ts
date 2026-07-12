import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { AtCoderHtmlClient } from "../src/client.js";
import { AtCoderProvider } from "../src/provider.js";
import { ATCODER_MCP_TOOL_NAMES, createAtCoderMcpServer } from "../src/server.js";
import { loadHtmlFixture } from "./fixtureLoader.js";

describe("AtCoder MCP server", () => {
  test("lists only approved anonymous read tools and fetches a structured problem document", async () => {
    const html = await loadHtmlFixture("abc086-a-en.html");
    const provider = new AtCoderProvider({
      client: new AtCoderHtmlClient({
        fetchImpl: async () => new Response(html, { status: 200, headers: { "Content-Type": "text/html" } })
      }),
      nowIso: () => "2026-07-11T00:00:00.000Z"
    });
    const server = createAtCoderMcpServer({ provider, transport: "local_stdio" });
    const client = new Client({ name: "atcoder-test-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const result = await client.callTool({
      name: "oj_fetch_problem",
      arguments: { contestId: "abc086", taskId: "abc086_a", locale: "en" }
    });

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...ATCODER_MCP_TOOL_NAMES].sort());
    expect(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(listed.tools.some((tool) => /auth|login|run|submit/i.test(tool.name))).toBe(false);
    expect("structuredContent" in result && result.structuredContent).toMatchObject({
      schemaVersion: "oj.problem-document/v1",
      title: "Product"
    });

    await client.close();
    await server.close();
  });

  test("returns a structured resource_not_found error without leaking an upstream body", async () => {
    const provider = new AtCoderProvider({
      client: new AtCoderHtmlClient({
        fetchImpl: async () => new Response("private upstream detail", { status: 404 })
      })
    });
    const server = createAtCoderMcpServer({ provider, transport: "local_stdio" });
    const client = new Client({ name: "atcoder-error-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "oj_fetch_problem",
      arguments: { contestId: "abc999", taskId: "abc999_z", locale: "en" }
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "resource.not_found", httpStatus: 404, retryPolicy: "never" }
    });
    expect(JSON.stringify(result)).not.toContain("private upstream detail");

    await client.close();
    await server.close();
  });

  test("publishes strict platform-specific input schemas", async () => {
    const server = createAtCoderMcpServer({ transport: "local_stdio" });
    const client = new Client({ name: "atcoder-schema-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const fetchTool = listed.tools.find((tool) => tool.name === "oj_fetch_problem")!;
    const searchTool = listed.tools.find((tool) => tool.name === "oj_search_problems")!;
    expect((fetchTool.inputSchema as { $schema?: string }).$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema"
    );
    expect(fetchTool.inputSchema).toMatchObject({ anyOf: expect.any(Array) });
    expect((fetchTool.inputSchema as { anyOf: Array<{ additionalProperties?: boolean }> }).anyOf).toSatisfy(
      (variants: Array<{ additionalProperties?: boolean }>) => variants.every((variant) => variant.additionalProperties === false)
    );
    expect(searchTool.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: { platform: { const: "atcoder" }, locale: { enum: ["en", "ja"] } }
    });
    expect((searchTool.inputSchema as { properties: Record<string, unknown> }).properties).not.toHaveProperty("cursor");

    await client.close();
    await server.close();
  });

  test.each(["local_stdio", "remote_http"] as const)(
    "reports explicitly injected %s capabilities",
    async (transport) => {
      const server = createAtCoderMcpServer({ transport });
      const client = new Client({ name: `atcoder-${transport}-client`, version: "0.1.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({ name: "oj_capabilities", arguments: {} });
      const operations = (result.structuredContent as { operations: Record<string, { transport: string }> }).operations;
      expect(Object.values(operations).every((operation) => operation.transport === transport)).toBe(true);

      await client.close();
      await server.close();
    }
  );

  test("declares success and oj.error output variants for every tool", async () => {
    const server = createAtCoderMcpServer({ transport: "local_stdio" });
    const client = new Client({ name: "atcoder-output-schema-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const expectedSchemaVersions: Record<string, string> = {
      oj_capabilities: "oj.capabilities/v1",
      oj_health: "oj.provider-health/v1",
      oj_fetch_problem: "oj.problem-document/v1",
      oj_search_problems: "oj.search-result/v1"
    };
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(Object.keys(expectedSchemaVersions).sort());
    for (const tool of listed.tools) {
      const outputSchema = tool.outputSchema as {
        anyOf?: Array<{ properties?: { schemaVersion?: { const?: string } } }>;
      };
      expect(outputSchema.anyOf).toHaveLength(2);
      expect(outputSchema.anyOf?.map((variant) => variant.properties?.schemaVersion?.const).sort()).toEqual(
        [expectedSchemaVersions[tool.name], "oj.error/v1"].sort()
      );
    }

    await client.close();
    await server.close();
  });

  test.each([
    ["oj_health", { unexpected: true }],
    ["oj_fetch_problem", { contestId: "ABC086", taskId: "abc086_a", locale: "en" }],
    ["unknown_tool", {}]
  ])("returns oj.error/v1 for invalid call %s", async (name, args) => {
    const server = createAtCoderMcpServer({ transport: "local_stdio" });
    const client = new Client({ name: "atcoder-invalid-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({ name, arguments: args });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { schemaVersion: "oj.error/v1", code: "request.invalid", layer: "protocol" }
    });

    await client.close();
    await server.close();
  });

  test("propagates MCP cancellation to the upstream fetch", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const provider = new AtCoderProvider({
      client: new AtCoderHtmlClient({
        timeoutMs: 10_000,
        fetchImpl: async (_input, init) => {
          upstreamSignal = init?.signal ?? undefined;
          return new Promise((_resolve, reject) =>
            upstreamSignal!.addEventListener("abort", () => reject(upstreamSignal!.reason), { once: true })
          );
        }
      })
    });
    const server = createAtCoderMcpServer({ provider, transport: "local_stdio" });
    const client = new Client({ name: "atcoder-cancel-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const caller = new AbortController();

    const pending = client.callTool(
      { name: "oj_fetch_problem", arguments: { contestId: "abc086", taskId: "abc086_a", locale: "en" } },
      undefined,
      { signal: caller.signal }
    );
    await Promise.resolve();
    caller.abort();

    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(upstreamSignal?.aborted).toBe(true);
    await client.close();
    await server.close();
  });
});
