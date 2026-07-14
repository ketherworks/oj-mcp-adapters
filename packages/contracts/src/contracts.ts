export type OjPlatformId = "luogu" | "leetcode" | "nowcoder" | "codeforces" | "atcoder";

export type OjCapabilityName =
  | "searchProblems"
  | "fetchProblem"
  | "importProblem"
  | "fetchProfile"
  | "listSubmissions"
  | "localRun"
  | "platformRun"
  | "prepareSubmission"
  | "commitSubmission"
  | "pollSubmission";

export type OjProviderToolName = "capabilities" | "health" | OjCapabilityName;

export type OjCapabilityStatus = "available" | "auth_required" | "unsupported" | "disabled_by_policy" | "degraded";
export type OjOperationRisk = "R0_public_read" | "R1_private_read" | "R2_local_execute" | "R3_prepare_write" | "R4_real_submit";

export interface OjSourceRef {
  kind: "official_api" | "official_open_platform" | "page_adapter" | "browser_companion" | "community_adapter" | "manual";
  adapterId: string;
  adapterVersion: string;
  fetchedAt: string;
  sourceUrl: string;
  etag?: string;
  rawRef?: string;
  confidence: "authoritative" | "derived" | "user_supplied";
}

export interface OjProblemRef {
  schemaVersion: "oj.problem-ref/v1";
  platform: OjPlatformId;
  site?: "global" | "cn";
  nativeId: string;
  canonicalId: string;
  url: string;
  contest?: { nativeId: string; index?: string };
  source: OjSourceRef;
}

export interface OjProblemSummary {
  schemaVersion: "oj.problem-summary/v1";
  ref: OjProblemRef;
  title: string;
  difficulty?: { scale: string; value?: number; label?: string };
  tags: Array<{ namespace: "platform" | "canonical"; id?: string; slug: string; name: string }>;
  contestLabel?: string;
  acceptance?: { accepted?: number; submissions?: number; ratio?: number };
  source: OjSourceRef;
}

export interface OjTextBlock {
  text: string;
  format: "markdown" | "html" | "text";
  locale: string;
  truncated: boolean;
  originalChars?: number;
  sha256: string;
}

export interface OjProblemDocument {
  schemaVersion: "oj.problem-document/v1";
  ref: OjProblemRef;
  title: string;
  locale: string;
  access: "public" | "auth_required" | "premium" | "contest_only" | "unknown";
  difficulty?: { scale: string; value?: number; label?: string };
  tags: Array<{ namespace: "platform" | "canonical"; id?: string; slug: string; name: string }>;
  content: { statement: OjTextBlock; input?: OjTextBlock; output?: OjTextBlock; notes?: OjTextBlock };
  constraints: string[];
  samples: Array<{ ordinal: number; input: string; output: string; explanation?: string }>;
  limits: { timeMs?: number; memoryBytes?: number };
  io: { mode: "stdin_stdout" | "function" | "file" | "interactive"; inputFile?: string; outputFile?: string };
  starterCode: Array<{ languageKey: string; platformLanguageId: string; code: string }>;
  source: OjSourceRef;
}

export interface OjSearchRequest {
  schemaVersion: "oj.search-request/v1";
  requestId: string;
  platform: OjPlatformId;
  query: string;
  locale?: string;
  cursor?: string;
  limit: number;
}

export interface OjSearchResult {
  schemaVersion: "oj.search-result/v1";
  requestId: string;
  items: OjProblemSummary[];
  nextCursor?: string;
  source: OjSourceRef;
}

export interface OjImportWindowRequest {
  schemaVersion: "oj.import-window-request/v1";
  requestId: string;
  allowedPlatforms: OjPlatformId[];
  expiresInMs: number;
}

export interface OjImportWindow {
  schemaVersion: "oj.import-window/v1";
  windowId: string;
  expiresAt: string;
  state: "waiting" | "received" | "expired" | "cancelled";
  endpoint?: string;
}

