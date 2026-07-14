import {
  ojCapabilitiesSchema,
  ojProviderHealthSchema,
  ojSearchRequestSchema,
  type OjCapabilities,
  type OjCapability,
  type OjCapabilityName,
  type OjOperationRisk,
  type OjProblemDocument,
  type OjProviderHealth,
  type OjImportPreview,
  type OjImportWindow,
  type OjImportWindowRequest,
  type OjSearchRequest,
  type OjSearchResult,
  type OjPrepareSubmissionRequest,
  type OjSubmitCommitRequest,
  type OjSubmitPreview,
  type OjSubmitResult,
  type OjRunRequest,
  type OjRunResult,
  type OjSourceRef
} from "@kaiserunix/oj-mcp-contracts";
import { z } from "zod";
import { authStatusMessage, nowCoderAuthStatusSchema, type NowCoderAuthStatus } from "./auth.js";
import { NowCoderPageClient } from "./client.js";
import { CompetitiveCompanionImporter } from "./companion.js";
import { NowCoderAdapterError } from "./errors.js";
import { NOWCODER_JUDGE_LANGUAGES, NowCoderJudgeService } from "./judge.js";
import { NowCoderPageJudgeGateway } from "./judgeGateway.js";
import { parseNowCoderProblemHtml } from "./parser.js";
import { nowCoderProfileSchema, parseNowCoderProfileHtml, type NowCoderProfile } from "./profile.js";
import { parseNowCoderProblemListHtml } from "./search.js";
import { nowCoderSubmissionListSchema, parseNowCoderSubmissionsHtml, type NowCoderSubmissionList } from "./submissions.js";
import { resolveNowCoderProblemLocator, type NowCoderProblemLocator } from "./url.js";

const PROVIDER_ID = "nowcoder-public-page";
const PROVIDER_VERSION = "0.2.0";

export const nowCoderSearchInputSchema = ojSearchRequestSchema.extend({
  platform: z.literal("nowcoder"),
  query: z.string().trim().min(1).max(300),
  locale: z.literal("zh-CN").optional(),
  cursor: z.string().regex(/^[1-9]\d{0,3}$/).optional()
}).strict();

export const nowCoderProfileInputSchema = z.object({
  accountId: z.string().regex(/^[1-9]\d{0,11}$/).optional()
}).strict();

export const nowCoderSubmissionsInputSchema = z.object({
  accountId: z.string().regex(/^[1-9]\d{0,11}$/).optional(),
  query: z.string().trim().max(100).optional(),
  cursor: z.string().regex(/^[1-9]\d{0,3}$/).optional(),
  limit: z.number().int().min(1).max(50).default(20)
}).strict();

export interface NowCoderProviderOptions {
  client?: NowCoderPageClient;
  importer?: CompetitiveCompanionImporter;
  judge?: NowCoderJudgeService;
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
  private readonly importer: CompetitiveCompanionImporter;
  private readonly judge: NowCoderJudgeService;
  private readonly now: () => number;
  private readonly nowIso: () => string;
  private observation?: HealthObservation;

