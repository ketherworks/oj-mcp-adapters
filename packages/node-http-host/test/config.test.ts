import { describe, expect, test } from "vitest";
import { createHostedWorker, parseHostConfig } from "../src/config.js";

describe("parseHostConfig", () => {
  test("accepts only the audited remote page providers", () => {
    expect(
      parseHostConfig(["atcoder"], {
        OJ_MCP_HOST: "127.0.0.1",
        OJ_MCP_PORT: "39101",
        OJ_MCP_INTERNAL_KEY: "correct-horse-battery-staple",
        ATCODER_MCP_ALLOWED_ORIGINS: "https://example.test"
      })
    ).toEqual({
      provider: "atcoder",
      host: "127.0.0.1",
      port: 39101,
      internalKey: "correct-horse-battery-staple",
      workerEnv: { ATCODER_MCP_ALLOWED_ORIGINS: "https://example.test" }
    });
    expect(() => parseHostConfig(["nowcoder"], {})).toThrow(/atcoder or luogu/i);
  });

  test("fails closed on invalid ports and short internal keys", () => {
    expect(() => parseHostConfig(["luogu"], { OJ_MCP_PORT: "0" })).toThrow(/port/i);
    expect(() => parseHostConfig(["luogu"], { OJ_MCP_PORT: "39102", OJ_MCP_INTERNAL_KEY: "short" })).toThrow(
      /24 characters/i
    );
  });
});

describe("createHostedWorker", () => {
  test.each(["atcoder", "luogu"] as const)("creates the %s Web worker without adding tools", async (provider) => {
    const worker = createHostedWorker(provider);
    const response = await worker.fetch(new Request("http://127.0.0.1/healthz"), {});
    const health = (await response.json()) as { name: string; tools: string[] };

    expect(response.status).toBe(200);
    expect(health.name).toContain(provider);
    expect(health.tools).toHaveLength(4);
  });
});
