import { describe, expect, test } from "vitest";
import { NowCoderPageClient, type NowCoderHttpRequester } from "../src/client.js";
import { NowCoderProvider } from "../src/provider.js";
import { loadFixture } from "./fixtureLoader.js";

const nowIso = () => "2026-07-11T01:02:03.000Z";
const url = "https://ac.nowcoder.com/acm/problem/218144";

describe("NowCoderProvider", () => {
  test("fetches a public page while reporting only the audited capability", async () => {
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
        searchProblems: { status: "unsupported" },
        importProblem: { status: "unsupported" },
        localRun: { status: "unsupported" },
        platformRun: { status: "unsupported" },
        prepareSubmission: { status: "unsupported" },
        commitSubmission: { status: "unsupported" },
        pollSubmission: { status: "unsupported" }
      },
      source: { kind: "page_adapter", confidence: "derived" }
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
