import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { RequestListener } from "node:http";
import { createServer, request as httpsRequest } from "node:https";
import { Socket, type AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";
import {
  createNodeHttpsSocketOpener,
  requestValidatedPinnedHttps,
  type NowCoderNodeHttpsSocketOptions,
  type NowCoderRequestContext,
  type NowCoderResolvedAddress
} from "../src/client.js";

const [testKey, testCertificate, wrongHostKey, wrongHostCertificate] = await Promise.all([
  readFile(new URL("./fixtures/tls/ac.nowcoder.test-key.pem", import.meta.url), "utf8"),
  readFile(new URL("./fixtures/tls/ac.nowcoder.test-cert.pem", import.meta.url), "utf8"),
  readFile(new URL("./fixtures/tls/wrong-host.test-key.pem", import.meta.url), "utf8"),
  readFile(new URL("./fixtures/tls/wrong-host.test-cert.pem", import.meta.url), "utf8")
]);

const ipv4OnlyFallback: NowCoderResolvedAddress[] = [
  { address: "::1", family: 6 },
  { address: "127.0.0.1", family: 4 }
];

describe("production HTTPS socket transport", () => {
  test("uses pinned A/AAAA fallback while preserving certificate hostname verification and SNI", async () => {
    const local = await startTlsServer((_request, response) => response.end("local tls ok"));
    let serverName: string | false | undefined;
    const attemptedAddresses: string[] = [];
    const failedAddresses: string[] = [];
    const originalEmit = Socket.prototype.emit;
    Socket.prototype.emit = function observedEmit(this: Socket, event: string | symbol, ...args: unknown[]): boolean {
      if (event === "connectionAttempt") attemptedAddresses.push(String(args[0]));
      if (event === "connectionAttemptFailed") failedAddresses.push(String(args[0]));
      return Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
    } as typeof Socket.prototype.emit;
    local.server.on("secureConnection", (socket) => {
      serverName = (socket as typeof socket & { servername?: string | false }).servername;
    });
    try {
      const result = await requestValidatedPinnedHttps(
        new URL("https://ac.nowcoder.com/acm/problem/1"),
        requestContext(),
        ipv4OnlyFallback,
        createNodeHttpsSocketOpener({
          ca: testCertificate,
          port: local.port,
          autoSelectFamilyAttemptTimeoutMs: 10
        })
      );

      expect(result).toMatchObject({ status: 200, body: "local tls ok" });
      expect(serverName).toBe("ac.nowcoder.com");
      expect(local.acceptedAddresses).toEqual(["127.0.0.1"]);
      expect(attemptedAddresses).toEqual(["::1", "127.0.0.1"]);
      expect(failedAddresses).toEqual(["::1"]);
    } finally {
      Socket.prototype.emit = originalEmit;
      await local.close();
    }
  });

  test("rejects a trusted certificate whose hostname does not match the original URL", async () => {
    const local = await startTlsServer(
      (_request, response) => response.end("must not be accepted"),
      { key: wrongHostKey, cert: wrongHostCertificate }
    );
    try {
      await expect(requestValidatedPinnedHttps(
        new URL("https://ac.nowcoder.com/acm/problem/1"),
        requestContext(),
        [{ address: "127.0.0.1", family: 4 }],
        createNodeHttpsSocketOpener({ ca: wrongHostCertificate, port: local.port })
      )).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    } finally {
      await local.close();
    }
  });

  test("aborting a real streaming response destroys the request and response socket", async () => {
    let clientSocket: Socket | undefined;
    let responseSocket: Socket | undefined;
    let requestStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const local = await startTlsServer((_request, response) => {
      responseSocket = response.socket ?? undefined;
      response.writeHead(200, { "content-type": "text/html" });
      response.write("partial");
      requestStarted();
    });
    const controller = new AbortController();
    try {
      const pending = requestValidatedPinnedHttps(
        new URL("https://ac.nowcoder.com/acm/problem/1"),
        requestContext({ signal: controller.signal }),
        [{ address: "127.0.0.1", family: 4 }],
        createNodeHttpsSocketOpener({
          ca: testCertificate,
          port: local.port,
          requestImpl: observeClientSocket((socket) => { clientSocket = socket; })
        })
      );
      await started;

      controller.abort(new DOMException("test deadline", "TimeoutError"));

      await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      await local.allSocketsClosed;
      expect(clientSocket?.destroyed).toBe(true);
      expect(responseSocket?.destroyed).toBe(true);
      expect(await connectionCount(local.server)).toBe(0);
    } finally {
      await local.close();
    }
  });

  test("overflow on a real streaming response destroys the request and response socket", async () => {
    let clientSocket: Socket | undefined;
    let responseSocket: Socket | undefined;
    const local = await startTlsServer((_request, response) => {
      responseSocket = response.socket ?? undefined;
      response.writeHead(200, { "content-type": "text/html" });
      response.write(Buffer.alloc(1_024, "x"));
    });
    try {
      await expect(requestValidatedPinnedHttps(
        new URL("https://ac.nowcoder.com/acm/problem/1"),
        requestContext({ maxBytes: 8 }),
        [{ address: "127.0.0.1", family: 4 }],
        createNodeHttpsSocketOpener({
          ca: testCertificate,
          port: local.port,
          requestImpl: observeClientSocket((socket) => { clientSocket = socket; })
        })
      )).rejects.toMatchObject({ code: "upstream.unavailable" });
      await local.allSocketsClosed;
      expect(clientSocket?.destroyed).toBe(true);
      expect(responseSocket?.destroyed).toBe(true);
      expect(await connectionCount(local.server)).toBe(0);
    } finally {
      await local.close();
    }
  });
});

async function startTlsServer(
  listener: RequestListener,
  credentials: { key: string; cert: string } = { key: testKey, cert: testCertificate }
): Promise<{
  server: ReturnType<typeof createServer>;
  port: number;
  acceptedAddresses: string[];
  allSocketsClosed: Promise<void>;
  close(): Promise<void>;
}> {
  const server = createServer(credentials, listener);
  const acceptedAddresses: string[] = [];
  const sockets = new Set<Socket>();
  let resolveAllSocketsClosed: () => void = () => undefined;
  const allSocketsClosed = new Promise<void>((resolve) => { resolveAllSocketsClosed = resolve; });
  server.on("connection", (socket) => {
    const networkSocket = socket as Socket;
    acceptedAddresses.push(networkSocket.localAddress ?? "");
    sockets.add(networkSocket);
    networkSocket.once("close", () => {
      sockets.delete(networkSocket);
      if (sockets.size === 0) resolveAllSocketsClosed();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    acceptedAddresses,
    allSocketsClosed,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

function requestContext(overrides: Partial<NowCoderRequestContext> = {}): NowCoderRequestContext {
  return { timeoutMs: 1_000, maxBytes: 4_096, signal: new AbortController().signal, ...overrides };
}

function connectionCount(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count)));
}

function observeClientSocket(
  observer: (socket: Socket) => void
): NonNullable<NowCoderNodeHttpsSocketOptions["requestImpl"]> {
  return (options, onResponse) => {
    const request = httpsRequest(options, onResponse);
    request.once("socket", observer);
    return request;
  };
}