  constructor(options: NowCoderProviderOptions = {}) {
    this.client = options.client ?? new NowCoderPageClient();
    this.importer = options.importer ?? new CompetitiveCompanionImporter();
    this.now = options.now ?? Date.now;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.judge = options.judge ?? new NowCoderJudgeService({
      gateway: new NowCoderPageJudgeGateway(this.client, this.nowIso),
      now: this.now,
      nowIso: this.nowIso
    });
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

  async search(input: OjSearchRequest, options: { signal?: AbortSignal } = {}): Promise<OjSearchResult> {
    const startedAt = this.now();
    let request: z.infer<typeof nowCoderSearchInputSchema>;
    try {
      request = nowCoderSearchInputSchema.parse(input);
    } catch {
      throw new NowCoderAdapterError(
        "request.invalid",
        "Use a bounded NowCoder search request with a 1-300 character query, optional page cursor, and limit 1-50."
      );
    }

    try {
      const pageNumber = request.cursor === undefined ? 1 : Number(request.cursor);
      const page = await this.client.getProblemListPage({
        query: request.query,
        page: pageNumber,
        limit: request.limit
      }, options);
      const fetchedAt = this.nowIso();
      const result = parseNowCoderProblemListHtml(page.html, {
        requestId: request.requestId,
        query: request.query,
        page: pageNumber,
        limit: request.limit,
        fetchedAt
      });
      this.observation = { checkedAt: fetchedAt, latencyMs: Math.max(0, this.now() - startedAt) };
      return result;
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

  async fetchProfile(
    input: z.infer<typeof nowCoderProfileInputSchema>,
    options: { signal?: AbortSignal } = {}
  ): Promise<NowCoderProfile> {
    const parsed = nowCoderProfileInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new NowCoderAdapterError("request.invalid", "Use a positive numeric NowCoder accountId or omit it for the signed-in account.");
    }
    const startedAt = this.now();
    try {
      const page = await this.client.getProfilePage(parsed.data.accountId, options);
      const fetchedAt = this.nowIso();
      const profile = nowCoderProfileSchema.parse(parseNowCoderProfileHtml(page.html, {
        accountId: page.accountId,
        fetchedAt
      }));
      this.observation = { checkedAt: fetchedAt, latencyMs: Math.max(0, this.now() - startedAt) };
      return profile;
    } catch (error) {
      if (error instanceof NowCoderAdapterError && affectsHealth(error.code)) {
        this.observation = { checkedAt: this.nowIso(), latencyMs: Math.max(0, this.now() - startedAt), error };
      }
      throw error;
    }
  }

  async listSubmissions(
    input: z.input<typeof nowCoderSubmissionsInputSchema>,
    options: { signal?: AbortSignal } = {}
  ): Promise<NowCoderSubmissionList> {
    const parsed = nowCoderSubmissionsInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new NowCoderAdapterError("request.invalid", "Use a valid accountId, optional query and page cursor, and limit 1-50.");
    }
    const startedAt = this.now();
    try {
      const pageNumber = parsed.data.cursor === undefined ? 1 : Number(parsed.data.cursor);
      const page = await this.client.getSubmissionsPage({
        ...(parsed.data.accountId === undefined ? {} : { accountId: parsed.data.accountId }),
        page: pageNumber,
        limit: parsed.data.limit,
        ...(parsed.data.query === undefined ? {} : { query: parsed.data.query })
      }, options);
      const fetchedAt = this.nowIso();
      const result = nowCoderSubmissionListSchema.parse(parseNowCoderSubmissionsHtml(page.html, {
        accountId: page.accountId,
        page: pageNumber,
        pageSize: parsed.data.limit,
        sourceUrl: page.url,
        fetchedAt
      }));
      this.observation = { checkedAt: fetchedAt, latencyMs: Math.max(0, this.now() - startedAt) };
      return result;
    } catch (error) {
      if (error instanceof NowCoderAdapterError && affectsHealth(error.code)) {
        this.observation = { checkedAt: this.nowIso(), latencyMs: Math.max(0, this.now() - startedAt), error };
      }
      throw error;
    }
  }

  async getAuthStatus(options: { signal?: AbortSignal } = {}): Promise<NowCoderAuthStatus> {
    const status = await this.client.getSessionStatus(options);
    return nowCoderAuthStatusSchema.parse({
      schemaVersion: "nowcoder.auth-status/v1",
      platform: "nowcoder",
      providerId: PROVIDER_ID,
      ...status,
      checkedAt: this.nowIso(),
      message: authStatusMessage(status.state)
    });
  }

  async openImportWindow(input: OjImportWindowRequest): Promise<OjImportWindow> {
    return this.importer.open(input);
  }

  async completeImport(windowId: string): Promise<OjImportPreview> {
    return this.importer.complete(windowId);
  }

  async dispose(): Promise<void> {
    await this.importer.dispose();
  }

  prepareSubmission(input: OjPrepareSubmissionRequest, signal?: AbortSignal): Promise<OjSubmitPreview> {
    return this.judge.prepareSubmission(input, signal);
  }

  getSubmissionPreview(intentId: string): OjSubmitPreview {
    return this.judge.getSubmissionPreview(intentId);
  }

  commitSubmission(input: OjSubmitCommitRequest, authorized: boolean, signal?: AbortSignal): Promise<OjSubmitResult> {
    return this.judge.commitSubmission(input, authorized, signal);
  }

  pollSubmission(input: { requestId: string; submissionOperationId: string }, signal?: AbortSignal): Promise<OjSubmitResult> {
    return this.judge.pollSubmission(input, signal);
  }

  platformRun(input: OjRunRequest, authorized: boolean, signal?: AbortSignal): Promise<OjRunResult> {
    return this.judge.platformRun(input, authorized, signal);
  }

  async getCapabilities(): Promise<OjCapabilities> {
    const checkedAt = this.nowIso();
    const hasSessionCookie = this.client.hasSessionCookie();
    const operations = Object.fromEntries(
      capabilityNames.map((name) => [name, capability(name, checkedAt, hasSessionCookie)])
    ) as Record<OjCapabilityName, OjCapability>;
    return ojCapabilitiesSchema.parse({
      schemaVersion: "oj.capabilities/v1",
      providerId: PROVIDER_ID,
      providerVersion: PROVIDER_VERSION,
      platform: "nowcoder",
      protocolVersion: "2025-11-25",
      operations,
      languages: NOWCODER_JUDGE_LANGUAGES,
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
        message: "The last NowCoder page fetch parsed successfully."
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

function capability(name: OjCapabilityName, checkedAt: string, hasSessionCookie: boolean): OjCapability {
  if (name === "fetchProblem" || name === "searchProblems") {
    return {
      name,
      status: "available",
      toolName: name === "fetchProblem" ? "oj_fetch_problem" : "oj_search_problems",
      transport: "local_stdio",
      auth: hasSessionCookie ? "session_cookie" : "none",
      risk: hasSessionCookie ? "R1_private_read" : "R0_public_read",
      compliance: "unofficial",
      reason: hasSessionCookie
        ? "Reads allowlisted NowCoder pages with a local user-provided session."
        : "Reads audited official public NowCoder pages through a typed local adapter.",
      checkedAt
    };
  }
  if (name === "importProblem") {
    return {
      name,
      status: "available",
      toolName: "oj_open_import_window",
      transport: "local_stdio",
      auth: "browser",
      risk: "R0_public_read",
      compliance: "unofficial",
      reason: "Receives one NowCoder task from Competitive Companion through a short-lived loopback window.",
      checkedAt
    };
  }
  if (name === "fetchProfile") {
    return {
      name,
      status: "available",
      toolName: "oj_fetch_profile",
      transport: "local_stdio",
      auth: hasSessionCookie ? "session_cookie" : "none",
      risk: hasSessionCookie ? "R1_private_read" : "R0_public_read",
      compliance: "unofficial",
      reason: hasSessionCookie
        ? "Reads the signed-in or selected compact NowCoder competition profile."
        : "Reads a selected public NowCoder competition profile by numeric account ID.",
      checkedAt
    };
  }
  if (name === "listSubmissions") {
    return {
      name,
      status: "available",
      toolName: "oj_list_submissions",
      transport: "local_stdio",
      auth: hasSessionCookie ? "session_cookie" : "none",
      risk: hasSessionCookie ? "R1_private_read" : "R0_public_read",
      compliance: "unofficial",
      reason: hasSessionCookie
        ? "Lists compact submission metadata for the signed-in or selected competition profile."
        : "Lists compact public submission metadata for a selected competition profile.",
      checkedAt
    };
  }
  if (name === "prepareSubmission" || name === "commitSubmission" || name === "pollSubmission") {
    const available = hasSessionCookie;
    return {
      name,
      status: available ? "available" : "auth_required",
      ...(available ? { toolName: name === "prepareSubmission" ? "oj_prepare_submission" : name === "commitSubmission" ? "oj_commit_submission" : "oj_poll_submission" } : {}),
      transport: "local_stdio",
      auth: "session_cookie",
      risk: operationRisk(name),
      compliance: "unofficial",
      reason: available
        ? name === "prepareSubmission"
          ? "Builds an immutable two-minute submission preview without writing to NowCoder."
          : name === "commitSubmission"
            ? "Submits once only after an MCP-native user confirmation."
            : "Polls a submission created by this local process without resubmitting."
        : "Configure a local NowCoder session to activate judge operations.",
      checkedAt
    };
  }
  if (name === "platformRun") {
    return {
      name,
      status: hasSessionCookie ? "available" : "auth_required",
      ...(hasSessionCookie ? { toolName: "oj_platform_run" } : {}),
      transport: "local_stdio",
      auth: "session_cookie",
      risk: "R3_prepare_write",
      compliance: "unofficial",
      reason: hasSessionCookie
        ? "Uploads the immutable code artifact for one confirmed NowCoder platform self-test."
        : "Configure a local NowCoder session to activate platform self-test.",
      checkedAt
    };
  }
  const reason = "This operation is not active in the current provider build.";
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
    "auth.invalid",
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
  if (error.code === "auth.required" || error.code === "auth.invalid" || error.code === "auth.forbidden") {
    return { ...common, overall: "auth_required", layers: { transport: "pass", protocol: "pass", schema: "unknown", auth: "missing", upstream: "blocked" } };
  }
  return { ...common, overall: "unavailable", layers: { transport: "pass", protocol: "pass", schema: "unknown", auth: "not_required", upstream: "fail" } };
}
