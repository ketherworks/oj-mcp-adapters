import { describe, expect, test } from "vitest";
import { AtCoderHtmlClient, parseAtCoderTaskUrl } from "../src/client.js";

describe("AtCoderHtmlClient", () => {
  test("fetches a canonical task URL from the official HTTPS host with an explicit locale", async () => {
    let requestedUrl = "";
    const client = new AtCoderHtmlClient({
      fetchImpl: async (input) => {
        requestedUrl = String(input);
        return new Response("<html></html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
    });

    await client.fetchTask({ contestId: "abc086", taskId: "abc086_a", locale: "en" });

    expect(requestedUrl).toBe("https://atcoder.jp/contests/abc086/tasks/abc086_a?lang=en");
  });

  test("accepts a canonical AtCoder task URL and reads its supported locale", () => {
    expect(parseAtCoderTaskUrl("https://atcoder.jp/contests/arc065/tasks/arc065_a?lang=ja")).toEqual({
      contestId: "arc065",
      taskId: "arc065_a",
      locale: "ja"
    });
  });

  test.each([
    "http://atcoder.jp/contests/abc086/tasks/abc086_a",
    "https://atcoder.jp.evil.example/contests/abc086/tasks/abc086_a",
    "https://127.0.0.1/contests/abc086/tasks/abc086_a",
    "https://atcoder.jp/contests/abc086/tasks/abc086_a/extra",
    "https://atcoder.jp/contests/abc086/tasks/abc086_a?next=https://127.0.0.1",
    "https://atcoder.jp/contests/abc086/tasks/abc086_a?lang=en&lang=ja"
  ])("rejects non-canonical or non-allowlisted task URL %s", (url) => {
    expect(() => parseAtCoderTaskUrl(url)).toThrow("canonical");
  });

  test("maps a missing official task page to resource_not_found", async () => {
    const client = new AtCoderHtmlClient({
      fetchImpl: async () => new Response("not found", { status: 404 })
    });

    await expect(client.fetchTask({ contestId: "abc999", taskId: "abc999_z", locale: "en" })).rejects.toMatchObject({
      code: "resource.not_found",
      httpStatus: 404
    });
  });

  test("maps AtCoder rate limits with a Retry-After delay", async () => {
    const client = new AtCoderHtmlClient({
      fetchImpl: async () => new Response("slow down", { status: 429, headers: { "Retry-After": "3" } })
    });

    await expect(client.fetchTask({ contestId: "abc086", taskId: "abc086_a", locale: "en" })).rejects.toMatchObject({
      code: "rate_limited",
      httpStatus: 429,
      retryAfterMs: 3_000
    });
  });

  test("blocks redirects away from the canonical AtCoder task allowlist", async () => {
    let requests = 0;
    const client = new AtCoderHtmlClient({
      fetchImpl: async () => {
        requests += 1;
        return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/private" } });
      }
    });

    await expect(client.fetchTask({ contestId: "abc086", taskId: "abc086_a", locale: "en" })).rejects.toMatchObject({
      code: "policy.blocked"
    });
    expect(requests).toBe(1);
  });

  test("caps same-task redirects at two", async () => {
    let requests = 0;
    const client = new AtCoderHtmlClient({
      fetchImpl: async () => {
        requests += 1;
        return new Response(null, {
          status: 302,
          headers: { Location: "https://atcoder.jp/contests/abc086/tasks/abc086_a?lang=en" }
        });
      }
    });

    await expect(client.fetchTask({ contestId: "abc086", taskId: "abc086_a", locale: "en" })).rejects.toMatchObject({
      code: "upstream.unavailable"
    });
    expect(requests).toBe(3);
  });

  test("rejects an HTML response whose declared size exceeds the configured limit", async () => {
    const client = new AtCoderHtmlClient({
      maxResponseBytes: 8,
      fetchImpl: async () =>
        new Response("123456789", {
          status: 200,
          headers: { "Content-Type": "text/html", "Content-Length": "9" }
        })
    });

    await expect(client.fetchTask({ contestId: "abc086", taskId: "abc086_a", locale: "en" })).rejects.toMatchObject({
      code: "upstream.unavailable"
    });
  });

  test("stops reading an HTML stream when its actual size exceeds the configured limit", async () => {
    const client = new AtCoderHtmlClient({
      maxResponseBytes: 8,
      fetchImpl: async () => new Response("123456789", { status: 200, headers: { "Content-Type": "text/html" } })
    });

    await expect(client.fetchTask({ contestId: "abc086", taskId: "abc086_a", locale: "en" })).rejects.toMatchObject({
      code: "upstream.unavailable"
    });
  });

  test("aborts an upstream request at the configured timeout", async () => {
    const client = new AtCoderHtmlClient({
      timeoutMs: 1,
      fetchImpl: async (_input, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("missing abort signal");
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    });

    await expect(client.fetchTask({ contestId: "abc086", taskId: "abc086_a", locale: "en" })).rejects.toMatchObject({
      code: "network.timeout",
      transportCause: "timeout"
    });
  });

  test("keeps the timeout active while streaming the HTML body", async () => {
    const client = new AtCoderHtmlClient({
      timeoutMs: 1,
      fetchImpl: async (_input, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("missing abort signal");
        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
              setTimeout(() => controller.error(new Error("body timeout was not kept active")), 25);
            }
          }),
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }
    });

    await expect(client.fetchTask({ contestId: "abc086", taskId: "abc086_a", locale: "en" })).rejects.toMatchObject({
      code: "network.timeout"
    });
  });

  test("rejects a successful response that is not HTML", async () => {
    const client = new AtCoderHtmlClient({
      fetchImpl: async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
    });

    await expect(client.fetchTask({ contestId: "abc086", taskId: "abc086_a", locale: "en" })).rejects.toMatchObject({
      code: "upstream.schema_changed"
    });
  });

  test("maps an upstream service failure without parsing its body", async () => {
    const client = new AtCoderHtmlClient({
      fetchImpl: async () => new Response("maintenance", { status: 503, headers: { "Content-Type": "text/html" } })
    });

    await expect(client.fetchTask({ contestId: "abc086", taskId: "abc086_a", locale: "en" })).rejects.toMatchObject({
      code: "upstream.unavailable",
      httpStatus: 503
    });
  });

  test.each([404, 429, 503])("cancels the unconsumed response body for HTTP %s", async (status) => {
    let cancelled = 0;
    const client = new AtCoderHtmlClient({
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull() {},
            cancel() {
              cancelled += 1;
            }
          }),
          { status }
        )
    });

    await expect(client.fetchTask({ contestId: "abc086", taskId: "abc086_a", locale: "en" })).rejects.toBeInstanceOf(
      Error
    );
    expect(cancelled).toBe(1);
  });

  test("cancels a redirect response before following it", async () => {
    let cancelled = 0;
    let requests = 0;
    const client = new AtCoderHtmlClient({
      fetchImpl: async () => {
        requests += 1;
        if (requests === 1) {
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled += 1;
              }
            }),
            { status: 302, headers: { Location: "https://atcoder.jp/contests/abc086/tasks/abc086_a?lang=en" } }
          );
        }
        return new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } });
      }
    });

    await client.fetchTask({ contestId: "abc086", taskId: "abc086_a", locale: "en" });
    expect(cancelled).toBe(1);
  });

  test("composes caller cancellation with the client timeout signal", async () => {
    const caller = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    const client = new AtCoderHtmlClient({
      timeoutMs: 10_000,
      fetchImpl: async (_input, init) => {
        upstreamSignal = init?.signal ?? undefined;
        await new Promise<never>((_resolve, reject) => {
          upstreamSignal!.addEventListener("abort", () => reject(upstreamSignal!.reason), { once: true });
        });
      }
    });

    const pending = client.fetchTask({ contestId: "abc086", taskId: "abc086_a", locale: "en" }, caller.signal);
    caller.abort(new DOMException("caller cancelled", "AbortError"));

    await expect(pending).rejects.toMatchObject({ code: "network.timeout", transportCause: "consumer_cancelled" });
    expect(upstreamSignal?.aborted).toBe(true);
  });

  test("rejects a non-supported locale before making a request", async () => {
    let requests = 0;
    const client = new AtCoderHtmlClient({
      fetchImpl: async () => {
        requests += 1;
        return new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } });
      }
    });

    await expect(
      client.fetchTask({ contestId: "abc086", taskId: "abc086_a", locale: "fr" as never })
    ).rejects.toThrow("locale");
    expect(requests).toBe(0);
  });
});
