import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
  ojImportPreviewSchema,
  ojImportWindowRequestSchema,
  ojImportWindowSchema,
  ojProblemDocumentSchema,
  type OjImportPreview,
  type OjImportWindow,
  type OjImportWindowRequest,
  type OjProblemDocument,
  type OjSourceRef
} from "@kaiserunix/oj-mcp-contracts";
import { z } from "zod";
import { NowCoderAdapterError } from "./errors.js";
import { resolveNowCoderProblemLocator } from "./url.js";

const DEFAULT_PORT = 10_043;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const BODY_READ_TIMEOUT_MS = 2_000;
const SOCKET_IDLE_TIMEOUT_MS = 2_000;

const companionTaskSchema = z.object({
  name: z.string().trim().min(1).max(500),
  group: z.string().max(500).optional(),
  url: z.string().url().max(2_048),
  interactive: z.boolean().default(false),
  memoryLimit: z.number().finite().positive().max(1024 * 1024).optional(),
  timeLimit: z.number().finite().positive().max(24 * 60 * 60 * 1_000).optional(),
  tests: z.array(z.object({
    input: z.string().max(1_048_576),
    output: z.string().max(1_048_576)
  })).max(100).default([]),
  input: z.object({
    type: z.enum(["stdin", "file", "regex"]),
    fileName: z.string().min(1).max(260).optional()
  }).optional(),
  output: z.object({
    type: z.enum(["stdout", "file"]),
    fileName: z.string().min(1).max(260).optional()
  }).optional()
});

type Completion = { ok: true; preview: OjImportPreview } | { ok: false; reason: "expired" | "cancelled" };

interface ActiveWindow {
  id: string;
  server: Server;
  sockets: Set<Socket>;
  expiresAt: string;
  expiresAtMs: number;
  timer: NodeJS.Timeout;
  resolve: (completion: Completion) => void;
  state: OjImportWindow["state"];
  closePromise?: Promise<void>;
}

export interface CompetitiveCompanionImporterOptions {
  port?: number;
  now?: () => number;
  nowIso?: () => string;
}

export class CompetitiveCompanionImporter {
  private readonly port: number;
  private readonly now: () => number;
  private readonly nowIso: () => string;
  private readonly completions = new Map<string, Promise<Completion>>();
  private active?: ActiveWindow;
  private opening = false;

  constructor(options: CompetitiveCompanionImporterOptions = {}) {
    this.port = options.port ?? configuredPort(process.env.COMPETITIVE_COMPANION_PORT);
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65_535) {
      throw new NowCoderAdapterError("request.invalid", "Competitive Companion port must be an integer from 0 to 65535.");
    }
    this.now = options.now ?? Date.now;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  async open(input: OjImportWindowRequest): Promise<OjImportWindow> {
    if (this.opening) {
      throw new NowCoderAdapterError("policy.blocked", "A Competitive Companion import window is already opening.");
    }
    this.opening = true;
    try {
    const parsed = ojImportWindowRequestSchema.safeParse(input);
    if (
      !parsed.success
      || parsed.data.allowedPlatforms.length !== 1
      || parsed.data.allowedPlatforms[0] !== "nowcoder"
    ) {
      throw new NowCoderAdapterError("request.invalid", "Open a NowCoder-only import window lasting at most 60 seconds.");
    }
    const previous = this.active;
    if (previous) {
      if (previous.state === "waiting" && this.now() < previous.expiresAtMs) {
        throw new NowCoderAdapterError("policy.blocked", "A Competitive Companion import window is already active.");
      }
      if (previous.state === "waiting") this.expireWindow(previous);
      await this.closeWindow(previous, true);
    }

    const id = randomUUID();
    const expiresAtMs = this.now() + parsed.data.expiresInMs;
    const expiresAt = new Date(expiresAtMs).toISOString();
    let resolve!: (completion: Completion) => void;
    const completion = new Promise<Completion>((done) => { resolve = done; });
    const server = createServer((request, response) => {
      void this.handleRequest(id, request, response);
    });
    const sockets = configureServer(server);
    await listen(server, this.port);
    const address = server.address();
    if (!address || typeof address === "string") {
      await closeServer(server);
      destroySockets(sockets);
      throw new NowCoderAdapterError("internal", "Competitive Companion listener did not expose a TCP port.");
    }

    let active!: ActiveWindow;
    const timer = setTimeout(() => {
      this.expireWindow(active);
    }, parsed.data.expiresInMs);
    active = { id, server, sockets, expiresAt, expiresAtMs, timer, resolve, state: "waiting" };
    this.completions.set(id, completion);
    this.active = active;

    return ojImportWindowSchema.parse({
      schemaVersion: "oj.import-window/v1",
      windowId: id,
      expiresAt,
      state: "waiting",
      endpoint: `http://127.0.0.1:${address.port}/`
    });
    } finally {
      this.opening = false;
    }
  }

