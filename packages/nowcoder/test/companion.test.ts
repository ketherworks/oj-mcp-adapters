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
    expect(preview).toMatchObject({
      schemaVersion: "oj.import-preview/v1",
      windowId: window.windowId,
      receivedAt: "2026-07-14T15:00:00.000Z",
      document: { ref: { nativeId: "NC286185" } }
    });
    await expect(fetch(window.endpoint!)).rejects.toBeDefined();
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
});
