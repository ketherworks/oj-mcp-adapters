import { z } from "zod";
import { ojProviderManifestSchema } from "./providerManifest.js";
import { ojCapabilityNameSchema, ojOperationRiskSchema, ojPlatformIdSchema } from "./schemaPrimitives.js";

export { ojCapabilityNameSchema, ojOperationRiskSchema, ojPlatformIdSchema, ojProviderToolNameSchema } from "./schemaPrimitives.js";

export const ojSourceRefSchema = z
  .object({
    kind: z.enum([
      "official_api",
      "official_open_platform",
      "page_adapter",
      "browser_companion",
      "community_adapter",
      "manual"
    ]),
    adapterId: z.string().min(1),
    adapterVersion: z.string().min(1),
    fetchedAt: z.iso.datetime(),
    sourceUrl: z.url(),
    etag: z.string().min(1).optional(),
    rawRef: z.string().min(1).optional(),
    confidence: z.enum(["authoritative", "derived", "user_supplied"])
  })
  .strict();

export const ojProblemRefSchema = z
  .object({
    schemaVersion: z.literal("oj.problem-ref/v1"),
    platform: ojPlatformIdSchema,
    site: z.enum(["global", "cn"]).optional(),
    nativeId: z.string().min(1),
    canonicalId: z.string().min(1),
    url: z.url(),
    contest: z.object({ nativeId: z.string().min(1), index: z.string().min(1).optional() }).strict().optional(),
    source: ojSourceRefSchema
  })
  .strict();

const ojDifficultySchema = z.object({ scale: z.string().min(1), value: z.number().finite().optional(), label: z.string().min(1).optional() }).strict();
const ojTagSchema = z
  .object({
    namespace: z.enum(["platform", "canonical"]),
    id: z.string().min(1).optional(),
    slug: z.string().min(1),
    name: z.string().min(1)
  })
  .strict();

export const ojProblemSummarySchema = z
  .object({
    schemaVersion: z.literal("oj.problem-summary/v1"),
    ref: ojProblemRefSchema,
    title: z.string().min(1),
    difficulty: ojDifficultySchema.optional(),
    tags: z.array(ojTagSchema),
    contestLabel: z.string().min(1).optional(),
    acceptance: z
      .object({
        accepted: z.number().int().nonnegative().optional(),
        submissions: z.number().int().nonnegative().optional(),
        ratio: z.number().min(0).max(1).optional()
      })
      .strict()
      .optional(),
    source: ojSourceRefSchema
  })
  .strict();

export const ojTextBlockSchema = z
  .object({
    text: z.string(),
    format: z.enum(["markdown", "html", "text"]),
    locale: z.string().min(1),
    truncated: z.boolean(),
    originalChars: z.number().int().nonnegative().optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 hex digest.")
  })
  .strict();

export const ojProblemDocumentSchema = z
  .object({
    schemaVersion: z.literal("oj.problem-document/v1"),
    ref: ojProblemRefSchema,
    title: z.string().min(1),
    locale: z.string().min(1),
    access: z.enum(["public", "auth_required", "premium", "contest_only", "unknown"]),
    difficulty: ojDifficultySchema.optional(),
    tags: z.array(ojTagSchema),
    content: z
      .object({
        statement: ojTextBlockSchema,
        input: ojTextBlockSchema.optional(),
        output: ojTextBlockSchema.optional(),
        notes: ojTextBlockSchema.optional()
      })
      .strict(),
    constraints: z.array(z.string()),
    samples: z.array(
      z
        .object({
          ordinal: z.number().int().positive(),
          input: z.string(),
          output: z.string(),
          explanation: z.string().optional()
        })
        .strict()
    ),
    limits: z.object({ timeMs: z.number().positive().optional(), memoryBytes: z.number().int().positive().optional() }).strict(),
    io: z
      .object({
        mode: z.enum(["stdin_stdout", "function", "file", "interactive"]),
        inputFile: z.string().min(1).optional(),
        outputFile: z.string().min(1).optional()
      })
      .strict(),
    starterCode: z.array(
      z.object({ languageKey: z.string().min(1), platformLanguageId: z.string().min(1), code: z.string() }).strict()
    ),
    source: ojSourceRefSchema
  })
  .strict();

