import {
  ojCapabilitiesSchema,
  ojProviderHealthSchema,
  ojSearchResultSchema,
  type OjCapabilities,
  type OjCapability,
  type OjCapabilityName,
  type OjOperationRisk,
  type OjProblemDocument,
  type OjProviderHealth,
  type OjSearchResult,
  type OjSourceRef
} from "@kaiserunix/oj-mcp-contracts";
import { z } from "zod";
import {
  AtCoderClientError,
  AtCoderHtmlClient,
  parseAtCoderTaskUrl,
  type AtCoderLocale,
  type AtCoderTaskLocator
} from "./client.js";
import { parseAtCoderProblem } from "./normalizer.js";

const canonicalIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const localeSchema = z.enum(["en", "ja"]);
const canonicalTaskUrlSchema = z
  .string()
  .url()
  .max(300)
  .regex(/^https:\/\/atcoder\.jp\/contests\/[a-z0-9][a-z0-9_-]{0,63}\/tasks\/[a-z0-9][a-z0-9_-]{0,63}(?:\?lang=(?:en|ja))?$/)
  .describe("Canonical HTTPS atcoder.jp task URL, optionally with one en/ja lang query.");

export const atCoderFetchProblemInputSchema = z.union([
  z
    .object({
      url: canonicalTaskUrlSchema,
      locale: localeSchema.optional().describe("Statement locale. Overrides the URL lang query when supplied.")
    })
    .strict(),
  z
    .object({
      contestId: canonicalIdSchema.describe("Exact AtCoder contest id, such as abc086."),
      taskId: canonicalIdSchema.describe("Exact AtCoder task id, such as abc086_a."),
      locale: localeSchema.optional().describe("Statement locale. Defaults to English.")
    })
    .strict()
]);

export const atCoderSearchInputSchema = z
  .object({
    schemaVersion: z.literal("oj.search-request/v1"),
    requestId: z.string().min(1).max(200),
    platform: z.literal("atcoder"),
    query: z.string().trim().min(1).max(300),
    locale: localeSchema.optional(),
    limit: z.number().int().min(1).max(50)
  })
  .strict();

export type AtCoderFetchProblemInput = z.infer<typeof atCoderFetchProblemInputSchema>;

export interface AtCoderProviderOptions {
  client?: AtCoderHtmlClient;
  now?: () => number;
  nowIso?: () => string;
}

interface SharedRead {
  controller: AbortController;
  consumers: number;
  settled: boolean;
  promise: Promise<OjProblemDocument>;
}

export class AtCoderProvider {
  private readonly client: AtCoderHtmlClient;
  private readonly now: () => number;
  private readonly nowIso: () => string;
  private lastObservation?: { sequence: number; latencyMs: number; error?: AtCoderClientError };
  private nextSequence = 0;
  private readonly inFlight = new Map<string, SharedRead>();

  constructor(options: AtCoderProviderOptions = {}) {
    this.client = options.client ?? new AtCoderHtmlClient();
    this.now = options.now ?? Date.now;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  async fetchProblem(input: unknown, signal?: AbortSignal): Promise<OjProblemDocument> {
    let locator: AtCoderTaskLocator;
    try {
      const parsed = atCoderFetchProblemInputSchema.parse(input);
      locator = resolveLocator(parsed);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof TypeError) {
        throw new AtCoderClientError(
          "request.invalid",
          error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(" ") : error.message
        );
      }
      throw error;
    }

    const key = `${locator.contestId}/${locator.taskId}?lang=${locator.locale}`;
    let shared = this.inFlight.get(key);
    if (!shared) {
      shared = this.createSharedRead(key, locator);
      this.inFlight.set(key, shared);
    }
    return consumeSharedRead(shared, signal);
  }

  private createSharedRead(key: string, locator: AtCoderTaskLocator): SharedRead {
    const controller = new AbortController();
    const shared: SharedRead = { controller, consumers: 0, settled: false, promise: undefined as never };
    const sequence = ++this.nextSequence;
    shared.promise = this.loadProblem(locator, controller.signal, sequence).finally(() => {
      shared.settled = true;
      if (this.inFlight.get(key) === shared) this.inFlight.delete(key);
    });
    return shared;
  }

