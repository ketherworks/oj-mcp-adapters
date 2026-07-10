import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { createCodeforcesMcpServer, CODEFORCES_MCP_TOOL_NAMES } from "../src/server.js";
import type { CodeforcesProvider } from "../src/provider.js";
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
    const server = createCodeforcesMcpServer({ provider });
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
    expect("structuredContent" in result && result.structuredContent).toMatchObject({ requestId: "search-1" });

    await client.close();
    await server.close();
  });
});

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