export const ojSearchRequestSchema = z
  .object({
    schemaVersion: z.literal("oj.search-request/v1"),
    requestId: z.string().min(1),
    platform: ojPlatformIdSchema,
    query: z.string().trim().min(1),
    locale: z.string().min(1).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(50)
  })
  .strict();

export const ojSearchResultSchema = z
  .object({
    schemaVersion: z.literal("oj.search-result/v1"),
    requestId: z.string().min(1),
    items: z.array(ojProblemSummarySchema),
    nextCursor: z.string().min(1).optional(),
    source: ojSourceRefSchema
  })
  .strict();

export const ojImportWindowRequestSchema = z
  .object({
    schemaVersion: z.literal("oj.import-window-request/v1"),
    requestId: z.string().min(1),
    allowedPlatforms: z.array(ojPlatformIdSchema).min(1),
    expiresInMs: z.number().int().min(1).max(60_000)
  })
  .strict();

export const ojImportWindowSchema = z
  .object({
    schemaVersion: z.literal("oj.import-window/v1"),
    windowId: z.string().min(1),
    expiresAt: z.iso.datetime(),
    state: z.enum(["waiting", "received", "expired", "cancelled"]),
    endpoint: z.url().optional()
  })
  .strict();

export const ojImportPreviewSchema = z
  .object({
    schemaVersion: z.literal("oj.import-preview/v1"),
    windowId: z.string().min(1),
    document: ojProblemDocumentSchema,
    receivedAt: z.iso.datetime()
  })
  .strict();

export const ojCapabilitySchema = z
  .object({
    name: ojCapabilityNameSchema,
    status: z.enum(["available", "auth_required", "unsupported", "disabled_by_policy", "degraded"]),
    toolName: z.string().min(1).optional(),
    transport: z.enum(["remote_http", "local_stdio"]),
    auth: z.enum(["none", "oauth2", "api_key", "session_cookie", "browser"]),
    risk: ojOperationRiskSchema,
    compliance: z.enum(["official", "unofficial", "restricted", "unknown"]),
    reason: z.string().min(1).optional(),
    checkedAt: z.iso.datetime()
  })
  .strict();

export const ojCapabilitiesSchema = z
  .object({
    schemaVersion: z.literal("oj.capabilities/v1"),
    providerId: z.string().min(1),
    providerVersion: z.string().min(1),
    platform: ojPlatformIdSchema,
    protocolVersion: z.string().min(1),
    operations: z.record(ojCapabilityNameSchema, ojCapabilitySchema),
    languages: z.array(
      z
        .object({
          languageKey: z.string().min(1),
          platformLanguageId: z.string().min(1),
          displayName: z.string().min(1)
        })
        .strict()
    ),
    source: ojSourceRefSchema
  })
  .strict()
  .superRefine((capabilities, context) => {
    for (const [name, capability] of Object.entries(capabilities.operations)) {
      if (capability.name !== name) {
        context.addIssue({ code: "custom", path: ["operations", name, "name"], message: "Capability name must match its operation key." });
      }
    }
  });

export const ojVerdictSchema = z.enum([
  "queued",
  "judging",
  "accepted",
  "wrong_answer",
  "compile_error",
  "runtime_error",
  "time_limit",
  "memory_limit",
  "output_limit",
  "idleness_limit",
  "security_violation",
  "partial",
  "skipped",
  "unknown"
]);

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 hex digest.");

export const ojCodeArtifactSchema = z
  .object({
    languageKey: z.string().min(1),
    platformLanguageId: z.string().min(1).optional(),
    source: z.string(),
    sha256: sha256Schema,
    bytes: z.number().int().nonnegative(),
    fileName: z.string().min(1).optional(),
    sourceUri: z.string().min(1).optional(),
    documentVersion: z.number().int().nonnegative().optional(),
    capturedAt: z.iso.datetime(),
    sourceWasDirty: z.boolean()
  })
  .strict()
  .superRefine((artifact, context) => {
    if (new TextEncoder().encode(artifact.source).byteLength !== artifact.bytes) {
      context.addIssue({ code: "custom", path: ["bytes"], message: "Code artifact byte count does not match its UTF-8 source." });
    }
  });

