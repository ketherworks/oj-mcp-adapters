import { describe, expect, test } from "vitest";
import worker from "../src/worker.js";
import { CODEFORCES_MCP_TOOL_NAMES } from "../src/server.js";

describe("Codeforces Cloudflare Worker", () => {
  test("publishes a public health document without requiring a key", async () => {
    const response = await worker.fetch(new Request("https://example.com/healthz"), {} as never);
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ mcpEndpoint: "/mcp", authentication: "none" });
  });

  test("lists only approved read tools over stateless Streamable HTTP", async () => {
    const response = await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }), {} as never);
    const body = await parseMcpResponse(response);

    expect(response.status).toBe(200);
    expect(body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...CODEFORCES_MCP_TOOL_NAMES].sort());
    expect(body.result.tools.some((tool: { name: string }) => /submit|run/i.test(tool.name))).toBe(false);
  });

  test("rejects browser origins unless explicitly allowed", async () => {
    const request = mcpRequest({}, { origin: "https://evil.example" });
    const response = await worker.fetch(request, {} as never);

    expect(response.status).toBe(403);
  });
});

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

async function parseMcpResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return JSON.parse(text);
  }
  const dataLines = text.split("\n").filter((line) => line.startsWith("data: ") && line.length > 6);
  return JSON.parse(dataLines.at(-1)!.slice(6));
}
