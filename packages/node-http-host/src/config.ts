import { createAtCoderWorker, type AtCoderWorkerEnv } from "@kaiserunix/atcoder-mcp-server/worker";
import { createLuoguWorker, type LuoguWorkerEnv } from "@kaiserunix/luogu-mcp-server/worker";
import type { WebWorker } from "./bridge.js";

export type HostedProvider = "atcoder" | "luogu";

export interface HostConfig {
  provider: HostedProvider;
  host: string;
  port: number;
  internalKey?: string;
  workerEnv: Record<string, string | undefined>;
}

export function parseHostConfig(argv: string[], env: Record<string, string | undefined>): HostConfig {
  const provider = argv[0];
  if (provider !== "atcoder" && provider !== "luogu") {
    throw new TypeError("The hosted provider must be atcoder or luogu.");
  }
  const host = env.OJ_MCP_HOST?.trim() || "127.0.0.1";
  if (host.includes("\0")) throw new TypeError("OJ_MCP_HOST is invalid.");
  const portText = env.OJ_MCP_PORT?.trim() || "8787";
  if (!/^[0-9]+$/.test(portText)) throw new TypeError("OJ_MCP_PORT must be an integer from 1 to 65535.");
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("OJ_MCP_PORT must be an integer from 1 to 65535.");
  }
  const internalKey = env.OJ_MCP_INTERNAL_KEY;
  if (internalKey !== undefined && internalKey.length < 24) {
    throw new TypeError("OJ_MCP_INTERNAL_KEY must contain at least 24 characters.");
  }
  const originsName = provider === "atcoder" ? "ATCODER_MCP_ALLOWED_ORIGINS" : "LUOGU_MCP_ALLOWED_ORIGINS";
  const allowedOrigins = env[originsName];
  return {
    provider,
    host,
    port,
    ...(internalKey !== undefined ? { internalKey } : {}),
    workerEnv: { ...(allowedOrigins !== undefined ? { [originsName]: allowedOrigins } : {}) }
  };
}

export function createHostedWorker(provider: HostedProvider): WebWorker<Record<string, string | undefined>> {
  if (provider === "atcoder") {
    const worker = createAtCoderWorker();
    return { fetch: (request, env) => worker.fetch(request, env as AtCoderWorkerEnv) };
  }
  const worker = createLuoguWorker();
  return { fetch: (request, env) => worker.fetch(request, env as LuoguWorkerEnv) };
}
