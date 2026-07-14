import { afterEach, describe, expect, test, vi } from "vitest";
import {
  isPublicIpAddress,
  NowCoderPageClient,
  type NowCoderHttpRequester,
  type NowCoderHttpResponse
} from "../src/client.js";
import { loadFixture } from "./fixtureLoader.js";

describe("NowCoderPageClient", () => {
  afterEach(() => vi.useRealTimers());
  test("fetches only the canonical public page and preserves audited response metadata", async () => {
    const html = await loadFixture("acm-problem.html");
    const calls: string[] = [];
    const client = new NowCoderPageClient({
      requester: sequenceRequester([
        response(200, html, { "content-type": "text/html; charset=UTF-8", etag: '"page-v1"' })
      ], calls)
    });

    await expect(client.getProblemPage("https://ac.nowcoder.com/acm/problem/218144?tracking=yes#editor")).resolves.toEqual({
      html,
      url: "https://ac.nowcoder.com/acm/problem/218144",
      etag: '"page-v1"'
    });
    expect(calls).toEqual(["https://ac.nowcoder.com/acm/problem/218144"]);
  });

  test("fetches one bounded official problem-search page", async () => {
    const html = await loadFixture("problem-list.html");
    const observed: Array<{ url: string; sessionCookie?: string }> = [];
    const client = new NowCoderPageClient({
      sessionCookie: "NOWCODER_SESSION=search-secret",
      requester: async (url, context) => {
        observed.push({ url: url.href, sessionCookie: context.sessionCookie });
        return response(200, html, { "content-type": "text/html" });
      }
    });

    await expect(client.getProblemListPage({ query: "二分", page: 2, limit: 20 })).resolves.toEqual({
      html,
      url: "https://ac.nowcoder.com/acm/problem/list?keyword=%E4%BA%8C%E5%88%86&page=2&pageSize=20&order=id&asc=false&difficulty=0&platformTagId=0&sourceTagId=0&status=all&tagId="
    });
    expect(observed).toEqual([{
      url: "https://ac.nowcoder.com/acm/problem/list?keyword=%E4%BA%8C%E5%88%86&page=2&pageSize=20&order=id&asc=false&difficulty=0&platformTagId=0&sourceTagId=0&status=all&tagId=",
      sessionCookie: "NOWCODER_SESSION=search-secret"
    }]);
  });

  test("resolves the signed-in competition profile and fetches its bounded page", async () => {
    const profile = await loadFixture("profile.html");
    const observed: string[] = [];
    const client = new NowCoderPageClient({
      sessionCookie: "NOWCODER_SESSION=profile-secret",
      requester: async (requestUrl) => {
        observed.push(requestUrl.href);
        if (requestUrl.pathname === "/") {
          return response(200, '<script>window.isLogin=true; window.globalInfo={ownerId:"886965097"};</script>', { "content-type": "text/html" });
        }
        return response(200, profile, { "content-type": "text/html" });
      }
    });

    await expect(client.getProfilePage()).resolves.toEqual({
      accountId: "886965097",
      html: profile,
      url: "https://ac.nowcoder.com/acm/contest/profile/886965097"
    });
    expect(observed).toEqual([
      "https://ac.nowcoder.com/",
      "https://ac.nowcoder.com/acm/contest/profile/886965097"
    ]);
  });

  test("fetches one bounded server-rendered submission page", async () => {
    const html = await loadFixture("submissions.html");
    const requested: string[] = [];
    const client = new NowCoderPageClient({ requester: async (requestUrl) => {
      requested.push(requestUrl.href);
      return response(200, html, { "content-type": "text/html" });
    } });

    await expect(client.getSubmissionsPage({
      accountId: "776966013",
      page: 2,
      limit: 20,
      query: "魔咒"
    })).resolves.toEqual({
      accountId: "776966013",
      html,
      url: "https://ac.nowcoder.com/acm/contest/profile/776966013/practice-coding?pageSize=20&search=%E9%AD%94%E5%92%92&statusTypeFilter=-1&languageCategoryFilter=-1&orderType=DESC&page=2"
    });
    expect(requested).toEqual([
      "https://ac.nowcoder.com/acm/contest/profile/776966013/practice-coding?pageSize=20&search=%E9%AD%94%E5%92%92&statusTypeFilter=-1&languageCategoryFilter=-1&orderType=DESC&page=2"
    ]);
  });

  test("uses the audited token, submit, and poll requests without exposing credentials", async () => {
    const observed: Array<{ url: string; method?: string; body?: string; headers?: Readonly<Record<string, string>>; cookie?: string }> = [];
    const sessionCookie = [
      "csrf_token=csrf-secret",
      "NOWCODER_SESSION=nowcoder-session-secret",
      "NOWCODER_DEVICE=nowcoder-device-secret",
      "session=ac-session-secret",
      "token=ac-token-secret"
    ].join("; ");
    const client = new NowCoderPageClient({
      sessionCookie,
      requester: async (requestUrl, context) => {
        observed.push({
          url: requestUrl.href,
          method: context.method,
          body: context.body,
          headers: context.headers,
          cookie: context.sessionCookie
        });
        if (requestUrl.hostname === "gw-c.nowcoder.com") {
          return response(200, JSON.stringify({ success: true, code: 0, data: { accessToken: "Bearer short-token" } }), { "content-type": "application/json" });
        }
        if (requestUrl.pathname.endsWith("/submit")) {
          return response(200, JSON.stringify({ code: 0, msg: "OK", data: { id: "90001", submissionId: "90001" } }), { "content-type": "application/json" });
        }
        return response(200, JSON.stringify({ code: 0, msg: "OK", data: { status: 5, submissionId: "90001" } }), { "content-type": "application/json" });
      }
    });

    const token = await client.obtainJudgeAccessToken({ teamId: "42" });
    const submitted = await client.submitJudge({ content: "int main(){}", token, id: "payload" });
    const status = await client.pollJudge({ id: submitted.id!, userId: "123", appId: 6, tagId: 4, submitType: 1, remark: "{}", token, showId: 6, content: "must-not-enter-query" });

    expect(token).toBe("short-token");
    expect(status).toMatchObject({ status: 5, submissionId: "90001" });
    expect(observed).toHaveLength(3);
    expect(observed[0]).toMatchObject({
      method: "GET",
      cookie: "csrf_token=csrf-secret; NOWCODER_SESSION=nowcoder-session-secret; NOWCODER_DEVICE=nowcoder-device-secret"
    });
    expect(observed[0]!.url).toContain("sceneType=2");
    expect(observed[0]!.url).toContain("token=csrf-secret");
    expect(observed[0]!.url).toContain("teamId=42");
    expect(observed[0]!.headers).toMatchObject({ Origin: "https://d.nowcoder.com", Referer: "https://d.nowcoder.com/" });
    expect(observed[0]!.cookie).not.toContain("ac-session-secret");
    expect(observed[0]!.cookie).not.toContain("ac-token-secret");
    expect(Object.keys(observed[0]!.headers ?? {}).map((name) => name.toLowerCase())).not.toContain("cookie");
    expect(observed[1]).toMatchObject({
      method: "POST",
      cookie: undefined,
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" }
    });
    expect(Object.keys(observed[1]!.headers ?? {}).map((name) => name.toLowerCase())).not.toContain("cookie");
    expect(observed[2]).toMatchObject({ method: "GET", cookie: undefined });
    expect(Object.keys(observed[2]!.headers ?? {}).map((name) => name.toLowerCase())).not.toContain("cookie");
    expect(observed[2]!.url).toContain("token=short-token");
    expect(observed[2]!.url).not.toContain("must-not-enter-query");
    const output = JSON.stringify({ token, submitted, status });
    for (const secret of ["csrf-secret", "nowcoder-session-secret", "nowcoder-device-secret", "ac-session-secret", "ac-token-secret"]) {
      expect(output).not.toContain(secret);
    }
  });

  test("reads per-problem judge language IDs from question metadata", async () => {
    const requested: Array<{ url: string; method?: string; headers?: Readonly<Record<string, string>>; cookie?: string }> = [];
    const client = new NowCoderPageClient({
      sessionCookie: "csrf_token=csrf-secret; NOWCODER_SESSION=nowcoder-secret; session=ac-session-secret",
      requester: async (requestUrl, context) => {
        requested.push({
          url: requestUrl.href,
          method: context.method,
          headers: context.headers,
          cookie: context.sessionCookie
        });
        return response(200, JSON.stringify({
          code: 0,
          data: { codingInfo: { supportLanguages: [{ langId: 1 }, { langId: 2 }, { langId: "11" }] } }
        }), { "content-type": "application/json" });
      }
    });

    const languages = await client.getQuestionSupportLanguageIds("1338275");
    expect(languages).toEqual(["1", "2", "11"]);
    expect(requested).toEqual([
      {
        url: "https://questionbank.nowcoder.com/api/qmp/question/detail?id=1338275&version=3&sceneType=3001",
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Origin: "https://ac.nowcoder.com",
          Referer: "https://ac.nowcoder.com/"
        },
        cookie: undefined
      }
    ]);
    expect(JSON.stringify(languages)).not.toMatch(/csrf-secret|nowcoder-secret|ac-session-secret/);
  });

  test("attaches an opaque local session only to an allowlisted NowCoder request", async () => {
    const html = await loadFixture("acm-problem.html");
    const observed: Array<{ url: string; sessionCookie?: string }> = [];
    const client = new NowCoderPageClient({
      sessionCookie: "NOWCODER_SESSION=secret-value; token=second-secret",
      requester: async (url, context) => {
        observed.push({ url: url.href, sessionCookie: context.sessionCookie });
        return response(200, html, { "content-type": "text/html" });
      }
    });

    await client.getProblemPage("https://ac.nowcoder.com/acm/problem/218144");

    expect(observed).toEqual([{
      url: "https://ac.nowcoder.com/acm/problem/218144",
      sessionCookie: "NOWCODER_SESSION=secret-value; token=second-secret"
    }]);
  });

  test.each([
    {
      endpoint: "ac.nowcoder.com page",
      expectedCookie: "csrf_token=csrf-secret; NOWCODER_SESSION=nowcoder-secret; session=ac-session-secret",
      request: (client: NowCoderPageClient) => client.getProblemPage("https://ac.nowcoder.com/acm/problem/218144")
    },
    {
      endpoint: "gw-c access token",
      expectedCookie: "csrf_token=csrf-secret; NOWCODER_SESSION=nowcoder-secret",
      request: (client: NowCoderPageClient) => client.obtainJudgeAccessToken()
    },
    {
      endpoint: "questionbank metadata",
      expectedCookie: undefined,
      request: (client: NowCoderPageClient) => client.getQuestionSupportLanguageIds("1338275")
    },
    {
      endpoint: "victorinox submit",
      expectedCookie: undefined,
      request: (client: NowCoderPageClient) => client.submitJudge({ id: "payload", token: "judge-token" })
    },
    {
      endpoint: "victorinox poll",
      expectedCookie: undefined,
      request: (client: NowCoderPageClient) => client.pollJudge({ id: "90001", token: "judge-token" })
    }
  ])("keeps $endpoint request errors free of startup-cookie secrets", async ({ expectedCookie, request }) => {
    const sessionCookie = "csrf_token=csrf-secret; NOWCODER_SESSION=nowcoder-secret; session=ac-session-secret";
    const contexts: Array<{ sessionCookie?: string; headers?: Readonly<Record<string, string>> }> = [];
    const client = new NowCoderPageClient({
      sessionCookie,
      requester: async (_url, context) => {
        contexts.push({ sessionCookie: context.sessionCookie, headers: context.headers });
        return response(500, sessionCookie, { "content-type": "text/plain" });
      }
    });

    let thrown: unknown;
    try {
      await request(client);
    } catch (error) {
      thrown = error;
    }

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.sessionCookie).toBe(expectedCookie);
    expect(Object.keys(contexts[0]?.headers ?? {}).map((name) => name.toLowerCase())).not.toContain("cookie");
    expect(thrown).toMatchObject({ code: "upstream.unavailable" });
    const visibleError = `${String(thrown)} ${JSON.stringify(thrown)}`;
    for (const secret of ["csrf-secret", "nowcoder-secret", "ac-session-secret"]) {
      expect(visibleError).not.toContain(secret);
    }
  });

  test.each([
    "",
    "   ",
    "session=secret\r\nX-Injected: true",
    "session=secret\0suffix",
    `session=${"x".repeat(16_385)}`
  ].map((sessionCookie, index) => [index, sessionCookie] as const))(
    "rejects unsafe session cookie case %i without echoing it",
    (_index, sessionCookie) => {
      expect(() => new NowCoderPageClient({ sessionCookie })).toThrow("NowCoder session cookie is invalid");
      try {
        new NowCoderPageClient({ sessionCookie });
      } catch (error) {
        if (sessionCookie.length > 0) expect(String(error)).not.toContain(sessionCookie);
      }
    }
  );

  test("reports an unconfigured session without making a network request", async () => {
    let requests = 0;
    const client = new NowCoderPageClient({
      requester: async () => {
        requests += 1;
        return response(500, "");
      }
    });

    await expect(client.getSessionStatus()).resolves.toEqual({
      configured: false,
      state: "not_configured"
    });
    expect(requests).toBe(0);
  });

  test("validates a configured session against NowCoder's server-rendered login marker", async () => {
    const requests: Array<{ url: string; sessionCookie?: string }> = [];
    const client = new NowCoderPageClient({
      sessionCookie: "NOWCODER_SESSION=secret-value",
      requester: async (url, context) => {
        requests.push({ url: url.href, sessionCookie: context.sessionCookie });
        return response(200, '<script>window.isLogin = true; window.globalInfo = { ownerId: "123456789" };</script>', { "content-type": "text/html" });
      }
    });

    await expect(client.getSessionStatus()).resolves.toEqual({
      configured: true,
      state: "authenticated"
    });
    expect(requests).toEqual([{
      url: "https://ac.nowcoder.com/",
      sessionCookie: "NOWCODER_SESSION=secret-value"
    }]);
  });

  test("reports an expired configured session from NowCoder's anonymous marker", async () => {
    const client = new NowCoderPageClient({
      sessionCookie: "NOWCODER_SESSION=expired-secret",
      requester: async () => response(
        200,
        "<script>window.isLogin = false;</script>",
        { "content-type": "text/html" }
      )
    });

    await expect(client.getSessionStatus()).resolves.toEqual({
      configured: true,
      state: "expired"
    });
  });

  test("keeps anti-bot challenges distinct from an expired login", async () => {
    const challenge = await loadFixture("challenge.html");
    const client = new NowCoderPageClient({
      sessionCookie: "NOWCODER_SESSION=configured-secret",
      requester: async () => response(200, challenge, { "content-type": "text/html" })
    });

    await expect(client.getSessionStatus()).resolves.toEqual({
      configured: true,
      state: "challenge"
    });
  });

  test("rejects non-HTML auth probes instead of reporting an ambiguous session", async () => {
    const client = new NowCoderPageClient({
      sessionCookie: "NOWCODER_SESSION=configured-secret",
      requester: async () => response(200, "{}", { "content-type": "application/json" })
    });

    await expect(client.getSessionStatus()).rejects.toMatchObject({
      code: "upstream.schema_changed"
    });
  });

  test("preserves auth-probe rate limits as retryable errors", async () => {
    const client = new NowCoderPageClient({
      sessionCookie: "NOWCODER_SESSION=configured-secret",
      requester: async () => response(429, "slow down", {
        "content-type": "text/html",
        "retry-after": "2"
      })
    });

    await expect(client.getSessionStatus()).rejects.toMatchObject({
      code: "rate_limited",
      options: { httpStatus: 429, retryAfterMs: 2_000 }
    });
  });

  test("follows a bounded redirect only when every target remains allowlisted", async () => {
    const html = await loadFixture("acm-problem.html");
    const calls: string[] = [];
    const client = new NowCoderPageClient({
      requester: sequenceRequester([
        response(302, "", { location: "/acm/problem/218144?canonical=true" }),
        response(200, html, { "content-type": "text/html" })
      ], calls)
    });

    const page = await client.getProblemPage("https://ac.nowcoder.com/acm/problem/218143");

    expect(page.url).toBe("https://ac.nowcoder.com/acm/problem/218144");
    expect(calls).toEqual([
      "https://ac.nowcoder.com/acm/problem/218143",
      "https://ac.nowcoder.com/acm/problem/218144"
    ]);
  });

  test("blocks redirects that could turn the adapter into an SSRF relay", async () => {
    const observed: Array<{ url: string; sessionCookie?: string }> = [];
    const client = new NowCoderPageClient({
      sessionCookie: "NOWCODER_SESSION=redirect-secret",
      requester: async (url, context) => {
        observed.push({ url: url.href, sessionCookie: context.sessionCookie });
        return response(302, "", { location: "https://127.0.0.1/admin" });
      }
    });

    await expect(client.getProblemPage("https://ac.nowcoder.com/acm/problem/218144")).rejects.toMatchObject({
      code: "policy.blocked"
    });
    expect(observed).toEqual([{
      url: "https://ac.nowcoder.com/acm/problem/218144",
      sessionCookie: "NOWCODER_SESSION=redirect-secret"
    }]);
  });

  test("enforces the response limit in UTF-8 bytes", async () => {
    const client = new NowCoderPageClient({
      maxBytes: 5,
      requester: sequenceRequester([response(200, "汉汉", { "content-type": "text/html" })])
    });

    await expect(client.getProblemPage("https://ac.nowcoder.com/acm/problem/218144")).rejects.toMatchObject({
      code: "upstream.unavailable"
    });
  });

  test("maps timeout-like requester failures without leaking internal errors", async () => {
    const requester: NowCoderHttpRequester = async () => {
      throw new DOMException("request aborted", "AbortError");
    };
    const client = new NowCoderPageClient({ requester });

    await expect(client.getProblemPage("https://ac.nowcoder.com/acm/problem/218144")).rejects.toMatchObject({
      code: "network.timeout"
    });
  });

  test("enforces a real deadline and aborts slow requester work", async () => {
    vi.useFakeTimers();
    let activeTimers = 0;
    let aborts = 0;
    const requester: NowCoderHttpRequester = async (_url, limits) => new Promise((resolve, reject) => {
      const signal = (limits as typeof limits & { signal?: AbortSignal }).signal;
      activeTimers += 1;
      const timer = setTimeout(() => {
        activeTimers -= 1;
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(response(200, "<html></html>", { "content-type": "text/html" }));
      }, 250);
      const onAbort = () => {
        clearTimeout(timer);
        activeTimers -= 1;
        aborts += 1;
        reject(signal?.reason ?? new Error("aborted"));
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
    const client = new NowCoderPageClient({ requester, timeoutMs: 25 });
    const pending = expect(client.getProblemPage("https://ac.nowcoder.com/acm/problem/218144")).rejects.toMatchObject({
      code: "network.timeout"
    });
    await vi.advanceTimersByTimeAsync(25);
    await pending;

    expect(aborts).toBe(1);
    expect(activeTimers).toBe(0);
  });

  test("uses one deadline across redirect hops and cleans up the slow hop", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let activeTimers = 0;
    let aborts = 0;
    const requester: NowCoderHttpRequester = async (_url, limits) => new Promise((resolve, reject) => {
      calls += 1;
      const signal = (limits as typeof limits & { signal?: AbortSignal }).signal;
      const delayMs = calls === 1 ? 5 : 250;
      activeTimers += 1;
      const timer = setTimeout(() => {
        activeTimers -= 1;
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(calls === 1
          ? response(302, "", { location: "/acm/problem/218144" })
          : response(200, "<html></html>", { "content-type": "text/html" }));
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        activeTimers -= 1;
        aborts += 1;
        reject(signal?.reason ?? new Error("aborted"));
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
    const client = new NowCoderPageClient({ requester, timeoutMs: 80 });
    const pending = expect(client.getProblemPage("https://ac.nowcoder.com/acm/problem/218143")).rejects.toMatchObject({
      code: "network.timeout"
    });
    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(75);
    await pending;

    expect(calls).toBe(2);
    expect(aborts).toBe(1);
    expect(activeTimers).toBe(0);
  });

  test("classifies fixture challenge, 404, and rate-limit responses", async () => {
    const [challenge, notFound, rateLimit] = await Promise.all([
      loadFixture("challenge.html"),
      loadFixture("not-found.html"),
      loadFixture("rate-limit.html")
    ]);
    const url = "https://ac.nowcoder.com/acm/problem/218144";

    await expect(new NowCoderPageClient({
      requester: sequenceRequester([response(200, challenge, { "content-type": "text/html" })])
    }).getProblemPage(url)).rejects.toMatchObject({ code: "challenge.required" });
    await expect(new NowCoderPageClient({
      requester: sequenceRequester([response(404, notFound, { "content-type": "text/html" })])
    }).getProblemPage(url)).rejects.toMatchObject({ code: "resource.not_found", options: { httpStatus: 404 } });
    await expect(new NowCoderPageClient({
      requester: sequenceRequester([response(429, rateLimit, { "content-type": "text/html", "retry-after": "3" })])
    }).getProblemPage(url)).rejects.toMatchObject({ code: "rate_limited", options: { httpStatus: 429, retryAfterMs: 3000 } });
  });

  test.each([Number.NaN, 99, 600, Number.POSITIVE_INFINITY])(
    "rejects invalid HTTP status %s without emitting invalid metadata",
    async (status) => {
      const url = "https://ac.nowcoder.com/acm/problem/218144";
      await expect(new NowCoderPageClient({
        requester: sequenceRequester([response(status, "", { "content-type": "text/html" })])
      }).getProblemPage(url)).rejects.toMatchObject({ code: "upstream.unavailable", options: {} });
    }
  );

  test("clamps finite Retry-After metadata", async () => {
    const url = "https://ac.nowcoder.com/acm/problem/218144";
    await expect(new NowCoderPageClient({
      requester: sequenceRequester([response(429, "", { "retry-after": "999999999" })])
    }).getProblemPage(url)).rejects.toMatchObject({
      code: "rate_limited",
      options: { httpStatus: 429, retryAfterMs: 86_400_000 }
    });
  });

  test("treats non-HTML success responses as schema drift", async () => {
    const client = new NowCoderPageClient({
      requester: sequenceRequester([response(200, "{}", { "content-type": "application/json" })])
    });

    await expect(client.getProblemPage("https://ac.nowcoder.com/acm/problem/218144")).rejects.toMatchObject({
      code: "upstream.schema_changed"
    });
  });
});

describe("isPublicIpAddress", () => {
  test.each([
    "93.184.216.34",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "64:ff9b::5db8:d822",
    "2002:5db8:d822::1"
  ])("accepts a public unicast address: %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(true);
  });

  test.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.31.196.1",
    "192.52.193.1",
    "192.88.99.1",
    "192.168.1.1",
    "192.175.48.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "0.0.0.0",
    "::1",
    "0:0:0:0:0:0:0:1",
    "64:ff9b::7f00:1",
    "64:ff9b::a00:1",
    "64:ff9b:1::1",
    "100::1",
    "100:0:0:1::1",
    "2001::1",
    "2001:2::1",
    "2001:10::1",
    "2001:20::1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "2001:db8::1",
    "2002:7f00:1::1",
    "2002:a00:1::1",
    "3fff::1",
    "5f00::1",
    "::ffff:93.184.216.34",
    "::ffff:127.0.0.1",
    "0:0:0:0:0:ffff:7f00:1"
  ])("rejects a loopback, private, link-local, documentation, or mapped-private address: %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });
});

function response(status: number, body: string, headers: Record<string, string> = {}): NowCoderHttpResponse {
  return { status, body, headers };
}

function sequenceRequester(responses: NowCoderHttpResponse[], calls: string[] = []): NowCoderHttpRequester {
  let index = 0;
  return async (url) => {
    calls.push(url.href);
    const current = responses[index];
    index += 1;
    if (!current) throw new Error("Unexpected test request");
    return current;
  };
}