  async complete(windowId: string): Promise<OjImportPreview> {
    const completion = this.completions.get(windowId);
    if (!completion) {
      throw new NowCoderAdapterError("resource.not_found", "Competitive Companion import window was not found.");
    }
    const result = await completion;
    this.completions.delete(windowId);
    const active = this.active;
    if (active?.id === windowId) await this.closeWindow(active, active.state !== "received");
    if (!result.ok) {
      throw new NowCoderAdapterError(
        result.reason === "expired" ? "network.timeout" : "request.invalid",
        result.reason === "expired" ? "Competitive Companion import window expired." : "Competitive Companion import window was cancelled."
      );
    }
    return result.preview;
  }

  async dispose(): Promise<void> {
    const active = this.active;
    if (!active) return;
    clearTimeout(active.timer);
    if (active.state === "waiting") active.resolve({ ok: false, reason: "cancelled" });
    active.state = "cancelled";
    this.completions.delete(active.id);
    await this.closeWindow(active, true);
  }

  private async handleRequest(id: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = allowedExtensionOrigin(request.headers.origin);
    if (origin === false) {
      respond(response, 403, "Browser origin is not allowed.");
      return;
    }
    const active = this.active;
    if (!active || active.id !== id || active.state !== "waiting") {
      respond(response, 410, "Import window is closed.", origin);
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders(origin));
      response.end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/") {
      respond(response, 404, "POST one Competitive Companion task to /.", origin);
      return;
    }
    if (!/^application\/json\b/i.test(String(request.headers["content-type"] ?? ""))) {
      respond(response, 415, "Expected application/json.", origin);
      return;
    }

    try {
      const body = await readBody(request, MAX_BODY_BYTES, BODY_READ_TIMEOUT_MS);
      if (this.active !== active || active.state !== "waiting") {
        respond(response, 410, "Import window is closed.", origin);
        return;
      }
      const payload = JSON.parse(body) as unknown;
      const document = parseCompetitiveCompanionTask(payload, this.nowIso());
      const preview = ojImportPreviewSchema.parse({
        schemaVersion: "oj.import-preview/v1",
        windowId: active.id,
        document,
        receivedAt: this.nowIso()
      });
      active.state = "received";
      clearTimeout(active.timer);
      active.resolve({ ok: true, preview });
      response.writeHead(200, { ...corsHeaders(origin), "content-type": "application/json; charset=utf-8" });
      response.end('{"ok":true}', () => { void this.closeWindow(active, true); });
    } catch {
      respond(response, 422, "Competitive Companion payload is not a valid NowCoder task.", origin);
    }
  }

  private expireWindow(active: ActiveWindow): void {
    if (this.active !== active || active.state !== "waiting") return;
    active.state = "expired";
    clearTimeout(active.timer);
    active.resolve({ ok: false, reason: "expired" });
    void this.closeWindow(active, true);
  }

  private async closeWindow(active: ActiveWindow, force: boolean): Promise<void> {
    active.closePromise ??= closeServer(active.server);
    if (force) destroySockets(active.sockets);
    await active.closePromise;
    if (this.active === active) this.active = undefined;
  }
}

