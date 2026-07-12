import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
  createNodeHttpsSocketOpener,
  createPinnedHttpsRequester,
  createSystemHostResolver,
  type NowCoderPinnedSocketRequest,
  type NowCoderPinnedSocketResponse,
  type NowCoderNodeHttpsSocketOptions,
  type NowCoderRequestContext,
  type NowCoderResolvedAddress
} from "../src/client.js";

describe("pinned HTTPS transport", () => {
  test("passes every prevalidated dual-stack address and the original hostname to the socket", async () => {
    const observed: NowCoderPinnedSocketRequest[] = [];
    const addresses: NowCoderResolvedAddress[] = [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 }
    ];
    const requester = createPinnedHttpsRequester({
      resolver: async (hostname) => {
        expect(hostname).toBe("ac.nowcoder.com");
        return addresses;
      },
      openSocket: async (request) => {
        observed.push(request);
        return streamResponse(["<html>", "ok</html>"]);
      }
    });

    await expect(requester(new URL("https://ac.nowcoder.com/acm/problem/1"), requestContext())).resolves.toMatchObject({
      status: 200,
      body: "<html>ok</html>"
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ serverName: "ac.nowcoder.com", addresses });
    expect(observed[0]?.url.href).toBe("https://ac.nowcoder.com/acm/problem/1");
  });

  test("rejects the complete DNS answer set before opening a socket when any answer is non-public", async () => {
    const openSocket = vi.fn<(request: NowCoderPinnedSocketRequest) => Promise<NowCoderPinnedSocketResponse>>();
    const requester = createPinnedHttpsRequester({
      resolver: async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "127.0.0.1", family: 4 }
      ],
      openSocket
    });

    await expect(requester(new URL("https://ac.nowcoder.com/acm/problem/1"), requestContext())).rejects.toMatchObject({
      code: "policy.blocked"
    });
    expect(openSocket).not.toHaveBeenCalled();
  });

  test("stops streaming at the byte limit and closes the socket exactly once", async () => {
    let closes = 0;
    const requester = createPinnedHttpsRequester({
      resolver: async () => [{ address: "1.1.1.1", family: 4 }],
      openSocket: async () => ({
        ...streamResponse(["1234", "5678"]),
        close: () => { closes += 1; }
      })
    });

    await expect(requester(
      new URL("https://ac.nowcoder.com/acm/problem/1"),
      requestContext({ maxBytes: 5 })
    )).rejects.toMatchObject({ code: "upstream.unavailable" });
    expect(closes).toBe(1);
  });

  test("aborts a pending body read and releases iterator and socket resources", async () => {
    let closes = 0;
    let returns = 0;
    let bodyReadStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { bodyReadStarted = resolve; });
    const requester = createPinnedHttpsRequester({
      resolver: async () => [{ address: "1.1.1.1", family: 4 }],
      openSocket: async () => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: {
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                bodyReadStarted();
                return new Promise<IteratorResult<Uint8Array>>(() => undefined);
              },
              return: async () => {
                returns += 1;
                return { done: true, value: undefined };
              }
            };
          }
        },
        close: () => { closes += 1; }
      })
    });
    const controller = new AbortController();
    const pending = requester(
      new URL("https://ac.nowcoder.com/acm/problem/1"),
      requestContext({ signal: controller.signal })
    );
    await started;

    controller.abort(new DOMException("deadline", "TimeoutError"));

    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(returns).toBe(1);
    expect(closes).toBe(1);
  });

  test("cancels Resolver work when the shared request signal aborts", async () => {
    let reject4: (reason: unknown) => void = () => undefined;
    let reject6: (reason: unknown) => void = () => undefined;
    let cancels = 0;
    const resolver = createSystemHostResolver(() => ({
      resolve4: async () => new Promise<string[]>((_resolve, reject) => { reject4 = reject; }),
      resolve6: async () => new Promise<string[]>((_resolve, reject) => { reject6 = reject; }),
      cancel: () => {
        cancels += 1;
        const error = Object.assign(new Error("cancelled"), { code: "ECANCELLED" });
        reject4(error);
        reject6(error);
      }
    }));
    const controller = new AbortController();
    const pending = resolver("ac.nowcoder.com", controller.signal);

    controller.abort(new DOMException("deadline", "TimeoutError"));

    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(cancels).toBe(1);
  });

  test("configures Node TLS with hostname verification, SNI, and all pinned fallback addresses", async () => {
    let requestOptions: Record<string, unknown> | undefined;
    const requestImpl = (options: Record<string, unknown>, onResponse: (response: Readable & {
      statusCode: number;
      headers: Record<string, string>;
    }) => void) => {
      requestOptions = options;
      const request = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
      request.end = () => {
        const response = Readable.from([Buffer.from("ok")]) as Readable & {
          statusCode: number;
          headers: Record<string, string>;
        };
        response.statusCode = 200;
        response.headers = { "content-type": "text/html" };
        onResponse(response);
      };
      request.destroy = () => undefined;
      return request;
    };
    const openSocket = createNodeHttpsSocketOpener({
      requestImpl: requestImpl as unknown as NonNullable<NowCoderNodeHttpsSocketOptions["requestImpl"]>
    });
    const controller = new AbortController();
    const response = await openSocket({
      url: new URL("https://ac.nowcoder.com/acm/problem/1"),
      serverName: "ac.nowcoder.com",
      addresses: [
        { address: "2606:4700:4700::1111", family: 6 },
        { address: "1.1.1.1", family: 4 }
      ],
      signal: controller.signal
    });

    expect(requestOptions).toMatchObject({
      hostname: "ac.nowcoder.com",
      servername: "ac.nowcoder.com",
      rejectUnauthorized: true,
      autoSelectFamily: true
    });
    const lookup = requestOptions?.lookup as (
      hostname: string,
      options: { all: true },
      callback: (...args: unknown[]) => void
    ) => void;
    const callback = vi.fn();
    lookup("ac.nowcoder.com", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 }
    ]);
    response.close();
  });
});

function requestContext(overrides: Partial<NowCoderRequestContext> = {}): NowCoderRequestContext {
  return { timeoutMs: 1_000, maxBytes: 1_000, signal: new AbortController().signal, ...overrides };
}

function streamResponse(chunks: string[]): NowCoderPinnedSocketResponse {
  return {
    status: 200,
    headers: { "content-type": "text/html" },
    body: (async function* () {
      for (const chunk of chunks) yield Buffer.from(chunk);
    })(),
    close: () => undefined
  };
}
