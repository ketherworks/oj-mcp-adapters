import {
  ojCapabilitiesSchema,
  ojProviderHealthSchema,
  ojSearchRequestSchema,
  ojSearchResultSchema,
  type OjCapabilities,
  type OjCapability,
  type OjCapabilityName,
  type OjOperationRisk,
  type OjProblemDocument,
  type OjProviderHealth,
  type OjSearchRequest,
  type OjSearchResult
} from "@kaiserunix/oj-mcp-contracts";
import { z } from "zod";
import {
  LuoguAdapterError,
  LuoguPageClient,
  LuoguRequestCancelledError,
  LuoguUpstreamAdmissionError,
  type LuoguPageReader
} from "./client.js";
import { luoguSourceRef, normalizeLuoguProblem, normalizeLuoguSearch } from "./normalizers.js";
import { luoguProblemIdSchema } from "./upstreamSchemas.js";

const PROVIDER_ID = "luogu-lentille-page-adapter";
const PROVIDER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_SOURCE_URL = "https://www.luogu.com.cn/problem/list";

export const luoguSearchInputSchema = z
  .object({
    schemaVersion: z.literal("oj.search-request/v1"),
    requestId: z.string().min(1).max(128),
    platform: z.literal("luogu"),
    query: z.string().trim().min(1).max(200),
    locale: z.literal("zh-CN").optional(),
    cursor: z.string().min(1).max(32).optional(),
    limit: z.number().int().min(1).max(50)
  })
  .strict();

export const luoguFetchProblemInputSchema = z
  .object({
    nativeId: luoguProblemIdSchema,
    locale: z.literal("zh-CN").optional(),
    maxContentChars: z.number().int().min(200).max(50_000).default(20_000)
  })
  .strict();

export interface LuoguProviderOptions {
  reader?: LuoguPageReader;
  nowIso?: () => string;
  transport?: "local_stdio" | "remote_http";
  healthStore?: LuoguHealthStore;
}

type Observation = { state: "success"; checkedAt: string } | { state: "error"; checkedAt: string; error: LuoguAdapterError };

export class LuoguHealthStore {
  private nextSequence = 0;
  private committedSequence = 0;
  private observation?: Observation;

  begin(): number {
    this.nextSequence += 1;
    return this.nextSequence;
  }

  recordSuccess(sequence: number, checkedAt: string): void {
    this.commit(sequence, { state: "success", checkedAt });
  }

  recordError(sequence: number, checkedAt: string, error: LuoguAdapterError): void {
    if (!(error instanceof LuoguUpstreamAdmissionError) && isUpstreamHealthOutcome(error.code)) {
      this.commit(sequence, { state: "error", checkedAt, error });
    }
  }

  snapshot(): Observation | undefined {
    return this.observation;
  }

  private commit(sequence: number, observation: Observation): void {
    if (sequence >= this.committedSequence) {
      this.committedSequence = sequence;
      this.observation = observation;
    }
  }
}

export class LuoguProvider {
  private readonly reader: LuoguPageReader;
  private readonly nowIso: () => string;
  private readonly transport: "local_stdio" | "remote_http";
  private readonly healthStore: LuoguHealthStore;

  constructor(options: LuoguProviderOptions = {}) {
    this.reader = options.reader ?? new LuoguPageClient();
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.transport = options.transport ?? "local_stdio";
    this.healthStore = options.healthStore ?? new LuoguHealthStore();
  }

  async search(input: OjSearchRequest, options: { signal?: AbortSignal } = {}): Promise<OjSearchResult> {
    const request = parseSearchInput(input);
    const cursor = parseCursor(request.cursor);
    const observationSequence = this.healthStore.begin();
    try {
      const response = await this.reader.searchProblems({ query: request.query, page: cursor.page, signal: options.signal });
      const fetchedAt = this.nowIso();
      const summaries = normalizeLuoguSearch(response.payload, {
        fetchedAt,
        adapterVersion: PROVIDER_VERSION,
        sourceUrl: response.sourceUrl
      });
      const total = readSearchCount(response.payload);
      if (cursor.pageSize !== undefined && (cursor.page - 1) * cursor.pageSize >= total) {
        throw new LuoguAdapterError("request.invalid", "Luogu search cursor page starts outside the upstream result range.");
      }
      if (total > 0 && summaries.length === 0) {
        throw new LuoguAdapterError(
          "upstream.schema_changed",
          "Luogu problem search reported a nonzero count with an empty result page."
        );
      }
      if (cursor.offset > summaries.length) {
        throw new LuoguAdapterError("request.invalid", "Luogu search cursor offset is outside the current upstream page.");
      }
      const pageSize = cursor.pageSize ?? summaries.length;
      if (pageSize < 0 || pageSize > 100) {
        throw new LuoguAdapterError("request.invalid", "Luogu search cursor page size is outside the supported range.");
      }
      const end = Math.min(cursor.offset + request.limit, summaries.length);
      const nextCursor =
        pageSize === 0
          ? undefined
          : nextSearchCursor({
              page: cursor.page,
              offset: end,
              pageSize,
              currentPageLength: summaries.length,
              total
            });
      const source = luoguSourceRef({ fetchedAt, adapterVersion: PROVIDER_VERSION, sourceUrl: response.sourceUrl }, request.query);
      const result = ojSearchResultSchema.parse({
        schemaVersion: "oj.search-result/v1",
        requestId: request.requestId,
        items: summaries.slice(cursor.offset, end),
        nextCursor,
        source
      });
      this.healthStore.recordSuccess(observationSequence, fetchedAt);
      return result;
    } catch (caught) {
      rethrowCallerCancellation(options.signal, caught, "Luogu problem search was cancelled by the caller.");
      if (caught instanceof LuoguAdapterError) {
        this.healthStore.recordError(observationSequence, this.nowIso(), caught);
      }
      throw caught;
    }
  }

