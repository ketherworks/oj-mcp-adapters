import type {
  OjCapabilities,
  OjCapability,
  OjCapabilityName,
  OjProblemSummary,
  OjProviderHealth,
  OjSearchRequest,
  OjSearchResult,
  OjSourceRef
} from "@kaiserunix/oj-mcp-contracts";
import { ojCapabilitiesSchema, ojProviderHealthSchema, ojSearchResultSchema } from "@kaiserunix/oj-mcp-contracts";
import { z } from "zod";
import { CodeforcesApiClient, CodeforcesApiError, CodeforcesRequestCancelledError } from "./client.js";
import { normalizeCodeforcesProblemset, searchCodeforcesProblems } from "./normalizers.js";
import type { CodeforcesUpstreamHealthObservation } from "./coordinator.js";
import { abortable, BoundedAdmission, CodeforcesQueueFullError } from "./admission.js";

export interface CodeforcesProviderOptions {
  client?: CodeforcesApiClient;
  cacheTtlMs?: number;
  now?: () => number;
  nowIso?: () => string;
  healthReader?: (options?: CodeforcesOperationOptions) => Promise<CodeforcesUpstreamHealthObservation | undefined>;
  maxConcurrentWaiters?: number;
  maxQueuedWaiters?: number;
}

export const codeforcesSearchInputSchema = z
  .object({
    schemaVersion: z.literal("oj.search-request/v1"),
    requestId: z.string().min(1).max(128),
    platform: z.literal("codeforces"),
    query: z.string().trim().min(1).max(256),
    limit: z.number().int().min(1).max(50)
  })
  .strict();

export interface CodeforcesOperationOptions {
  signal?: AbortSignal;
}

export class CodeforcesProvider {
  private readonly client: CodeforcesApiClient;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly nowIso: () => string;
  private readonly healthReader?: CodeforcesProviderOptions["healthReader"];
  private readonly waiterAdmission: BoundedAdmission;
  private cache?: { expiresAt: number; summaries: OjProblemSummary[] };
  private loading?: Promise<OjProblemSummary[]>;
  private lastError?: CodeforcesApiError;

  constructor(options: CodeforcesProviderOptions = {}) {
    this.client = options.client ?? new CodeforcesApiClient();
    this.cacheTtlMs = options.cacheTtlMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.healthReader = options.healthReader;
    this.waiterAdmission = new BoundedAdmission(
      options.maxConcurrentWaiters ?? 8,
      options.maxQueuedWaiters ?? 32,
      "Codeforces shared upstream load"
    );
  }

  async search(input: OjSearchRequest, options: CodeforcesOperationOptions = {}): Promise<OjSearchResult> {
    const parsed = codeforcesSearchInputSchema.safeParse(input);
    if (!parsed.success) throw new CodeforcesApiError("request.invalid", "Codeforces search input did not match its strict schema.");
    const request = parsed.data;
    const summaries = await this.problemSummaries(options.signal);
    return ojSearchResultSchema.parse({
      schemaVersion: "oj.search-result/v1",
      requestId: request.requestId,
      items: searchCodeforcesProblems(summaries, request.query, request.limit),
      source: source(this.nowIso())
    });
  }

  async getProblemMetadata(nativeId: string, options: CodeforcesOperationOptions = {}): Promise<OjProblemSummary | undefined> {
    const normalized = nativeId.trim().toLocaleUpperCase();
    return (await this.problemSummaries(options.signal)).find((summary) => summary.ref.nativeId.toLocaleUpperCase() === normalized);
  }

  async getCapabilities(transport: OjCapability["transport"]): Promise<OjCapabilities> {
    const operations = Object.fromEntries(
      capabilityNames.map((name) => [name, capability(name, this.nowIso(), transport)])
    ) as Record<OjCapabilityName, OjCapability>;
    return ojCapabilitiesSchema.parse({
      schemaVersion: "oj.capabilities/v1",
      providerId: "codeforces-official-api",
      providerVersion: "0.1.0",
      platform: "codeforces",
      protocolVersion: "2025-11-25",
      operations,
      languages: [],
      source: source(this.nowIso())
    });
  }

