import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test, vi } from "vitest";
import { NowCoderPageClient } from "../src/client.js";
import { CompetitiveCompanionImporter } from "../src/companion.js";
import { NowCoderAdapterError } from "../src/errors.js";
import { NowCoderJudgeService, type NowCoderJudgeGateway } from "../src/judge.js";
import { NowCoderProvider } from "../src/provider.js";
import { createNowCoderMcpServer, NOWCODER_MCP_TOOL_NAMES } from "../src/server.js";
import { loadFixture } from "./fixtureLoader.js";

const url = "https://ac.nowcoder.com/acm/problem/218144";

describe("NowCoder MCP server", () => {
  test("exposes a redacted session-status probe as a read-only MCP tool", async () => {
    const provider = new NowCoderProvider({
      client: new NowCoderPageClient({
        sessionCookie: "NOWCODER_SESSION=must-not-escape",
        requester: async () => ({
          status: 200,
          body: '<script>window.isLogin = true; window.globalInfo = { ownerId: "123456789" };</script>',
          headers: { "content-type": "text/html" }
        })
      }),
      nowIso: () => "2026-07-14T11:00:00.000Z"
    });
    const { client, server } = await connect(provider);

    const result = await client.callTool({ name: "nowcoder_auth_status", arguments: {} });

    expect(result).toMatchObject({
      structuredContent: {
        schemaVersion: "nowcoder.auth-status/v1",
        platform: "nowcoder",
        configured: true,
        state: "authenticated",
        checkedAt: "2026-07-14T11:00:00.000Z"
      }
    });
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
    await client.close();
    await server.close();
  });

  test("lists the read tools and returns problem documents and search results", async () => {
    const html = await loadFixture("acm-problem.html");
    const listHtml = await loadFixture("problem-list.html");
    const provider = new NowCoderProvider({
      client: new NowCoderPageClient({ requester: async (requestUrl) => ({
        status: 200,
        body: requestUrl.pathname.endsWith("/list") ? listHtml : html,
        headers: { "content-type": "text/html" }
      }) }),
      nowIso: () => "2026-07-11T01:02:03.000Z"
    });
    const { client, server } = await connect(provider);

    const listed = await client.listTools();
    const urlResult = await client.callTool({ name: "oj_fetch_problem", arguments: { url } });
    const nativeIdResult = await client.callTool({ name: "oj_fetch_problem", arguments: { nativeId: "NC218144" } });
    const searchResult = await client.callTool({
      name: "oj_search_problems",
      arguments: {
        schemaVersion: "oj.search-request/v1",
        requestId: "search-server-1",
        platform: "nowcoder",
        query: "二分",
        limit: 20
      }
    });

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...NOWCODER_MCP_TOOL_NAMES].sort());
    const actionTools = new Set(["oj_open_import_window", "oj_complete_import", "oj_prepare_submission", "oj_commit_submission", "oj_platform_run"]);
    expect(listed.tools.filter((tool) => !actionTools.has(tool.name)).every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(listed.tools.filter((tool) => actionTools.has(tool.name)).every((tool) => tool.annotations?.readOnlyHint === false)).toBe(true);
    expect(listed.tools.find((tool) => tool.name === "oj_commit_submission")?.annotations?.destructiveHint).toBe(true);
    expect(listed.tools.some((tool) => /cookie/i.test(tool.name))).toBe(false);
    expect(listed.tools.every((tool) => JSON.stringify(tool.outputSchema).includes("oj.error/v1"))).toBe(true);
    const fetchTool = listed.tools.find((tool) => tool.name === "oj_fetch_problem");
    expect(Object.keys((fetchTool?.inputSchema.properties ?? {}) as Record<string, unknown>).sort()).toEqual([
      "nativeId",
      "url"
    ]);
    expect("structuredContent" in urlResult && urlResult.structuredContent).toMatchObject({
      schemaVersion: "oj.problem-document/v1",
      ref: { platform: "nowcoder", nativeId: "NC218144" }
    });
    expect("structuredContent" in nativeIdResult && nativeIdResult.structuredContent).toMatchObject({
      schemaVersion: "oj.problem-document/v1",
      ref: { platform: "nowcoder", nativeId: "NC218144" }
    });
    expect("structuredContent" in searchResult && searchResult.structuredContent).toMatchObject({
      schemaVersion: "oj.search-result/v1",
      requestId: "search-server-1",
      items: expect.any(Array)
    });

    await client.close();
    await server.close();
  });

  test("opens and completes a Competitive Companion import through MCP", async () => {
    const importer = new CompetitiveCompanionImporter({ port: 0, nowIso: () => "2026-07-14T15:30:00.000Z" });
    const provider = new NowCoderProvider({ importer });
    const { client, server } = await connect(provider);

    const opened = await client.callTool({
      name: "oj_open_import_window",
      arguments: {
        schemaVersion: "oj.import-window-request/v1",
        requestId: "mcp-import-1",
        allowedPlatforms: ["nowcoder"],
        expiresInMs: 10_000
      }
    });
    const window = opened.structuredContent as { windowId: string; endpoint: string };
    const posted = await fetch(window.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "浏览器导题",
        group: "NowCoder",
        url: "https://ac.nowcoder.com/acm/problem/286185",
        interactive: false,
        memoryLimit: 256,
        timeLimit: 2_000,
        tests: [{ input: "1\n", output: "2\n" }],
        input: { type: "stdin" },
        output: { type: "stdout" }
      })
    });
    const completed = await client.callTool({
      name: "oj_complete_import",
      arguments: { windowId: window.windowId }
    });

    expect(posted.status).toBe(200);
    expect(completed).toMatchObject({
      structuredContent: {
        schemaVersion: "oj.import-preview/v1",
        windowId: window.windowId,
        document: { title: "浏览器导题", ref: { nativeId: "NC286185" } }
      }
    });
    await provider.dispose();
    await client.close();
    await server.close();
  });

  test("returns a compact public competition profile through MCP", async () => {
    const html = await loadFixture("profile.html");
    const provider = new NowCoderProvider({
      client: new NowCoderPageClient({ requester: async () => ({
        status: 200,
        body: html,
        headers: { "content-type": "text/html" }
      }) }),
      nowIso: () => "2026-07-14T16:00:00.000Z"
    });
    const { client, server } = await connect(provider);

    const result = await client.callTool({
      name: "oj_fetch_profile",
      arguments: { accountId: "886965097" }
    });

    expect(result).toMatchObject({
      structuredContent: {
        schemaVersion: "nowcoder.profile/v1",
        accountId: "886965097",
        displayName: "HoMaMaOvO",
        rating: 3979,
        ratingRankLabel: "1"
      }
    });
    await provider.dispose();
    await client.close();
    await server.close();
  });

  test("lists compact public submission metadata through MCP", async () => {
    const html = await loadFixture("submissions.html");
    const provider = new NowCoderProvider({
      client: new NowCoderPageClient({ requester: async () => ({
        status: 200,
        body: html,
        headers: { "content-type": "text/html" }
      }) }),
      nowIso: () => "2026-07-14T16:30:00.000Z"
    });
    const { client, server } = await connect(provider);

    const result = await client.callTool({
      name: "oj_list_submissions",
      arguments: { accountId: "776966013", limit: 2 }
    });

    expect(result).toMatchObject({
      structuredContent: {
        schemaVersion: "nowcoder.submission-list/v1",
        accountId: "776966013",
        totalPages: 3,
        items: [
          { submissionId: "83132818", verdict: "accepted" },
          { submissionId: "83132781", verdict: "wrong_answer" }
        ]
      }
    });
    await provider.dispose();
    await client.close();
    await server.close();
  });

  test("elicits an explicit confirmation before one real submission", async () => {
    const source = "int main(){return 0;}\n";
    const codeSha256 = createHash("sha256").update(source).digest("hex");
    let submissions = 0;
    const gateway: NowCoderJudgeGateway = {
      prepareContext: async () => ({
        accountId: "123456789",
        displayName: "student",
        questionId: "1338275",
        samples: [{ ordinal: 1, input: "1 2\n", output: "3\n" }],
        supportedLanguageIds: ["1", "2", "4", "11"]
      }),
      obtainAccessToken: async () => "short-token",
      submit: async () => {
        submissions += 1;
        return { id: "90001", submissionId: "90001" };
      },
      poll: async () => ({ status: 5, submissionId: "90001" })
    };
    const judge = new NowCoderJudgeService({ gateway });
    const provider = new NowCoderProvider({ judge });
    const prompts: string[] = [];
    const { client, server } = await connect(provider, async (message) => {
      prompts.push(message);
      return { action: "accept", content: { confirm: true } };
    });
    const sourceRef = {
      kind: "page_adapter" as const,
      adapterId: "nowcoder-public-page",
      adapterVersion: "0.2.0",
      fetchedAt: "2026-07-14T17:00:00.000Z",
      sourceUrl: url,
      confidence: "derived" as const
    };
    const prepared = await client.callTool({
      name: "oj_prepare_submission",
      arguments: {
        schemaVersion: "oj.prepare-submission/v1",
        requestId: "prepare-mcp-1",
        attemptId: "attempt-mcp-1",
        providerId: "nowcoder-public-page",
        problem: {
          schemaVersion: "oj.problem-ref/v1",
          platform: "nowcoder",
          nativeId: "NC218144",
          canonicalId: "nowcoder:NC218144",
          url,
          source: sourceRef
        },
        accountId: "123456789",
        languageKey: "cpp",
        platformLanguageId: "2",
        code: {
          languageKey: "cpp",
          platformLanguageId: "2",
          source,
          sha256: codeSha256,
          bytes: Buffer.byteLength(source),
          fileName: "main.cpp",
          capturedAt: "2026-07-14T17:00:00.000Z",
          sourceWasDirty: false
        }
      }
    });
    const preview = prepared.structuredContent as {
      intentId: string;
      submissionOperationId: string;
      codeArtifactId: string;
      codeSha256: string;
    };
    const committed = await client.callTool({
      name: "oj_commit_submission",
      arguments: {
        schemaVersion: "oj.submit-commit/v1",
        requestId: "commit-mcp-1",
        intentId: preview.intentId,
        submissionOperationId: preview.submissionOperationId,
        codeArtifactId: preview.codeArtifactId,
        codeSha256: preview.codeSha256
      }
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("NC218144");
    expect(prompts[0]).toContain("main.cpp");
    expect(prompts[0]).toContain(codeSha256);
    expect(submissions).toBe(1);
    expect(committed).toMatchObject({
      structuredContent: {
        schemaVersion: "oj.submit-result/v1",
        state: "queued",
        platformSubmissionId: "90001"
      }
    });
    expect(JSON.stringify(committed)).not.toContain("short-token");
    await provider.dispose();
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

async function connect(
  provider: NowCoderProvider,
  confirm?: (message: string) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, boolean> }>
): Promise<{ client: Client; server: ReturnType<typeof createNowCoderMcpServer> }> {
  const server = createNowCoderMcpServer({ provider });
  const client = new Client(
    { name: "nowcoder-test-client", version: "0.1.0" },
    confirm ? { capabilities: { elicitation: { form: {} } } } : undefined
  );
  if (confirm) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => confirm(request.params.message));
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}