  async fetchProblem(
    input: z.input<typeof luoguFetchProblemInputSchema>,
    options: { signal?: AbortSignal } = {}
  ): Promise<OjProblemDocument> {
    const parsed = luoguFetchProblemInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new LuoguAdapterError("request.invalid", "Luogu fetch input is outside the supported bounds.", { cause: parsed.error });
    }
    const observationSequence = this.healthStore.begin();
    try {
      const response = await this.reader.fetchProblem(parsed.data.nativeId.toUpperCase(), { signal: options.signal });
      const fetchedAt = this.nowIso();
      const document = await normalizeLuoguProblem(response.payload, {
        fetchedAt,
        adapterVersion: PROVIDER_VERSION,
        sourceUrl: response.sourceUrl,
        maxContentChars: parsed.data.maxContentChars
      });
      this.healthStore.recordSuccess(observationSequence, fetchedAt);
      return document;
    } catch (caught) {
      rethrowCallerCancellation(options.signal, caught, "Luogu problem fetch was cancelled by the caller.");
      if (caught instanceof LuoguAdapterError) {
        this.healthStore.recordError(observationSequence, this.nowIso(), caught);
      }
      throw caught;
    }
  }

  async getCapabilities(): Promise<OjCapabilities> {
    const checkedAt = this.nowIso();
    const operations = Object.fromEntries(
      capabilityNames.map((name) => [name, capability(name, checkedAt, this.transport)])
    ) as Record<OjCapabilityName, OjCapability>;
    return ojCapabilitiesSchema.parse({
      schemaVersion: "oj.capabilities/v1",
      providerId: PROVIDER_ID,
      providerVersion: PROVIDER_VERSION,
      platform: "luogu",
      protocolVersion: PROTOCOL_VERSION,
      operations,
      languages: [],
      source: luoguSourceRef({
        fetchedAt: checkedAt,
        adapterVersion: PROVIDER_VERSION,
        sourceUrl: DEFAULT_SOURCE_URL
      })
    });
  }

  async getHealth(): Promise<OjProviderHealth> {
    const checkedAt = this.nowIso();
    const observation = this.healthStore.snapshot();
    if (!observation) {
      return ojProviderHealthSchema.parse({
        schemaVersion: "oj.provider-health/v1",
        providerId: PROVIDER_ID,
        platform: "luogu",
        checkedAt,
        overall: "degraded",
        layers: { transport: "pass", protocol: "pass", schema: "unknown", auth: "not_required", upstream: "pass" },
        message: "Luogu adapter is ready; no upstream read has been observed in this process."
      });
    }
    if (observation.state === "success") {
      return ojProviderHealthSchema.parse({
        schemaVersion: "oj.provider-health/v1",
        providerId: PROVIDER_ID,
        platform: "luogu",
        checkedAt,
        overall: "healthy",
        layers: { transport: "pass", protocol: "pass", schema: "pass", auth: "not_required", upstream: "pass" },
        message: "The most recent anonymous Luogu read matched the audited schema."
      });
    }

    const error = observation.error;
    const challenge = error.code === "challenge.required";
    return ojProviderHealthSchema.parse({
      schemaVersion: "oj.provider-health/v1",
      providerId: PROVIDER_ID,
      platform: "luogu",
      checkedAt,
      overall: challenge ? "auth_required" : error.code === "upstream.unavailable" ? "unavailable" : "degraded",
      layers: {
        transport: "pass",
        protocol: "pass",
        schema: error.code === "upstream.schema_changed" ? "drift" : "unknown",
        auth: challenge ? "challenge" : "not_required",
        upstream:
          error.code === "rate_limited"
            ? "rate_limited"
            : error.code === "network.timeout"
              ? "timeout"
              : challenge || error.code === "policy.blocked"
                ? "blocked"
                : "fail"
      },
      retryAfterMs: error.retryAfterMs,
      message: error.message
    });
  }
}