export const ojRunRequestSchema = z
  .object({
    schemaVersion: z.literal("oj.run-request/v1"),
    requestId: z.string().min(1),
    attemptId: z.string().min(1),
    problem: ojProblemRefSchema,
    mode: z.enum(["local", "platform"]),
    code: ojCodeArtifactSchema,
    sampleOrdinals: z.array(z.number().int().positive()).optional(),
    limits: z
      .object({
        wallTimeMs: z.number().int().positive(),
        outputBytes: z.number().int().positive(),
        network: z.literal("deny")
      })
      .strict()
  })
  .strict();

export const ojRunCaseResultSchema = z
  .object({
    ordinal: z.number().int().positive(),
    verdict: ojVerdictSchema,
    timeMs: z.number().nonnegative().optional(),
    memoryBytes: z.number().int().nonnegative().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    expectedOutputSha256: sha256Schema.optional(),
    actualOutputSha256: sha256Schema.optional()
  })
  .strict();

export const ojRunResultSchema = z
  .object({
    schemaVersion: z.literal("oj.run-result/v1"),
    requestId: z.string().min(1),
    jobId: z.string().min(1),
    attemptId: z.string().min(1),
    mode: z.enum(["local", "platform"]),
    state: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
    verdict: ojVerdictSchema,
    codeSha256: sha256Schema,
    cases: z.array(ojRunCaseResultSchema),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
    source: ojSourceRefSchema
  })
  .strict();

export const ojSubmitResultSchema = z
  .object({
    schemaVersion: z.literal("oj.submit-result/v1"),
    requestId: z.string().min(1),
    intentId: z.string().min(1),
    submissionOperationId: z.string().min(1),
    jobId: z.string().min(1).optional(),
    platformSubmissionId: z.string().min(1).optional(),
    submissionUrl: z.url().optional(),
    state: z.enum(["queued", "judging", "completed", "outcome_unknown"]),
    verdict: ojVerdictSchema,
    codeSha256: sha256Schema,
    submittedAt: z.iso.datetime().optional(),
    lastCheckedAt: z.iso.datetime(),
    source: ojSourceRefSchema
  })
  .strict();

export const ojPrepareSubmissionRequestSchema = z
  .object({
    schemaVersion: z.literal("oj.prepare-submission/v1"),
    requestId: z.string().min(1),
    attemptId: z.string().min(1),
    providerId: z.string().min(1),
    problem: ojProblemRefSchema,
    accountId: z.string().min(1),
    languageKey: z.string().min(1),
    platformLanguageId: z.string().min(1),
    code: ojCodeArtifactSchema,
    recentRunId: z.string().min(1).optional()
  })
  .strict();

export const ojSubmitPreviewSchema = z
  .object({
    schemaVersion: z.literal("oj.submit-preview/v1"),
    intentId: z.string().min(1),
    submissionOperationId: z.string().min(1),
    expiresAt: z.iso.datetime(),
    attemptId: z.string().min(1),
    providerId: z.string().min(1),
    problem: ojProblemRefSchema,
    account: z
      .object({ accountId: z.string().min(1), displayName: z.string().min(1), site: z.enum(["global", "cn"]).optional() })
      .strict(),
    languageKey: z.string().min(1),
    platformLanguageId: z.string().min(1),
    codeArtifactId: z.string().min(1),
    fileLabel: z.string().min(1),
    sourceWasDirty: z.boolean(),
    codeSha256: sha256Schema,
    codeBytes: z.number().int().nonnegative(),
    localRunSummary: z
      .object({ runId: z.string().min(1), verdict: ojVerdictSchema, codeSha256: sha256Schema })
      .strict()
      .optional(),
    warnings: z.array(z.string().min(1)),
    actionLabel: z.string().min(1)
  })
  .strict();

export const ojSubmitCommitRequestSchema = z
  .object({
    schemaVersion: z.literal("oj.submit-commit/v1"),
    requestId: z.string().min(1),
    intentId: z.string().min(1),
    submissionOperationId: z.string().min(1),
    codeArtifactId: z.string().min(1),
    confirmationProof: z.string().min(1),
    codeSha256: sha256Schema
  })
  .strict();

