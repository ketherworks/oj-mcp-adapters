import { describe, expect, test } from "vitest";
import { NowCoderPageClient, type NowCoderHttpRequester } from "../src/client.js";
import { NowCoderProvider } from "../src/provider.js";
import { loadFixture } from "./fixtureLoader.js";

const nowIso = () => "2026-07-11T01:02:03.000Z";
const url = "https://ac.nowcoder.com/acm/problem/218144";

describe("NowCoderProvider", () => {
  test("fetches a public page while reporting the audited read capabilities", async () => {
    const html = await loadFixture("acm-problem.html");
    const provider = new NowCoderProvider({
      client: clientReturning(200, html, { "content-type": "text/html" }),
      nowIso
    });

    const [document, capabilities] = await Promise.all([
      provider.fetchProblem({ url }),
      provider.getCapabilities()
    ]);

    expect(document.ref.nativeId).toBe("NC218144");
    expect(capabilities).toMatchObject({
      providerId: "nowcoder-public-page",
      platform: "nowcoder",
      operations: {
        fetchProblem: {
          status: "available",
          toolName: "oj_fetch_problem",
          transport: "local_stdio",
          auth: "none",
          risk: "R0_public_read",
          compliance: "unofficial"
        },
        searchProblems: {
          status: "available",
          toolName: "oj_search_problems",
          transport: "local_stdio",
          auth: "none",
          risk: "R0_public_read"
        },
        importProblem: {
          status: "available",
          toolName: "oj_open_import_window",
          transport: "local_stdio",
          auth: "browser",
          risk: "R0_public_read"
        },
        fetchProfile: {
          status: "available",
          toolName: "oj_fetch_profile",
          transport: "local_stdio",
          auth: "none",
          risk: "R0_public_read"
        },
        listSubmissions: {
          status: "available",
          toolName: "oj_list_submissions",
          transport: "local_stdio",
          auth: "none",
          risk: "R0_public_read"
        },
        localRun: { status: "unsupported" },
        platformRun: { status: "auth_required" },
        prepareSubmission: { status: "auth_required" },
        commitSubmission: { status: "auth_required" },
        pollSubmission: { status: "auth_required" }
      },
      source: { kind: "page_adapter", confidence: "derived" }
    });
  });

  test("searches the official problem catalog with a bounded page cursor", async () => {
    const html = await loadFixture("problem-list.html");
    const requested: string[] = [];
    const provider = new NowCoderProvider({
      client: new NowCoderPageClient({ requester: async (requestUrl) => {
        requested.push(requestUrl.href);
        return { status: 200, body: html, headers: { "content-type": "text/html" } };
      } }),
      nowIso
    });

    const result = await provider.search({
      schemaVersion: "oj.search-request/v1",
      requestId: "search-provider-1",
      platform: "nowcoder",
      query: "二分",
      limit: 20
    });

    expect(requested).toEqual([
      "https://ac.nowcoder.com/acm/problem/list?keyword=%E4%BA%8C%E5%88%86&page=1&pageSize=20&order=id&asc=false&difficulty=0&platformTagId=0&sourceTagId=0&status=all&tagId="
    ]);
    expect(result).toMatchObject({
      schemaVersion: "oj.search-result/v1",
      requestId: "search-provider-1",
      nextCursor: "2",
      items: [
        { ref: { nativeId: "NC286185" } },
        { ref: { nativeId: "NC306825" } }
      ]
    });
  });

  test("raises fetch risk and declares session-cookie auth when a local session is configured", async () => {
    const provider = new NowCoderProvider({
      client: new NowCoderPageClient({
        sessionCookie: "NOWCODER_SESSION=private-secret",
        requester: async () => ({ status: 500, body: "", headers: {} })
      }),
      nowIso
    });

    const capabilities = await provider.getCapabilities();

    expect(capabilities.operations.fetchProblem).toMatchObject({
      status: "available",
      auth: "session_cookie",
      risk: "R1_private_read"
    });
  });

  test("does not make a live health probe and reports a successful prior parse", async () => {
    const html = await loadFixture("acm-problem.html");
    let requests = 0;
    const provider = new NowCoderProvider({
      client: new NowCoderPageClient({ requester: async () => {
        requests += 1;
        return { status: 200, body: html, headers: { "content-type": "text/html" } };
      } }),
      nowIso
    });

    const initial = await provider.getHealth();
    expect(requests).toBe(0);
    expect(initial).toMatchObject({ overall: "healthy", layers: { schema: "unknown" } });

    await provider.fetchProblem({ url });
    const afterFetch = await provider.getHealth();
    expect(requests).toBe(1);
    expect(afterFetch).toMatchObject({
      overall: "healthy",
      layers: { transport: "pass", protocol: "pass", schema: "pass", auth: "not_required", upstream: "pass" }
    });
  });

  test("maps a contest native ID to its deterministic official URL", async () => {
    const html = await loadFixture("acm-contest.html");
    const requested: string[] = [];
    const provider = new NowCoderProvider({
      client: new NowCoderPageClient({ requester: async (requestUrl) => {
        requested.push(requestUrl.href);
        return { status: 200, body: html, headers: { "content-type": "text/html" } };
      } }),
      nowIso
    });

    const document = await provider.fetchProblem({ nativeId: "11244/A" });

    expect(requested).toEqual(["https://ac.nowcoder.com/acm/contest/11244/A"]);
    expect(document.ref).toMatchObject({ nativeId: "11244/A", contest: { nativeId: "11244", index: "A" } });
  });

  const healthCases: Array<[
    number,
    string,
    Record<string, string>,
    { overall: string; upstream: string; schema?: string; auth?: string; retryAfterMs?: number }
  ]> = [
    [200, "challenge.html", {}, { overall: "degraded", auth: "challenge", upstream: "blocked" }],
    [200, "malformed.html", {}, { overall: "degraded", schema: "drift", upstream: "pass" }],
    [429, "rate-limit.html", { "retry-after": "2" }, { overall: "degraded", upstream: "rate_limited", retryAfterMs: 2000 }]
  ];
  test.each(healthCases)("maps fixture failure %s/%s into provider health", async (status, fixture, extraHeaders, expected) => {
    const html = await loadFixture(fixture);
    const provider = new NowCoderProvider({
      client: clientReturning(status, html, { "content-type": "text/html", ...extraHeaders }),
      nowIso
    });

    await expect(provider.fetchProblem({ url })).rejects.toBeDefined();
    const health = await provider.getHealth();

    expect(health.overall).toBe(expected.overall);
    expect(health.layers.schema).toBe(expected.schema ?? "unknown");
    expect(health.layers.auth).toBe(expected.auth ?? "not_required");
    expect(health.layers.upstream).toBe(expected.upstream);
    if (expected.retryAfterMs) expect(health.retryAfterMs).toBe(expected.retryAfterMs);
  });
});

function clientReturning(status: number, body: string, headers: Record<string, string>): NowCoderPageClient {
  const requester: NowCoderHttpRequester = async () => ({ status, body, headers });
  return new NowCoderPageClient({ requester });
}