  private async loadProblem(locator: AtCoderTaskLocator, signal: AbortSignal, sequence: number): Promise<OjProblemDocument> {
    const startedAt = this.now();
    try {
      const page = await this.client.fetchTask(locator, signal);
      const document = await parseAtCoderProblem(page, { fetchedAt: this.nowIso(), adapterVersion: "0.1.0" });
      if (!signal.aborted) this.recordObservation({ sequence, latencyMs: this.now() - startedAt });
      return document;
    } catch (error) {
      const mapped =
        error instanceof z.ZodError
          ? new AtCoderClientError("upstream.schema_changed", "Normalized AtCoder content failed the shared problem schema.")
          : error;
      if (
        mapped instanceof AtCoderClientError &&
        !signal.aborted &&
        mapped.code !== "resource.not_found" &&
        mapped.code !== "request.invalid" &&
        mapped.transportCause !== "consumer_cancelled"
      ) {
        this.recordObservation({ sequence, latencyMs: this.now() - startedAt, error: mapped });
      }
      throw mapped;
    }
  }

  private recordObservation(observation: { sequence: number; latencyMs: number; error?: AtCoderClientError }): void {
    if (!this.lastObservation || observation.sequence >= this.lastObservation.sequence) this.lastObservation = observation;
  }

  async getCapabilities(transport: OjCapability["transport"]): Promise<OjCapabilities> {
    const checkedAt = this.nowIso();
    const operations = Object.fromEntries(
      CAPABILITY_NAMES.map((name) => [name, capability(name, checkedAt, transport)])
    ) as Record<OjCapabilityName, OjCapability>;
    return ojCapabilitiesSchema.parse({
      schemaVersion: "oj.capabilities/v1",
      providerId: "atcoder-page-adapter",
      providerVersion: "0.1.0",
      platform: "atcoder",
      protocolVersion: "2025-11-25",
      operations,
      languages: [],
      source: providerSource(checkedAt)
    });
  }

  async search(input: unknown, signal?: AbortSignal): Promise<OjSearchResult> {
    let request: z.infer<typeof atCoderSearchInputSchema>;
    let locator: AtCoderTaskLocator;
    try {
      request = atCoderSearchInputSchema.parse(input);
      const locale = request.locale;
      locator = exactSearchLocator(request.query, locale);
    } catch (error) {
      if (error instanceof AtCoderClientError) throw error;
      if (error instanceof z.ZodError || error instanceof TypeError) {
        throw new AtCoderClientError(
          "request.invalid",
          error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(" ") : error.message
        );
      }
      throw error;
    }

    try {
      const document = await this.fetchProblem(locator, signal);
      return ojSearchResultSchema.parse({
        schemaVersion: "oj.search-result/v1",
        requestId: request.requestId,
        items: [
          {
            schemaVersion: "oj.problem-summary/v1",
            ref: document.ref,
            title: document.title,
            tags: document.tags,
            contestLabel: locator.contestId,
            source: document.source
          }
        ],
        source: document.source
      });
    } catch (error) {
      if (!(error instanceof AtCoderClientError) || error.code !== "resource.not_found") throw error;
      return ojSearchResultSchema.parse({
        schemaVersion: "oj.search-result/v1",
        requestId: request.requestId,
        items: [],
        source: taskSource(locator, this.nowIso())
      });
    }
  }

  async getHealth(): Promise<OjProviderHealth> {
    const observation = this.lastObservation;
    if (observation?.error) return errorHealth(observation.error, observation.latencyMs, this.nowIso());
    return ojProviderHealthSchema.parse({
      schemaVersion: "oj.provider-health/v1",
      providerId: "atcoder-page-adapter",
      platform: "atcoder",
      checkedAt: this.nowIso(),
      overall: "healthy",
      layers: {
        transport: "pass",
        protocol: "pass",
        schema: observation ? "pass" : "unknown",
        auth: "not_required",
        upstream: "pass"
      },
      ...(observation ? { latencyMs: observation.latencyMs } : {}),
      message: observation
        ? "The latest anonymous AtCoder task read passed transport, HTML, and shared-schema validation."
        : "AtCoder adapter is ready; upstream not yet observed in this process."
    });
  }
}

function resolveLocator(input: AtCoderFetchProblemInput): AtCoderTaskLocator {
  if ("url" in input) return parseAtCoderTaskUrl(input.url, input.locale);
  return {
    contestId: input.contestId!,
    taskId: input.taskId!,
    locale: (input.locale ?? "en") as AtCoderLocale
  };
}

async function consumeSharedRead(shared: SharedRead, signal?: AbortSignal): Promise<OjProblemDocument> {
  shared.consumers += 1;
  let removeAbortListener: (() => void) | undefined;
  try {
    if (!signal) return await shared.promise;
    if (signal.aborted) throw cancelledRead();
    const cancelled = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(cancelledRead());
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });
    return await Promise.race([shared.promise, cancelled]);
  } finally {
    removeAbortListener?.();
    shared.consumers -= 1;
    if (shared.consumers === 0 && !shared.settled) {
      shared.controller.abort(new DOMException("All AtCoder read consumers cancelled.", "AbortError"));
    }
  }
}

