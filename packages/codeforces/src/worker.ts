import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CodeforcesApiClient } from "./client.js";
import { CodeforcesCoordinator } from "./coordinator.js";
import { CodeforcesProvider } from "./provider.js";
import { CodeforcesRateLimiter } from "./rateLimiter.js";
import { CODEFORCES_MCP_TOOL_NAMES, createCodeforcesMcpServer } from "./server.js";

interface CoordinatorStub {
  fetch(request: Request): Promise<Response>;
}

interface CoordinatorNamespace {
  getByName(name: string): CoordinatorStub;
}

export interface CodeforcesWorkerEnv {
  CODEFORCES_COORDINATOR?: CoordinatorNamespace;
  CODEFORCES_MCP_ALLOWED_ORIGINS?: string;
}

const MCP_PATH = "/mcp";
const CORS_HEADERS = "content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id";

const worker = {
  async fetch(request: Request, env: CodeforcesWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/healthz") {
      return jsonResponse({
        name: "codeforces-mcp-server",
        transport: "streamable-http",
        mcpEndpoint: MCP_PATH,
        authentication: "none",
        tools: CODEFORCES_MCP_TOOL_NAMES
      });
    }
    if (url.pathname !== MCP_PATH) {
      return jsonResponse({ error: "Not found", mcpEndpoint: MCP_PATH }, 404);
    }
    if (request.method === "OPTIONS") {
      const originError = validateOrigin(request, env);
      return originError ?? new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    const originError = validateOrigin(request, env);
    if (originError) {
      return originError;
    }

    const provider = new CodeforcesProvider({
      client: new CodeforcesApiClient({
        limiter: new CodeforcesRateLimiter({ intervalMs: 0 }),
        fetchImpl: async () => {
          const namespace = env.CODEFORCES_COORDINATOR;
          if (!namespace) {
            throw new Error("CODEFORCES_COORDINATOR binding is unavailable.");
          }
          return namespace.getByName("codeforces-official-api-v1").fetch(new Request("https://coordinator/problemset.problems"));
        }
      })
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createCodeforcesMcpServer({ provider });
    await server.connect(transport);
    return withCorsHeaders(await transport.handleRequest(request), request, env);
  }
};

export { CodeforcesCoordinator };
export default worker;

function validateOrigin(request: Request, env: CodeforcesWorkerEnv): Response | undefined {
  const origin = request.headers.get("origin");
  if (!origin) {
    return undefined;
  }
  const allowed = csv(env.CODEFORCES_MCP_ALLOWED_ORIGINS);
  if (allowed.includes("*") || allowed.includes(origin)) {
    return undefined;
  }
  return jsonResponse({ error: "Origin is not allowed." }, 403);
}

function withCorsHeaders(response: Response, request: Request, env: CodeforcesWorkerEnv): Response {
  if (!request.headers.get("origin")) {
    return response;
  }
  const headers = new Headers(response.headers);
  corsHeaders(request, env).forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function corsHeaders(request: Request, env: CodeforcesWorkerEnv): Headers {
  const headers = new Headers();
  const origin = request.headers.get("origin");
  const allowed = csv(env.CODEFORCES_MCP_ALLOWED_ORIGINS);
  if (origin && (allowed.includes("*") || allowed.includes(origin))) {
    headers.set("Access-Control-Allow-Origin", allowed.includes("*") ? "*" : origin);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", CORS_HEADERS);
  headers.set("Access-Control-Expose-Headers", "mcp-session-id");
  return headers;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function csv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}