  async getHealth(options: CodeforcesOperationOptions = {}): Promise<OjProviderHealth> {
    const persisted = await this.healthReader?.(options);
    const code = persisted ? persisted.code : this.lastError?.code;
    const retryAfterMs = persisted ? persisted.retryAfterMs : this.lastError?.retryAfterMs;
    return ojProviderHealthSchema.parse({
      schemaVersion: "oj.provider-health/v1",
      providerId: "codeforces-official-api",
      platform: "codeforces",
      checkedAt: this.nowIso(),
      overall: code === "network.timeout" || code === "upstream.unavailable" ? "unavailable" : code ? "degraded" : "healthy",
      layers: {
        transport: code === "network.timeout" ? "fail" : "pass",
        protocol: "pass",
        schema: code === "upstream.schema_changed" ? "drift" : code ? "unknown" : "pass",
        auth: "not_required",
        upstream:
          code === "network.timeout" ? "timeout" : code === "rate_limited" ? "rate_limited" : code ? "fail" : "pass"
      },
      latencyMs: persisted?.latencyMs,
      retryAfterMs,
      message: code ? "Codeforces upstream is degraded; retry a public read later." : "Codeforces official API provider is healthy."
    });
  }

  private problemSummaries(signal?: AbortSignal): Promise<OjProblemSummary[]> {
    if (this.cache && this.cache.expiresAt > this.now()) {
      return Promise.resolve(this.cache.summaries);
    }
    return this.waiterAdmission
      .run(signal, async () => {
        if (this.cache && this.cache.expiresAt > this.now()) return this.cache.summaries;
        const loading = this.loading ?? this.startSharedLoad();
        return abortable(loading, signal);
      })
      .catch((error: unknown) => {
        if (signal?.aborted) {
          throw new CodeforcesRequestCancelledError("Codeforces provider wait was cancelled by the caller.", { cause: error });
        }
        if (error instanceof CodeforcesQueueFullError) {
          throw new CodeforcesApiError("rate_limited", error.message, 2_000);
        }
        throw error;
      });
  }

  private startSharedLoad(): Promise<OjProblemSummary[]> {
    const loading = this.client
      .getProblemset()
      .then((payload) => {
        const summaries = normalizeCodeforcesProblemset(payload, { fetchedAt: this.nowIso(), adapterVersion: "0.1.0" });
        this.cache = { expiresAt: this.now() + this.cacheTtlMs, summaries };
        this.lastError = undefined;
        return summaries;
      })
      .catch((error) => {
        if (error instanceof CodeforcesApiError) this.lastError = error;
        throw error;
      });
    this.loading = loading;
    void loading
      .finally(() => {
        if (this.loading === loading) this.loading = undefined;
      })
      .catch(() => undefined);
    return loading;
  }
}

const capabilityNames: OjCapabilityName[] = [
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
  if (name === "searchProblems") {
    return {
      name,
      status: "available",
      toolName: "oj_search_problems",
      transport,
      auth: "none",
      risk: "R0_public_read",
      compliance: "official",
      checkedAt
    };
  }
  if (name === "fetchProblem") {
    return {
      name,
      status: "degraded",
      toolName: "codeforces_get_problem_metadata",
      transport,
      auth: "none",
      risk: "R0_public_read",
      compliance: "official",
      reason: "The official API exposes metadata only; import statements through Competitive Companion.",
      checkedAt
    };
  }
  return {
    name,
    status: "unsupported",
    transport,
    auth: "none",
    risk: name === "commitSubmission" ? "R4_real_submit" : "R0_public_read",
    compliance: "official",
    reason: "The Codeforces official API does not expose this operation.",
    checkedAt
  };
}

function source(fetchedAt: string): OjSourceRef {
  return {
    kind: "official_api",
    adapterId: "codeforces-official-api",
    adapterVersion: "0.1.0",
    fetchedAt,
    sourceUrl: "https://codeforces.com/api/problemset.problems",
    confidence: "authoritative"
  };
}
