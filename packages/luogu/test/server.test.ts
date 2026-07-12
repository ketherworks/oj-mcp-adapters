import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ojErrorSchema,
  ojProblemDocumentSchema,
  type OjCapability,
  type OjCapabilityName,
  type OjProblemDocument
} from "@kaiserunix/oj-mcp-contracts";
import { describe, expect, test } from "vitest";
import { LuoguAdapterError, LuoguRequestCancelledError, type LuoguPageReader } from "../src/client.js";
import { LuoguProvider } from "../src/provider.js";
import { createLuoguMcpServer, LUOGU_MCP_TOOL_NAMES } from "../src/server.js";
import { loadJsonFixture } from "./fixtureLoader.js";

describe("Luogu MCP server", () => {
  test("lists exactly four annotated anonymous read tools and returns structured shared output", async () => {
    const provider = providerStub();
    const { client, close } = await connect(provider);

    const listed = await client.listTools();
    const result = await client.callTool({
      name: "oj_search_problems",
      arguments: {
        schemaVersion: "oj.search-request/v1",
        requestId: "mcp-search-1",
        platform: "luogu",
        query: "binary tree",
        limit: 10
      }
    });

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...LUOGU_MCP_TOOL_NAMES].sort());
    expect(listed.tools).toHaveLength(4);
    expect(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(listed.tools.every((tool) => tool.annotations?.destructiveHint === false)).toBe(true);
    expect(listed.tools.every((tool) => tool.annotations?.idempotentHint === true)).toBe(true);
    expect(listed.tools.some((tool) => /profile|private|cookie|run|submit/i.test(tool.name))).toBe(false);
    const searchTool = listed.tools.find((tool) => tool.name === "oj_search_problems")!;
    const searchSchema = searchTool.inputSchema as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, Record<string, unknown>>;
    };
    expect(searchSchema.additionalProperties).toBe(false);
    expect(searchSchema.required?.sort()).toEqual(["limit", "platform", "query", "requestId", "schemaVersion"].sort());
    expect(searchSchema.properties?.schemaVersion).toMatchObject({ const: "oj.search-request/v1" });
    expect(searchSchema.properties?.platform).toMatchObject({ const: "luogu" });
    expect(searchSchema.properties?.query).toMatchObject({ type: "string", minLength: 1, maxLength: 200 });
    expect(searchSchema.properties?.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 50 });
    const capabilitiesSchema = listed.tools.find((tool) => tool.name === "oj_capabilities")!.inputSchema as {
      additionalProperties?: boolean;
    };
    expect(capabilitiesSchema.additionalProperties).toBe(false);
    const outputVersions = new Map([
      ["oj_capabilities", "oj.capabilities/v1"],
      ["oj_health", "oj.provider-health/v1"],
      ["oj_search_problems", "oj.search-result/v1"],
      ["oj_fetch_problem", "oj.problem-document/v1"]
    ]);
    for (const listedTool of listed.tools) {
      const serializedOutputSchema = JSON.stringify(listedTool.outputSchema);
      expect(serializedOutputSchema).toContain(outputVersions.get(listedTool.name));
      expect(serializedOutputSchema).toContain("oj.error/v1");
      expect(listedTool.outputSchema).toMatchObject({ anyOf: expect.any(Array) });
    }
    expect("structuredContent" in result && result.structuredContent).toMatchObject({
      schemaVersion: "oj.search-result/v1",
      requestId: "mcp-search-1"
    });

    await close();
  });

  test("returns shared structured errors for invalid inputs to every tool", async () => {
    const { client, close } = await connect(providerStub());

    const results = await Promise.all([
      client.callTool({ name: "oj_capabilities", arguments: { unexpected: true } }),
      client.callTool({ name: "oj_health", arguments: { unexpected: true } }),
      client.callTool({
        name: "oj_search_problems",
        arguments: {
          schemaVersion: "oj.search-request/v1",
          requestId: "mcp-search-too-large",
          platform: "luogu",
          query: "x",
          limit: 51,
          unexpected: true
        }
      }),
      client.callTool({ name: "oj_fetch_problem", arguments: { nativeId: "../user/1", maxContentChars: 199 } })
    ]);

    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(ojErrorSchema.safeParse("structuredContent" in result ? result.structuredContent : undefined).success).toBe(true);
      expect("structuredContent" in result && result.structuredContent).toMatchObject({
        schemaVersion: "oj.error/v1",
        code: "request.invalid",
        layer: "broker"
      });
    }
    await close();
  });

  test("fetches a fixture end to end through an MCP tool call", async () => {
    const payload = await loadJsonFixture("problem-ok.json");
    const reader: LuoguPageReader = {
      searchProblems: async () => {
        throw new Error("not used");
      },
      fetchProblem: async (nativeId) => ({
        payload,
        sourceUrl: `https://www.luogu.com.cn/problem/${nativeId}`
      })
    };
    const provider = new LuoguProvider({ reader, nowIso: () => "2026-07-11T08:00:00.000Z" });
    const { client, close } = await connect(provider);

    const result = await client.callTool({
      name: "oj_fetch_problem",
      arguments: { nativeId: "P1305", maxContentChars: 500 }
    });
    const structured = "structuredContent" in result ? result.structuredContent : undefined;

    expect(result.isError).not.toBe(true);
    expect(ojProblemDocumentSchema.safeParse(structured).success).toBe(true);
    expect(structured).toMatchObject({ title: "新二叉树", ref: { nativeId: "P1305" } });
    await close();
  });

  test("returns shared actionable errors for schema drift", async () => {
    const provider = providerStub();
    provider.search = async () => {
      throw new LuoguAdapterError("upstream.schema_changed", "Luogu problem search no longer matches the audited schema.");
    };
    const { client, close } = await connect(provider);

    const result = await client.callTool({
      name: "oj_search_problems",
      arguments: {
        schemaVersion: "oj.search-request/v1",
        requestId: "mcp-search-drift",
        platform: "luogu",
        query: "tree",
        limit: 10
      }
    });

    expect(result.isError).toBe(true);
    expect("structuredContent" in result && result.structuredContent).toMatchObject({
      schemaVersion: "oj.error/v1",
      code: "upstream.schema_changed",
      layer: "upstream",
      retryPolicy: "never"
    });
    await close();
  });

  test("propagates provider cancellation instead of resolving a normal OjError tool result", async () => {
    const provider = providerStub();
    provider.fetchProblem = async () => {
      throw new LuoguRequestCancelledError("Luogu problem fetch was cancelled by the caller.");
    };
    const { client, close } = await connect(provider);

    await expect(
      client.callTool({ name: "oj_fetch_problem", arguments: { nativeId: "P1305", maxContentChars: 500 } })
    ).rejects.toThrow();
    await close();
  });

  test("propagates MCP request cancellation through provider and reader", async () => {
    let startedResolve: ((signal: AbortSignal | undefined) => void) | undefined;
    const started = new Promise<AbortSignal | undefined>((resolve) => {
      startedResolve = resolve;
    });
    const reader: LuoguPageReader = {
      searchProblems: async () => {
        throw new Error("not used");
      },
      fetchProblem: async (_nativeId, options?: { signal?: AbortSignal }) => {
        const signal = options?.signal;
        startedResolve?.(signal);
        if (!signal) {
          throw new Error("missing request signal");
        }
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    };
    const provider = new LuoguProvider({ reader });
    const { client, close } = await connect(provider);
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "oj_fetch_problem", arguments: { nativeId: "P1305", maxContentChars: 500 } },
      undefined,
      { signal: controller.signal, timeout: 1_000 }
    );
    const propagated = await started;
    controller.abort(new DOMException("Cancelled", "AbortError"));
    await pending.catch(() => undefined);

    expect(propagated).toBeDefined();
    expect(propagated?.aborted).toBe(true);
    await close();
  });
});

