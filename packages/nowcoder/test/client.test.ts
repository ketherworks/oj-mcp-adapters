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
    const client = new NowCoderPageClient({
      requester: sequenceRequester([response(302, "", { location: "https://127.0.0.1/admin" })])
    });

    await expect(client.getProblemPage("https://ac.nowcoder.com/acm/problem/218144")).rejects.toMatchObject({
      code: "policy.blocked"
    });
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