export function parseCompetitiveCompanionTask(input: unknown, receivedAt: string): OjProblemDocument {
  const task = companionTaskSchema.parse(input);
  const page = resolveNowCoderProblemLocator({ url: task.url });
  const source: OjSourceRef = {
    kind: "browser_companion",
    adapterId: "competitive-companion",
    adapterVersion: "json-v1",
    fetchedAt: receivedAt,
    sourceUrl: page.canonicalUrl,
    rawRef: page.nativeId,
    confidence: "user_supplied"
  };
  const inputFile = task.input?.type === "file" ? task.input.fileName : undefined;
  const outputFile = task.output?.type === "file" ? task.output.fileName : undefined;
  const ioMode = task.interactive ? "interactive" : inputFile || outputFile ? "file" : "stdin_stdout";
  return ojProblemDocumentSchema.parse({
    schemaVersion: "oj.problem-document/v1",
    ref: {
      schemaVersion: "oj.problem-ref/v1",
      platform: "nowcoder",
      nativeId: page.nativeId,
      canonicalId: `nowcoder:${page.nativeId}`,
      url: page.canonicalUrl,
      ...(page.kind === "contest" ? { contest: { nativeId: page.contestId, index: page.index } } : {}),
      source
    },
    title: task.name,
    locale: "zh-CN",
    access: "public",
    tags: [],
    content: {
      statement: textBlock("", "zh-CN")
    },
    constraints: [],
    samples: task.tests.map((sample, index) => ({ ordinal: index + 1, ...sample })),
    limits: {
      ...(task.timeLimit === undefined ? {} : { timeMs: task.timeLimit }),
      ...(task.memoryLimit === undefined ? {} : { memoryBytes: Math.floor(task.memoryLimit * 1024 * 1024) })
    },
    io: {
      mode: ioMode,
      ...(inputFile ? { inputFile } : {}),
      ...(outputFile ? { outputFile } : {})
    },
    starterCode: [],
    source
  });
}

function textBlock(text: string, locale: string) {
  return {
    text,
    format: "text" as const,
    locale,
    truncated: false,
    sha256: createHash("sha256").update(text).digest("hex")
  };
}

function configuredPort(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(value)) {
    throw new NowCoderAdapterError("request.invalid", "COMPETITIVE_COMPANION_PORT must be an integer from 1024 to 65535.");
  }
  const port = Number(value);
  if (port < 1024 || port > 65_535) {
    throw new NowCoderAdapterError("request.invalid", "COMPETITIVE_COMPANION_PORT must be an integer from 1024 to 65535.");
  }
  return port;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(new NowCoderAdapterError("upstream.unavailable", `Competitive Companion listener could not bind to port ${port}: ${error.message}`));
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function configureServer(server: Server): Set<Socket> {
  const sockets = new Set<Socket>();
  server.requestTimeout = BODY_READ_TIMEOUT_MS;
  server.headersTimeout = SOCKET_IDLE_TIMEOUT_MS;
  server.keepAliveTimeout = SOCKET_IDLE_TIMEOUT_MS;
  server.timeout = SOCKET_IDLE_TIMEOUT_MS;
  server.maxHeadersCount = 32;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  return sockets;
}

function destroySockets(sockets: Set<Socket>): void {
  for (const socket of sockets) socket.destroy();
}

async function readBody(request: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<string> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Body too large.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  const timeout = setTimeout(() => request.destroy(new Error("Body read deadline exceeded.")), timeoutMs);
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) throw new Error("Body too large.");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timeout);
  }
}

function allowedExtensionOrigin(origin: string | undefined): string | undefined | false {
  if (origin === undefined) return undefined;
  try {
    const parsed = new URL(origin);
    if (
      (parsed.protocol !== "chrome-extension:" && parsed.protocol !== "moz-extension:")
      || parsed.hostname === ""
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.port !== ""
      || (parsed.pathname !== "" && parsed.pathname !== "/")
      || parsed.search !== ""
      || parsed.hash !== ""
    ) {
      return false;
    }
    return origin;
  } catch {
    return false;
  }
}

function corsHeaders(origin?: string): Record<string, string> {
  return {
    ...(origin === undefined ? {} : { "access-control-allow-origin": origin, vary: "Origin" }),
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}

function respond(response: ServerResponse, status: number, message: string, origin?: string): void {
  if (response.destroyed || response.writableEnded || response.headersSent) return;
  response.writeHead(status, { ...corsHeaders(origin), "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}