async function connect(provider: LuoguProvider): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createLuoguMcpServer({ provider });
  const client = new Client({ name: "luogu-test-client", version: "0.1.0" });
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

function providerStub(): LuoguProvider {
  const checkedAt = "2026-07-11T08:00:00.000Z";
  const source = {
    kind: "page_adapter" as const,
    adapterId: "luogu-lentille-page-adapter",
    adapterVersion: "0.1.0",
    fetchedAt: checkedAt,
    sourceUrl: "https://www.luogu.com.cn/problem/list",
    confidence: "derived" as const
  };
  const names: OjCapabilityName[] = [
    "searchProblems",
    "fetchProblem",
    "importProblem",
    "fetchProfile",
    "listSubmissions",
    "localRun",
    "platformRun",
    "prepareSubmission",
    "commitSubmission",
    "pollSubmission"
  ];
  const operations = Object.fromEntries(
    names.map((name) => [
      name,
      {
        name,
        status: name === "searchProblems" || name === "fetchProblem" ? "available" : "unsupported",
        toolName: name === "searchProblems" ? "oj_search_problems" : name === "fetchProblem" ? "oj_fetch_problem" : undefined,
        transport: "local_stdio",
        auth: "none",
        risk: name === "commitSubmission" ? "R4_real_submit" : "R0_public_read",
        compliance: "unofficial",
        checkedAt
      } satisfies OjCapability
    ])
  ) as Record<OjCapabilityName, OjCapability>;
  const document: OjProblemDocument = {
    schemaVersion: "oj.problem-document/v1",
    ref: {
      schemaVersion: "oj.problem-ref/v1",
      platform: "luogu",
      nativeId: "P1001",
      canonicalId: "luogu:P1001",
      url: "https://www.luogu.com.cn/problem/P1001",
      source
    },
    title: "A+B Problem",
    locale: "zh-CN",
    access: "public",
    tags: [],
    content: {
      statement: { text: "A+B", format: "markdown", locale: "zh-CN", truncated: false, sha256: "a".repeat(64) }
    },
    constraints: [],
    samples: [],
    limits: {},
    io: { mode: "stdin_stdout" },
    starterCode: [],
    source
  };

  return {
    getCapabilities: async () => ({
      schemaVersion: "oj.capabilities/v1",
      providerId: "luogu-lentille-page-adapter",
      providerVersion: "0.1.0",
      platform: "luogu",
      protocolVersion: "2025-11-25",
      operations,
      languages: [],
      source
    }),
    getHealth: async () => ({
      schemaVersion: "oj.provider-health/v1",
      providerId: "luogu-lentille-page-adapter",
      platform: "luogu",
      checkedAt,
      overall: "healthy",
      layers: { transport: "pass", protocol: "pass", schema: "pass", auth: "not_required", upstream: "pass" },
      message: "Healthy"
    }),
    search: async (request: { requestId: string }) => ({
      schemaVersion: "oj.search-result/v1",
      requestId: request.requestId,
      items: [],
      source
    }),
    fetchProblem: async () => document
  } as unknown as LuoguProvider;
}
