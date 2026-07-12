import {
  ojCapabilitiesSchema,
  ojProviderHealthSchema,
  type OjCapabilities,
  type OjCapability,
  type OjCapabilityName,
  type OjOperationRisk,
  type OjProblemDocument,
  type OjProviderHealth,
  type OjSourceRef
} from "@kaiserunix/oj-mcp-contracts";
import { NowCoderPageClient } from "./client.js";
import { NowCoderAdapterError } from "./errors.js";
import { parseNowCoderProblemHtml } from "./parser.js";
import { resolveNowCoderProblemLocator, type NowCoderProblemLocator } from "./url.js";

const PROVIDER_ID = "nowcoder-public-page";
const PROVIDER_VERSION = "0.1.0";

export interface NowCoderProviderOptions {
  client?: NowCoderPageClient;
  now?: () => number;
  nowIso?: () => string;
}

interface HealthObservation {
  checkedAt: string;
  latencyMs: number;
  error?: NowCoderAdapterError;
}

export class NowCoderProvider {
  private readonly client: NowCoderPageClient;
  private readonly now: () => number;
  private readonly nowIso: () => string;
  private observation?: HealthObservation;

  constructor(options: NowCoderProviderOptions = {}) {
    this.client = options.client ?? new NowCoderPageClient();
    this.now = options.now ?? Date.now;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  async fetchProblem(locator: NowCoderProblemLocator, options: { signal?: AbortSignal } = {}): Promise<OjProblemDocument> {
    const startedAt = this.now();
    try {
      let requestedUrl: string;
      try {
        requestedUrl = resolveNowCoderProblemLocator(locator).canonicalUrl;
      } catch {
        throw new NowCoderAdapterError(
          "request.invalid",
          "Use one allowlisted NowCoder URL or nativeId NC<id> or <contest-id>/<index> in its documented field."
        );
      }
      const page = await this.client.getProblemPage(requestedUrl, options);
      const fetchedAt = this.nowIso();
      let document: OjProblemDocument;
      try {
        document = parseNowCoderProblemHtml(page.html, { url: page.url, fetchedAt, etag: page.etag });
      } catch (error) {
        if (error instanceof NowCoderAdapterError) throw error;
        throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder problem HTML no longer matches the audited document schema.");
      }
      this.observation = { checkedAt: fetchedAt, latencyMs: Math.max(0, this.now() - startedAt) };
      return document;
    } catch (error) {
      if (error instanceof NowCoderAdapterError && affectsHealth(error.code)) {
        this.observation = {
          checkedAt: this.nowIso(),
          latencyMs: Math.max(0, this.now() - startedAt),
          error
        };
      }
      throw error;
    }
  }

  async getCapabilities(): Promise<OjCapabilities> {
    const checkedAt = this.nowIso();
    const operations = Object.fromEntries(
      capabilityNames.map((name) => [name, capability(name, checkedAt)])
    ) as Record<OjCapabilityName, OjCapability>;
    return ojCapabilitiesSchema.parse({
      schemaVersion: "oj.capabilities/v1",
      providerId: PROVIDER_ID,
      providerVersion: PROVIDER_VERSION,
      platform: "nowcoder",
      protocolVersion: "2025-11-25",
      operations,
      languages: [],
      source: providerSource(checkedAt)
    });
  }

  async getHealth(): Promise<OjProviderHealth> {
    const observation = this.observation;
    if (!observation) {
      return ojProviderHealthSchema.parse({
        schemaVersion: "oj.provider-health/v1",
        providerId: PROVIDER_ID,
        platform: "nowcoder",
        checkedAt: this.nowIso(),
        overall: "healthy",
        layers: { transport: "pass", protocol: "pass", schema: "unknown", auth: "not_required", upstream: "pass" },
        message: "NowCoder page adapter is ready; health is passive and no upstream fetch has been observed yet."
      });
    }
    if (!observation.error) {
      return ojProviderHealthSchema.parse({
        schemaVersion: "oj.provider-health/v1",
        providerId: PROVIDER_ID,
        platform: "nowcoder",
        checkedAt: observation.checkedAt,
        overall: "healthy",
        layers: { transport: "pass", protocol: "pass", schema: "pass", auth: "not_required", upstream: "pass" },
        latencyMs: observation.latencyMs,
        message: "The last anonymous NowCoder public page fetch parsed successfully."
      });
    }
    return ojProviderHealthSchema.parse(healthFromError(observation));
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
  if (name === "fetchProblem") {
    return {
      name,
      status: "available",
      toolName: "oj_fetch_problem",
      transport: "local_stdio",
      auth: "none",
      risk: "R0_public_read",
      compliance: "unofficial",
      reason: "Reads audited official public NowCoder HTML; this is a page adapter, not an official API.",
      checkedAt
    };
  }
  const reason = name === "searchProblems"
    ? "No stable anonymous NowCoder search source has been audited."
    : name === "importProblem"
      ? "This stdio adapter does not open a browser or receive Competitive Companion posts."
      : "This anonymous read-only page adapter does not expose this operation.";
  return {
    name,
    status: "unsupported",
    transport: "local_stdio",
    auth: "none",
    risk: operationRisk(name),
    compliance: "unofficial",
    reason,
    checkedAt
  };
}

function operationRisk(name: OjCapabilityName): OjOperationRisk {
  if (name === "commitSubmission") return "R4_real_submit";
  if (name === "prepareSubmission") return "R3_prepare_write";
  if (name === "localRun" || name === "platformRun") return "R2_local_execute";
  if (name === "fetchProfile" || name === "listSubmissions" || name === "pollSubmission") return "R1_private_read";
  return "R0_public_read";
}

function providerSource(fetchedAt: string): OjSourceRef {
  return {
    kind: "page_adapter",
    adapterId: PROVIDER_ID,
    adapterVersion: PROVIDER_VERSION,
    fetchedAt,
    sourceUrl: "https://ac.nowcoder.com/acm/problem/list",
    confidence: "derived"
  };
}

function affectsHealth(code: NowCoderAdapterError["code"]): boolean {
  return [
    "challenge.required",
    "rate_limited",
    "network.timeout",
    "upstream.unavailable",
    "upstream.schema_changed",
    "auth.required",
    "auth.forbidden"
  ].includes(code);
}

function healthFromError(observation: HealthObservation): OjProviderHealth {
  const error = observation.error!;
  const common = {
    schemaVersion: "oj.provider-health/v1" as const,
    providerId: PROVIDER_ID,
    platform: "nowcoder" as const,
    checkedAt: observation.checkedAt,
    latencyMs: observation.latencyMs,
    retryAfterMs: error.options.retryAfterMs,
    message: error.message
  };
  if (error.code === "challenge.required") {
    return { ...common, overall: "degraded", layers: { transport: "pass", protocol: "pass", schema: "unknown", auth: "challenge", upstream: "blocked" } };
  }
  if (error.code === "upstream.schema_changed") {
    return { ...common, overall: "degraded", layers: { transport: "pass", protocol: "pass", schema: "drift", auth: "not_required", upstream: "pass" } };
  }
  if (error.code === "rate_limited") {
    return { ...common, overall: "degraded", layers: { transport: "pass", protocol: "pass", schema: "unknown", auth: "not_required", upstream: "rate_limited" } };
  }
  if (error.code === "network.timeout") {
    return { ...common, overall: "degraded", layers: { transport: "fail", protocol: "pass", schema: "unknown", auth: "not_required", upstream: "timeout" } };
  }
  if (error.code === "auth.required" || error.code === "auth.forbidden") {
    return { ...common, overall: "auth_required", layers: { transport: "pass", protocol: "pass", schema: "unknown", auth: "missing", upstream: "blocked" } };
  }
  return { ...common, overall: "unavailable", layers: { transport: "pass", protocol: "pass", schema: "unknown", auth: "not_required", upstream: "fail" } };
}