export interface OjImportPreview {
  schemaVersion: "oj.import-preview/v1";
  windowId: string;
  document: OjProblemDocument;
  receivedAt: string;
}

export interface OjCapability {
  name: OjCapabilityName;
  status: OjCapabilityStatus;
  toolName?: string;
  transport: "remote_http" | "local_stdio";
  auth: "none" | "oauth2" | "api_key" | "session_cookie" | "browser";
  risk: OjOperationRisk;
  compliance: "official" | "unofficial" | "restricted" | "unknown";
  reason?: string;
  checkedAt: string;
}

export interface OjCapabilities {
  schemaVersion: "oj.capabilities/v1";
  providerId: string;
  providerVersion: string;
  platform: OjPlatformId;
  protocolVersion: string;
  operations: Record<OjCapabilityName, OjCapability>;
  languages: Array<{
    languageKey: string;
    platformLanguageId: string;
    displayName: string;
  }>;
  source: OjSourceRef;
}

export type OjVerdict =
  | "queued"
  | "judging"
  | "accepted"
  | "wrong_answer"
  | "compile_error"
  | "runtime_error"
  | "time_limit"
  | "memory_limit"
  | "output_limit"
  | "idleness_limit"
  | "security_violation"
  | "partial"
  | "skipped"
  | "unknown";

export interface OjCodeArtifact {
  languageKey: string;
  platformLanguageId?: string;
  source: string;
  sha256: string;
  bytes: number;
  fileName?: string;
  sourceUri?: string;
  documentVersion?: number;
  capturedAt: string;
  sourceWasDirty: boolean;
}

export interface OjRunRequest {
  schemaVersion: "oj.run-request/v1";
  requestId: string;
  attemptId: string;
  problem: OjProblemRef;
  mode: "local" | "platform";
  code: OjCodeArtifact;
  sampleOrdinals?: number[];
  limits: { wallTimeMs: number; outputBytes: number; network: "deny" };
}

export interface OjRunCaseResult {
  ordinal: number;
  verdict: OjVerdict;
  timeMs?: number;
  memoryBytes?: number;
  stdout?: string;
  stderr?: string;
  expectedOutputSha256?: string;
  actualOutputSha256?: string;
}

export interface OjRunResult {
  schemaVersion: "oj.run-result/v1";
  requestId: string;
  jobId: string;
  attemptId: string;
  mode: "local" | "platform";
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  verdict: OjVerdict;
  codeSha256: string;
  cases: OjRunCaseResult[];
  startedAt: string;
  completedAt?: string;
  source: OjSourceRef;
}

export interface OjSubmitResult {
  schemaVersion: "oj.submit-result/v1";
  requestId: string;
  intentId: string;
  submissionOperationId: string;
  jobId?: string;
  platformSubmissionId?: string;
  submissionUrl?: string;
  state: "queued" | "judging" | "completed" | "outcome_unknown";
  verdict: OjVerdict;
  codeSha256: string;
  submittedAt?: string;
  lastCheckedAt: string;
  source: OjSourceRef;
}

export interface OjPrepareSubmissionRequest {
  schemaVersion: "oj.prepare-submission/v1";
  requestId: string;
  attemptId: string;
  providerId: string;
  problem: OjProblemRef;
  accountId: string;
  languageKey: string;
  platformLanguageId: string;
  code: OjCodeArtifact;
  recentRunId?: string;
}

export interface OjSubmitPreview {
  schemaVersion: "oj.submit-preview/v1";
  intentId: string;
  submissionOperationId: string;
  expiresAt: string;
  attemptId: string;
  providerId: string;
  problem: OjProblemRef;
  account: { accountId: string; displayName: string; site?: "global" | "cn" };
  submissionTarget?: { kind: "account" | "team"; id: string; contestId?: string };
  languageKey: string;
  platformLanguageId: string;
  codeArtifactId: string;
  fileLabel: string;
  sourceWasDirty: boolean;
  codeSha256: string;
  codeBytes: number;
  localRunSummary?: { runId: string; verdict: OjVerdict; codeSha256: string };
  warnings: string[];
  actionLabel: string;
}