function rethrowCallerCancellation(signal: AbortSignal | undefined, caught: unknown, message: string): void {
  if (!signal?.aborted) return;
  if (caught instanceof LuoguRequestCancelledError) throw caught;
  throw new LuoguRequestCancelledError(message, { cause: caught });
}

function isUpstreamHealthOutcome(code: LuoguAdapterError["code"]): boolean {
  return (
    code === "challenge.required" ||
    code === "rate_limited" ||
    code === "network.timeout" ||
    code === "upstream.unavailable" ||
    code === "upstream.schema_changed"
  );
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

function capability(
  name: OjCapabilityName,
  checkedAt: string,
  transport: "local_stdio" | "remote_http"
): OjCapability {
  const risk = capabilityRisk(name);
  if (name === "searchProblems" || name === "fetchProblem") {
    return {
      name,
      status: "available",
      toolName: name === "searchProblems" ? "oj_search_problems" : "oj_fetch_problem",
      transport,
      auth: "none",
      risk,
      compliance: "unofficial",
      reason: "Anonymous Luogu content-only page adapter; endpoint stability is not formally guaranteed.",
      checkedAt
    };
  }
  if (name === "importProblem" || name === "localRun") {
    return {
      name,
      status: "unsupported",
      transport,
      auth: "none",
      risk,
      compliance: "unofficial",
      reason: "This package implements only anonymous Luogu problem reads.",
      checkedAt
    };
  }
  return {
    name,
    status: "disabled_by_policy",
    transport,
    auth: capabilityAuth(name),
    risk,
    compliance: "restricted",
    reason:
      capabilityAuth(name) === "session_cookie"
        ? "Upstream operation is auth_required and uses a Luogu session_cookie; it remains disabled by package policy."
        : "Profile data and unsupported workflows are excluded by package policy.",
    checkedAt
  };
}

function capabilityAuth(name: OjCapabilityName): OjCapability["auth"] {
  if (
    name === "listSubmissions" ||
    name === "platformRun" ||
    name === "prepareSubmission" ||
    name === "commitSubmission" ||
    name === "pollSubmission"
  ) {
    return "session_cookie";
  }
  return "none";
}

function capabilityRisk(name: OjCapabilityName): OjOperationRisk {
  if (name === "fetchProfile" || name === "listSubmissions" || name === "pollSubmission") return "R1_private_read";
  if (name === "localRun" || name === "platformRun") return "R2_local_execute";
  if (name === "prepareSubmission") return "R3_prepare_write";
  if (name === "commitSubmission") return "R4_real_submit";
  return "R0_public_read";
}

function parseSearchInput(input: OjSearchRequest): z.infer<typeof luoguSearchInputSchema> {
  const shared = ojSearchRequestSchema.safeParse(input);
  const local = luoguSearchInputSchema.safeParse(input);
  if (!shared.success || !local.success) {
    throw new LuoguAdapterError("request.invalid", "Luogu search request is outside the shared or provider-specific bounds.", {
      cause: local.success ? shared.error : local.error
    });
  }
  return local.data;
}

function parseCursor(value: string | undefined): { page: number; offset: number; pageSize?: number } {
  if (!value) {
    return { page: 1, offset: 0 };
  }
  const match = /^v1:(10000|[1-9]\d{0,3}):(0|[1-9]\d{0,2}):([1-9]\d{0,2})$/.exec(value);
  if (!match) {
    throw new LuoguAdapterError("request.invalid", "Luogu search cursor is malformed or outside supported bounds.");
  }
  const page = Number(match[1]);
  const offset = Number(match[2]);
  const pageSize = Number(match[3]);
  if (page > 10_000 || offset > 100 || pageSize > 100 || offset > pageSize) {
    throw new LuoguAdapterError("request.invalid", "Luogu search cursor is outside supported bounds.");
  }
  return { page, offset, pageSize };
}

function readSearchCount(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") return 0;
  const problems = (data as { problems?: unknown }).problems;
  if (!problems || typeof problems !== "object") return 0;
  const count = (problems as { count?: unknown }).count;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function nextSearchCursor(input: {
  page: number;
  offset: number;
  pageSize: number;
  currentPageLength: number;
  total: number;
}): string | undefined {
  if (input.offset < input.currentPageLength) {
    return `v1:${input.page}:${input.offset}:${input.pageSize}`;
  }
  if (input.page < 10_000 && input.total > input.page * input.pageSize) {
    return `v1:${input.page + 1}:0:${input.pageSize}`;
  }
  return undefined;
}
