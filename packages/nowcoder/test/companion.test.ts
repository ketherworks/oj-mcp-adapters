import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { CompetitiveCompanionImporter, parseCompetitiveCompanionTask } from "../src/companion.js";

const task = {
  name: "小红的二分图构造",
  group: "NowCoder",
  url: "https://ac.nowcoder.com/acm/problem/286185",
  interactive: false,
  memoryLimit: 256,
  timeLimit: 2_000,
  tests: [
    { input: "3\n", output: "YES\n" },
    { input: "4\n", output: "NO\n" }
  ],
  testType: "single",
  input: { type: "stdin" },
  output: { type: "stdout" },
  languages: { java: { mainClass: "Main", taskClass: "Task" } },
  batch: { id: "fixture-batch", size: 1 }
};

async function connectPartialBody(endpoint: string): Promise<Socket> {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    const onError = (error: Error) => reject(error);
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      socket.on("error", () => undefined);
      socket.write([
        "POST / HTTP/1.1",
        `Host: ${url.host}`,
        "Content-Type: application/json",
        "Content-Length: 1000000",
        "Connection: keep-alive",
        "",
        "{"
      ].join("\r\n"));
      resolve(socket);
    });
  });
}

function waitForSocketClose(socket: Socket, timeoutMs: number): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Socket remained open for more than ${timeoutMs}ms.`));
    }, timeoutMs);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

describe("Competitive Companion import", () => {
  const importers: CompetitiveCompanionImporter[] = [];
  afterEach(async () => {
    await Promise.all(importers.map((importer) => importer.dispose()));
  });

  test("normalizes the official JSON format into an OJ problem document", () => {
    const document = parseCompetitiveCompanionTask(task, "2026-07-14T15:00:00.000Z");

    expect(document).toMatchObject({
      schemaVersion: "oj.problem-document/v1",
      ref: {
        platform: "nowcoder",
        nativeId: "NC286185",
        url: "https://ac.nowcoder.com/acm/problem/286185"
      },
      title: "小红的二分图构造",
      samples: [
        { ordinal: 1, input: "3\n", output: "YES\n" },
        { ordinal: 2, input: "4\n", output: "NO\n" }
      ],
      limits: { timeMs: 2_000, memoryBytes: 268_435_456 },
      io: { mode: "stdin_stdout" },
      source: { kind: "browser_companion", confidence: "user_supplied" }
    });
  });

  test("opens one loopback window and completes it after a browser POST", async () => {
    const importer = new CompetitiveCompanionImporter({
      port: 0,
      nowIso: () => "2026-07-14T15:00:00.000Z"
    });
    importers.push(importer);

    const window = await importer.open({
      schemaVersion: "oj.import-window-request/v1",
      requestId: "import-1",
      allowedPlatforms: ["nowcoder"],
      expiresInMs: 10_000
    });
    const response = await fetch(window.endpoint!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(task)
    });
    const preview = await importer.complete(window.windowId);

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(preview).toMatchObject({
      schemaVersion: "oj.import-preview/v1",
      windowId: window.windowId,
      receivedAt: "2026-07-14T15:00:00.000Z",
      document: { ref: { nativeId: "NC286185" } }
    });
    await expect(fetch(window.endpoint!)).rejects.toBeDefined();
  });

  test("reserves the listener before the asynchronous bind completes", async () => {
    const importer = new CompetitiveCompanionImporter({ port: 0 });
    importers.push(importer);
    const request = {
      schemaVersion: "oj.import-window-request/v1" as const,
      requestId: "import-concurrent",
      allowedPlatforms: ["nowcoder" as const],
      expiresInMs: 10_000
    };

    const first = importer.open(request);
    await expect(importer.open({ ...request, requestId: "import-concurrent-2" }))
      .rejects.toMatchObject({ code: "policy.blocked" });
    await expect(first).resolves.toMatchObject({ state: "waiting" });
  });

  test("allows extension origins without using a wildcard", async () => {
    const importer = new CompetitiveCompanionImporter({ port: 0 });
    importers.push(importer);
    const window = await importer.open({
      schemaVersion: "oj.import-window-request/v1",
      requestId: "import-extension-origin",
      allowedPlatforms: ["nowcoder"],
      expiresInMs: 10_000
    });

    for (const origin of ["chrome-extension://abcdefghijklmnop", "moz-extension://12345678-abcd-4321-abcd-1234567890ab"]) {
      const response = await fetch(window.endpoint!, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type"
        }
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
      expect(response.headers.get("vary")).toBe("Origin");
    }

    const origin = "chrome-extension://abcdefghijklmnop";
    const response = await fetch(window.endpoint!, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(task)
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    await expect(importer.complete(window.windowId)).resolves.toMatchObject({
      document: { ref: { platform: "nowcoder" } }
    });
  });

  test("rejects http and https browser origins without consuming the window", async () => {
    const importer = new CompetitiveCompanionImporter({ port: 0 });
    importers.push(importer);
    const window = await importer.open({
      schemaVersion: "oj.import-window-request/v1",
      requestId: "import-web-origin",
      allowedPlatforms: ["nowcoder"],
      expiresInMs: 10_000
    });

    for (const origin of ["http://localhost:3000", "https://attacker.example"]) {
      const rejected = await fetch(window.endpoint!, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(task)
      });
      expect(rejected.status).toBe(403);
      expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
    }

    const accepted = await fetch(window.endpoint!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(task)
    });
    expect(accepted.status).toBe(200);
    await expect(importer.complete(window.windowId)).resolves.toMatchObject({
      document: { ref: { platform: "nowcoder" } }
    });
  });

  test("rejects non-NowCoder payloads without consuming the window", async () => {
    const importer = new CompetitiveCompanionImporter({ port: 0 });
    importers.push(importer);
    const window = await importer.open({
      schemaVersion: "oj.import-window-request/v1",
      requestId: "import-2",
      allowedPlatforms: ["nowcoder"],
      expiresInMs: 10_000
    });

    const bad = await fetch(window.endpoint!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...task, url: "https://codeforces.com/problemset/problem/1/A" })
    });
    const good = await fetch(window.endpoint!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(task)
    });

    expect(bad.status).toBe(422);
    expect(good.status).toBe(200);
    await expect(importer.complete(window.windowId)).resolves.toMatchObject({
      document: { ref: { platform: "nowcoder" } }
    });
  });

  test("closes a trickled request at the body deadline without consuming the window", async () => {
    const importer = new CompetitiveCompanionImporter({ port: 0 });
    importers.push(importer);
    const window = await importer.open({
      schemaVersion: "oj.import-window-request/v1",
      requestId: "import-body-timeout",
      allowedPlatforms: ["nowcoder"],
      expiresInMs: 10_000
    });
    const socket = await connectPartialBody(window.endpoint!);
    const trickle = setInterval(() => {
      if (!socket.destroyed) socket.write(" ");
    }, 250);

    try {
      await waitForSocketClose(socket, 3_500);
    } finally {
      clearInterval(trickle);
    }

    const accepted = await fetch(window.endpoint!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(task)
    });
    expect(accepted.status).toBe(200);
    await expect(importer.complete(window.windowId)).resolves.toMatchObject({
      document: { ref: { nativeId: "NC286185" } }
    });
  }, 6_000);

  test("expiry force-closes active connections and does not block the next open", async () => {
    const importer = new CompetitiveCompanionImporter({ port: 0 });
    importers.push(importer);
    const first = await importer.open({
      schemaVersion: "oj.import-window-request/v1",
      requestId: "import-expiring",
      allowedPlatforms: ["nowcoder"],
      expiresInMs: 250
    });
    const socket = await connectPartialBody(first.endpoint!);

    await waitForSocketClose(socket, 1_500);
    const second = await importer.open({
      schemaVersion: "oj.import-window-request/v1",
      requestId: "import-after-expiry",
      allowedPlatforms: ["nowcoder"],
      expiresInMs: 10_000
    });

    expect(second.windowId).not.toBe(first.windowId);
    await expect(importer.complete(first.windowId)).rejects.toMatchObject({ code: "network.timeout" });
  });

  test("dispose force-closes active connections", async () => {
    const importer = new CompetitiveCompanionImporter({ port: 0 });
    importers.push(importer);
    const window = await importer.open({
      schemaVersion: "oj.import-window-request/v1",
      requestId: "import-dispose",
      allowedPlatforms: ["nowcoder"],
      expiresInMs: 10_000
    });
    const socket = await connectPartialBody(window.endpoint!);

    await importer.dispose();
    await waitForSocketClose(socket, 500);
  });
});