export const ojSubmissionEvidenceSchema = z
  .object({
    schemaVersion: z.literal("oj.submission-evidence/v1"),
    evidenceId: z.string().min(1),
    attemptId: z.string().min(1),
    submissionOperationId: z.string().min(1),
    problem: ojProblemRefSchema,
    platformSubmissionId: z.string().min(1).optional(),
    submissionUrl: z.url().optional(),
    verdict: ojVerdictSchema,
    codeSha256: sha256Schema,
    observedAt: z.iso.datetime(),
    terminal: z.boolean(),
    source: ojSourceRefSchema
  })
  .strict();

export const ojProviderHealthSchema = z
  .object({
    schemaVersion: z.literal("oj.provider-health/v1"),
    providerId: z.string().min(1),
    platform: ojPlatformIdSchema,
    checkedAt: z.iso.datetime(),
    overall: z.enum(["healthy", "degraded", "unavailable", "auth_required"]),
    layers: z
      .object({
        transport: z.enum(["pass", "fail"]),
        protocol: z.enum(["pass", "fail"]),
        schema: z.enum(["pass", "drift", "unknown"]),
        auth: z.enum(["not_required", "valid", "expired", "missing", "challenge"]),
        upstream: z.enum(["pass", "timeout", "rate_limited", "blocked", "fail"])
      })
      .strict(),
    latencyMs: z.number().nonnegative().optional(),
    retryAfterMs: z.number().nonnegative().optional(),
    message: z.string().min(1)
  })
  .strict();

export const ojErrorSchema = z
  .object({
    schemaVersion: z.literal("oj.error/v1"),
    code: z.enum([
      "request.invalid",
      "capability.unsupported",
      "policy.blocked",
      "auth.required",
      "auth.invalid",
      "auth.forbidden",
      "challenge.required",
      "resource.not_found",
      "rate_limited",
      "network.timeout",
      "upstream.unavailable",
      "upstream.schema_changed",
      "language.unsupported",
      "runner.unavailable",
      "runner.sandbox_required",
      "confirmation.required",
      "confirmation.expired",
      "confirmation.mismatch",
      "submission.closed",
      "submission.rejected",
      "submission.outcome_unknown",
      "internal"
    ]),
    layer: z.enum(["broker", "transport", "protocol", "auth", "upstream", "runner", "policy"]),
    message: z.string().min(1),
    retryPolicy: z.enum(["never", "safe_read", "poll_only", "after_user_action"]),
    userAction: z.enum(["none", "retry", "sign_in", "solve_challenge", "change_language", "open_logs"]),
    platform: ojPlatformIdSchema.optional(),
    providerId: z.string().min(1).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    upstreamCode: z.string().min(1).optional(),
    requestId: z.string().min(1).optional(),
    jobId: z.string().min(1).optional(),
    retryAfterMs: z.number().nonnegative().optional()
  })
  .strict();

export const ojSchemaRegistry = {
  "problem-ref": ojProblemRefSchema,
  "problem-summary": ojProblemSummarySchema,
  "problem-document": ojProblemDocumentSchema,
  capabilities: ojCapabilitiesSchema,
  "search-request": ojSearchRequestSchema,
  "search-result": ojSearchResultSchema,
  "import-window-request": ojImportWindowRequestSchema,
  "import-window": ojImportWindowSchema,
  "import-preview": ojImportPreviewSchema,
  "run-request": ojRunRequestSchema,
  "run-result": ojRunResultSchema,
  "submit-prepare": ojPrepareSubmissionRequestSchema,
  "submit-preview": ojSubmitPreviewSchema,
  "submit-commit": ojSubmitCommitRequestSchema,
  "submit-result": ojSubmitResultSchema,
  "submission-evidence": ojSubmissionEvidenceSchema,
  "provider-health": ojProviderHealthSchema,
  error: ojErrorSchema,
  "provider-manifest": ojProviderManifestSchema
} as const;

export { ojProviderManifestSchema };
