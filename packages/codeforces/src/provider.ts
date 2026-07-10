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
import { ojCapabilitiesSchema, ojProviderHealthSchema, ojSearchRequestSchema, ojSearchResultSchema } from "@kaiserunix/oj-mcp-contracts";
import { CodeforcesApiClient, CodeforcesApiError } from "./client.js";
import { normalizeCodeforcesProblemset, searchCodeforcesProblems } from "./normalizers.js";

export interface CodeforcesProviderOptions {
  client?: CodeforcesApiClient;
  cacheTtlMs?: number;
  now?: () => number;
  nowIso?: () => string;
}

export class CodeforcesProvider {
  private readonly client: CodeforcesApiClient;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly nowIso: () => string;
  private cache?: { expiresAt: number; summaries: OjProblemSummary[] };
  private loading?: Promise<OjProblemSummary[]>;
  private lastError?: CodeforcesApiError;

  constructor(options: CodeforcesProviderOptions = {}) {
    this.client = options.client ?? new CodeforcesApiClient();
    this.cacheTtlMs = options.cacheTtlMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  async search(input: OjSearchRequest): Promise<OjSearchResult> {
    const request = ojSearchRequestSchema.parse(input);
    const summaries = await this.problemSummaries();
    return ojSearchResultSchema.parse({
      schemaVersion: "oj.search-result/v1",
      requestId: request.requestId,
      items: searchCodeforcesProblems(summaries, request.query, request.limit),
      source: source(this.nowIso())
    });
  }

  async getProblemMetadata(nativeId: string): Promise<OjProblemSummary | undefined> {
    const normalized = nativeId.trim().toLocaleUpperCase();
    return (await this.problemSummaries()).find((summary) => summary.ref.nativeId.toLocaleUpperCase() === normalized);
  }

  async getCapabilities(): Promise<OjCapabilities> {
    const operations = Object.fromEntries(
      capabilityNames.map((name) => [name, capability(name, this.nowIso())])
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

  async getHealth(): Promise<OjProviderHealth> {
    const error = this.lastError;
    return ojProviderHealthSchema.parse({
      schemaVersion: "oj.provider-health/v1",
      providerId: "codeforces-official-api",
      platform: "codeforces",
      checkedAt: this.nowIso(),
      overall: error ? "degraded" : "healthy",
      layers: {
        transport: "pass",
        protocol: "pass",
        schema: error?.code === "upstream.schema_changed" ? "drift" : "pass",
        auth: "not_required",
        upstream: error?.code === "rate_limited" ? "rate_limited" : error ? "fail" : "pass"
      },
      retryAfterMs: error?.retryAfterMs,
      message: error ? "Codeforces upstream is degraded; retry a public read later." : "Codeforces official API provider is healthy."
    });
  }

  private async problemSummaries(): Promise<OjProblemSummary[]> {
    if (this.cache && this.cache.expiresAt > this.now()) {
      return this.cache.summaries;
    }
    if (!this.loading) {
      this.loading = this.client
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
        })
        .finally(() => {
          this.loading = undefined;
        });
    }
    return this.loading;
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

function capability(name: OjCapabilityName, checkedAt: string): OjCapability {
  if (name === "searchProblems") {
    return {
      name,
      status: "available",
      toolName: "oj_search_problems",
      transport: "remote_http",
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
      transport: "remote_http",
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
    transport: "remote_http",
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