function cancelledRead(): AtCoderClientError {
  return new AtCoderClientError(
    "network.timeout",
    "The AtCoder read was cancelled.",
    undefined,
    undefined,
    "consumer_cancelled"
  );
}

function exactSearchLocator(query: string, locale?: AtCoderLocale): AtCoderTaskLocator {
  const trimmed = query.trim();
  if (/^https:/i.test(trimmed)) return parseAtCoderTaskUrl(trimmed, locale);
  const nativeId = trimmed.startsWith("atcoder:") ? trimmed.slice("atcoder:".length) : trimmed;
  const match = /^([a-z0-9][a-z0-9_-]{0,63})\/([a-z0-9][a-z0-9_-]{0,63})$/.exec(nativeId);
  if (!match) {
    throw new TypeError("AtCoder search accepts only an exact contest/task id, atcoder:contest/task id, or canonical task URL.");
  }
  return { contestId: match[1]!, taskId: match[2]!, locale: locale ?? "en" };
}

const CAPABILITY_NAMES: OjCapabilityName[] = [
  "searchProblems",
  "fetchProblem",
  "importProblem",
  "fetchProfile",
  "listSubmissions",
  "localRun",
  "platformRun",
  "prepareSubmission",
  "commitSubmission",
  "pollSubmission"
];

function capability(name: OjCapabilityName, checkedAt: string, transport: OjCapability["transport"]): OjCapability {
  if (name === "searchProblems" || name === "fetchProblem") {
    return {
      name,
      status: "available",
      toolName: name === "searchProblems" ? "oj_search_problems" : "oj_fetch_problem",
      transport,
      auth: "none",
      risk: "R0_public_read",
      compliance: "unofficial",
      reason:
        name === "searchProblems"
          ? "Exact contest/task lookup only; this adapter does not crawl AtCoder's problem catalog."
          : "Reads public statement HTML from the official atcoder.jp task page without authentication.",
      checkedAt
    };
  }
  return {
    name,
    status: "unsupported",
    transport,
    auth: "none",
    risk: riskFor(name),
    compliance: "unofficial",
    reason: "This anonymous AtCoder page adapter exposes public problem reads only.",
    checkedAt
  };
}

function riskFor(name: OjCapabilityName): OjOperationRisk {
  if (name === "localRun" || name === "platformRun") return "R2_local_execute";
  if (name === "prepareSubmission") return "R3_prepare_write";
  if (name === "commitSubmission") return "R4_real_submit";
  if (name === "fetchProfile" || name === "listSubmissions" || name === "pollSubmission") return "R1_private_read";
  return "R0_public_read";
}

function providerSource(fetchedAt: string): OjSourceRef {
  return {
    kind: "page_adapter",
    adapterId: "atcoder-page-adapter",
    adapterVersion: "0.1.0",
    fetchedAt,
    sourceUrl: "https://atcoder.jp/",
    confidence: "derived"
  };
}

function taskSource(locator: AtCoderTaskLocator, fetchedAt: string): OjSourceRef {
  return {
    kind: "page_adapter",
    adapterId: "atcoder-page-adapter",
    adapterVersion: "0.1.0",
    fetchedAt,
    sourceUrl: `https://atcoder.jp/contests/${locator.contestId}/tasks/${locator.taskId}?lang=${locator.locale}`,
    confidence: "derived"
  };
}

function errorHealth(error: AtCoderClientError, latencyMs: number, checkedAt: string): OjProviderHealth {
  const notFound = error.code === "resource.not_found";
  const upstream: OjProviderHealth["layers"]["upstream"] =
    error.code === "rate_limited"
      ? "rate_limited"
      : error.code === "network.timeout"
        ? "timeout"
        : error.code === "challenge.required" || error.code === "policy.blocked"
          ? "blocked"
          : notFound
            ? "pass"
            : "fail";
  return ojProviderHealthSchema.parse({
    schemaVersion: "oj.provider-health/v1",
    providerId: "atcoder-page-adapter",
    platform: "atcoder",
    checkedAt,
    overall: notFound ? "healthy" : error.code === "upstream.unavailable" ? "unavailable" : "degraded",
    layers: {
      transport: error.code === "network.timeout" ? "fail" : "pass",
      protocol: "pass",
      schema: error.code === "upstream.schema_changed" ? "drift" : "unknown",
      auth: "not_required",
      upstream
    },
    latencyMs,
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    message: notFound
      ? "The latest exact AtCoder task lookup returned a normal not-found response."
      : `The latest anonymous AtCoder task read failed: ${error.message}`
  });
}