export interface OjSubmitCommitRequest {
  schemaVersion: "oj.submit-commit/v1";
  requestId: string;
  intentId: string;
  submissionOperationId: string;
  codeArtifactId: string;
  confirmationProof: string;
  codeSha256: string;
}

export interface OjSubmissionEvidence {
  schemaVersion: "oj.submission-evidence/v1";
  evidenceId: string;
  attemptId: string;
  submissionOperationId: string;
  problem: OjProblemRef;
  platformSubmissionId?: string;
  submissionUrl?: string;
  verdict: OjVerdict;
  codeSha256: string;
  observedAt: string;
  terminal: boolean;
  source: OjSourceRef;
}

export interface OjProviderHealth {
  schemaVersion: "oj.provider-health/v1";
  providerId: string;
  platform: OjPlatformId;
  checkedAt: string;
  overall: "healthy" | "degraded" | "unavailable" | "auth_required";
  layers: {
    transport: "pass" | "fail";
    protocol: "pass" | "fail";
    schema: "pass" | "drift" | "unknown";
    auth: "not_required" | "valid" | "expired" | "missing" | "challenge";
    upstream: "pass" | "timeout" | "rate_limited" | "blocked" | "fail";
  };
  latencyMs?: number;
  retryAfterMs?: number;
  message: string;
}

export type OjErrorCode =
  | "request.invalid"
  | "capability.unsupported"
  | "policy.blocked"
  | "auth.required"
  | "auth.invalid"
  | "auth.forbidden"
  | "challenge.required"
  | "resource.not_found"
  | "rate_limited"
  | "network.timeout"
  | "upstream.unavailable"
  | "upstream.schema_changed"
  | "language.unsupported"
  | "runner.unavailable"
  | "runner.sandbox_required"
  | "confirmation.required"
  | "confirmation.expired"
  | "confirmation.mismatch"
  | "submission.closed"
  | "submission.rejected"
  | "submission.outcome_unknown"
  | "internal";

export interface OjError {
  schemaVersion: "oj.error/v1";
  code: OjErrorCode;
  layer: "broker" | "transport" | "protocol" | "auth" | "upstream" | "runner" | "policy";
  message: string;
  retryPolicy: "never" | "safe_read" | "poll_only" | "after_user_action";
  userAction: "none" | "retry" | "sign_in" | "solve_challenge" | "change_language" | "open_logs";
  platform?: OjPlatformId;
  providerId?: string;
  httpStatus?: number;
  upstreamCode?: string;
  requestId?: string;
  jobId?: string;
  retryAfterMs?: number;
}

export interface OjProviderArtifactDescriptorV1 {
  sourceUrl: string;
  repository: string;
  version: string;
  commit: string;
  os: string[];
  arch: string[];
  runtime: string;
  archiveSha256: string;
  filesSha256: string;
  signatureOrAttestation?: string;
  sbomSha256: string;
  license: string;
}

export interface OjProviderEntrypointV1 {
  id: "agentReadOnly" | "productPrivate" | "remotePublic";
  transport: "local_stdio" | "remote_http";
  command?: string;
  args?: string[];
  url?: string;
  expectedTools: Array<{
    canonical: OjProviderToolName;
    upstream: string;
    schemaSha256: string;
    risk: OjOperationRisk;
  }>;
  allowedRisks: OjOperationRisk[];
  secretRefs?: Array<{
    logicalName: string;
    secretStorageKey: string;
    envName: string;
    required: boolean;
  }>;
}

export interface OjProviderManifestV1 {
  schemaVersion: "oj-provider-manifest/v1";
  providerId: string;
  platform: OjPlatformId;
  minimumExtensionVersion: string;
  installDirectoryLayout: string;
  artifacts: {
    active: OjProviderArtifactDescriptorV1;
    rollback: OjProviderArtifactDescriptorV1;
  };
  entrypoints: OjProviderEntrypointV1[];
  expectedProtocol: "2025-11-25";
}
