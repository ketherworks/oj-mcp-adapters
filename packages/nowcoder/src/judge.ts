import { createHash, randomUUID } from "node:crypto";
import {
  ojPrepareSubmissionRequestSchema,
  ojRunRequestSchema,
  ojRunResultSchema,
  ojSubmitCommitRequestSchema,
  ojSubmitPreviewSchema,
  ojSubmitResultSchema,
  type OjPrepareSubmissionRequest,
  type OjProblemRef,
  type OjRunRequest,
  type OjRunResult,
  type OjSubmitCommitRequest,
  type OjSubmitPreview,
  type OjSubmitResult,
  type OjSourceRef,
  type OjVerdict
} from "@kaiserunix/oj-mcp-contracts";
import { safeConfirmationValue, verifySavedCodeArtifact, type NowCoderArtifactVerifier } from "./artifact.js";
import { NowCoderAdapterError } from "./errors.js";

const PROVIDER_ID = "nowcoder-public-page";
const INTENT_TTL_MS = 2 * 60 * 1_000;
const POLL_JOB_TTL_MS = 10 * 60 * 1_000;
const LANGUAGE_IDS = new Set([
  "1", "2", "3", "4", "5", "8", "9", "10", "11", "13", "14", "16", "17", "19", "20", "21", "24", "25", "27", "28", "29", "30", "31"
]);

export const NOWCODER_JUDGE_LANGUAGES = [
  ["c", "1", "C"], ["cpp", "2", "C++"], ["pascal", "3", "Pascal"], ["java", "4", "Java"],
  ["python2", "5", "Python 2"], ["php", "8", "PHP"], ["csharp", "9", "C#"], ["objective-c", "10", "Objective-C"],
  ["python", "11", "Python 3"], ["javascript", "13", "JavaScript Node"], ["javascript-v8", "14", "JavaScript V8"],
  ["r", "16", "R"], ["go", "17", "Go"], ["ruby", "19", "Ruby"], ["swift", "20", "Swift"],
  ["matlab", "21", "MATLAB/Octave"], ["pypy2", "24", "PyPy 2"], ["pypy3", "25", "PyPy 3"],
  ["rust", "27", "Rust"], ["scala", "28", "Scala"], ["kotlin", "29", "Kotlin"], ["groovy", "30", "Groovy"],
  ["typescript", "31", "TypeScript"]
].map(([languageKey, platformLanguageId, displayName]) => ({ languageKey: languageKey!, platformLanguageId: platformLanguageId!, displayName: displayName! }));

export interface NowCoderJudgePreparation {
  accountId: string;
  displayName: string;
  questionId: string;
  problem: OjProblemRef;
  userId: string;
  tagId: 4;
  contestId?: string;
  teamId?: string;
  samples: Array<{ ordinal: number; input: string; output: string }>;
  supportedLanguageIds: string[];
}

export interface NowCoderJudgeSubmitPayload {
  content: string;
  questionId: string;
  language: string;
  tagId: 4;
  appId: 6;
  userId: string;
  submitType: 1 | 2;
  remark: string;
  token: string;
  selfInputData?: string;
  selfOutputData?: string;
}

export interface NowCoderJudgeGateway {
  prepareContext(problemUrl: string, accountId?: string, signal?: AbortSignal): Promise<NowCoderJudgePreparation>;
  obtainAccessToken(teamId?: string, signal?: AbortSignal): Promise<string>;
  submit(payload: NowCoderJudgeSubmitPayload, signal?: AbortSignal): Promise<Record<string, unknown>>;
  poll(context: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

interface SubmissionIntent {
  preview: OjSubmitPreview;
  request: OjPrepareSubmissionRequest;
  preparation: NowCoderJudgePreparation;
  verifiedFilePath: string;
  phase: "prepared" | "committing" | "consumed";
}

interface PollJob {
  intentId: string;
  operationId: string;
  codeSha256: string;
  context: Record<string, unknown>;
  problemUrl: string;
  jobId: string;
  platformSubmissionId: string;
  submittedAt: string;
  expiresAtMs: number;
  terminalResult?: OjSubmitResult;
}

export interface NowCoderPlatformRunPreview {
  intentId: string;
  expiresAt: string;
  requestId: string;
  problem: OjProblemRef;
  submissionTarget: { kind: "account" | "team"; id: string; contestId?: string };
  languageKey: string;
  platformLanguageId: string;
  filePath: string;
  codeSha256: string;
  codeBytes: number;
  sampleOrdinal: number;
}

interface PlatformRunIntent {
  preview: NowCoderPlatformRunPreview;
  request: OjRunRequest;
  preparation: NowCoderJudgePreparation;
  sample: { ordinal: number; input: string; output: string };
  phase: "prepared" | "committing" | "consumed";
}

interface PlatformRunJob {
  requestId: string;
  jobId: string;
  request: RunResultRequest;
  sample: { ordinal: number; input: string; output: string };
  startedAt: string;
  problemUrl: string;
  expiresAtMs: number;
  context?: Record<string, unknown>;
  terminalResult?: OjRunResult;
}

export interface NowCoderJudgeServiceOptions {
  gateway: NowCoderJudgeGateway;
  now?: () => number;
  nowIso?: () => string;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  maxPolls?: number;
  verifyArtifact?: NowCoderArtifactVerifier;
}

export class NowCoderJudgeService {
  private readonly gateway: NowCoderJudgeGateway;
  private readonly now: () => number;
  private readonly nowIso: () => string;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly maxPolls: number;
  private readonly verifyArtifact: NowCoderArtifactVerifier;
  private readonly intents = new Map<string, SubmissionIntent>();
  private readonly jobs = new Map<string, PollJob>();
  private readonly runIntents = new Map<string, PlatformRunIntent>();
  private readonly runJobs = new Map<string, PlatformRunJob>();
  private readonly reservedRunRequestIds = new Set<string>();

  constructor(options: NowCoderJudgeServiceOptions) {
    this.gateway = options.gateway;
    this.now = options.now ?? Date.now;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.sleep = options.sleep ?? abortableSleep;
    this.maxPolls = options.maxPolls ?? 32;
    this.verifyArtifact = options.verifyArtifact ?? verifySavedCodeArtifact;
  }

  async prepareSubmission(input: OjPrepareSubmissionRequest, signal?: AbortSignal): Promise<OjSubmitPreview> {
    this.purgeExpiredState();
    const parsed = ojPrepareSubmissionRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.providerId !== PROVIDER_ID || parsed.data.problem.platform !== "nowcoder") {
      throw new NowCoderAdapterError("request.invalid", "Prepare a NowCoder submission with a valid immutable code artifact.");
    }
    if (!LANGUAGE_IDS.has(parsed.data.platformLanguageId)) {
      throw new NowCoderAdapterError("language.unsupported", "NowCoder does not expose this language ID for the audited ACM editor.");
    }
    if (parsed.data.code.bytes > 1024 * 1024) {
      throw new NowCoderAdapterError("request.invalid", "NowCoder submission source must not exceed 1 MiB.");
    }
    assertCodeHash(parsed.data.code.source, parsed.data.code.sha256);
    safeConfirmationValue(parsed.data.languageKey, "Language name");
    const verified = await this.verifyArtifact(parsed.data.code, signal);
    const context = await this.gateway.prepareContext(parsed.data.problem.url, parsed.data.accountId, signal);
    if (context.accountId !== parsed.data.accountId) {
      throw new NowCoderAdapterError("auth.forbidden", "The requested NowCoder account does not match the signed-in account.");
    }
    if (!context.supportedLanguageIds.includes(parsed.data.platformLanguageId)) {
      throw new NowCoderAdapterError("language.unsupported", "This NowCoder problem does not accept the selected language ID.");
    }
    assertProblemMatch(parsed.data.problem, context.problem);

    const intentId = randomUUID();
    const submissionOperationId = randomUUID();
    const codeArtifactId = randomUUID();
    const preview = ojSubmitPreviewSchema.parse({
      schemaVersion: "oj.submit-preview/v1",
      intentId,
      submissionOperationId,
      expiresAt: new Date(this.now() + INTENT_TTL_MS).toISOString(),
      attemptId: parsed.data.attemptId,
      providerId: PROVIDER_ID,
      problem: context.problem,
      account: { accountId: context.accountId, displayName: context.displayName },
      submissionTarget: submissionTarget(context),
      languageKey: parsed.data.languageKey,
      platformLanguageId: parsed.data.platformLanguageId,
      codeArtifactId,
      fileLabel: verified.fileName,
      sourceWasDirty: false,
      codeSha256: parsed.data.code.sha256,
      codeBytes: parsed.data.code.bytes,
      warnings: context.teamId ? [`提交主体为团队 ${context.teamId}`] : [],
      actionLabel: `提交 ${context.problem.nativeId} 到牛客`
    });
    this.intents.set(intentId, {
      preview,
      request: { ...parsed.data, problem: context.problem },
      preparation: context,
      verifiedFilePath: verified.filePath,
      phase: "prepared"
    });
    return preview;
  }

  getSubmissionPreview(intentId: string): OjSubmitPreview {
    this.purgeExpiredState();
    const intent = this.intents.get(intentId);
    if (!intent) throw new NowCoderAdapterError("confirmation.expired", "Submission preview expired or was already consumed.");
    return intent.preview;
  }

  getSubmissionConfirmation(intentId: string): { preview: OjSubmitPreview; filePath: string } {
    const preview = this.getSubmissionPreview(intentId);
    const intent = this.intents.get(intentId)!;
    return { preview, filePath: intent.verifiedFilePath };
  }

  async commitSubmission(input: OjSubmitCommitRequest, authorized: boolean, signal?: AbortSignal): Promise<OjSubmitResult> {
    const parsed = ojSubmitCommitRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new NowCoderAdapterError("request.invalid", "Commit input did not match the prepared submission contract.");
    }
    if (!authorized) {
      throw new NowCoderAdapterError("confirmation.required", "Explicit user confirmation is required for every real submission.");
    }
    const intent = this.intents.get(parsed.data.intentId);
    if (!intent) throw new NowCoderAdapterError("confirmation.expired", "Submission preview expired or was already consumed.");
    if (Date.parse(intent.preview.expiresAt) <= this.now()) {
      this.intents.delete(parsed.data.intentId);
      throw new NowCoderAdapterError("confirmation.expired", "Submission preview expired.");
    }
    if (
      intent.phase !== "prepared"
      || parsed.data.submissionOperationId !== intent.preview.submissionOperationId
      || parsed.data.codeArtifactId !== intent.preview.codeArtifactId
      || parsed.data.codeSha256 !== intent.preview.codeSha256
    ) {
      throw new NowCoderAdapterError("confirmation.mismatch", "Submission confirmation did not match the immutable preview.");
    }

    intent.phase = "committing";
    let verified;
    try {
      verified = await this.verifyArtifact(intent.request.code, signal);
      if (verified.filePath !== intent.verifiedFilePath) {
        throw new NowCoderAdapterError("confirmation.mismatch", "The resolved source path changed after confirmation.");
      }
    } catch (error) {
      this.intents.delete(intent.preview.intentId);
      throw error;
    }
    let token: string;
    try {
      token = await this.gateway.obtainAccessToken(intent.preparation.teamId, signal);
    } catch (error) {
      intent.phase = "prepared";
      throw error;
    }
    intent.phase = "consumed";
    const payload: NowCoderJudgeSubmitPayload = {
      content: intent.request.code.source,
      questionId: intent.preparation.questionId,
      language: intent.request.platformLanguageId,
      tagId: intent.preparation.tagId,
      appId: 6,
      userId: intent.preparation.userId,
      submitType: 1,
      remark: contestRemark(intent.preparation.contestId),
      token
    };
    const checkedAt = this.nowIso();
    try {
      const submitted = await this.gateway.submit(payload, signal);
      this.intents.delete(intent.preview.intentId);
      const jobId = identifier(submitted.id);
      if (!jobId) throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder submit response did not contain a job ID.");
      const platformSubmissionId = identifier(submitted.submissionId) ?? jobId;
      this.jobs.set(intent.preview.submissionOperationId, {
        intentId: intent.preview.intentId,
        operationId: intent.preview.submissionOperationId,
        codeSha256: intent.preview.codeSha256,
        problemUrl: intent.preview.problem.url,
        jobId,
        platformSubmissionId,
        submittedAt: checkedAt,
        expiresAtMs: this.now() + POLL_JOB_TTL_MS,
        context: pollContext(payload, submitted, jobId)
      });
      return ojSubmitResultSchema.parse({
        schemaVersion: "oj.submit-result/v1",
        requestId: parsed.data.requestId,
        intentId: intent.preview.intentId,
        submissionOperationId: intent.preview.submissionOperationId,
        jobId,
        platformSubmissionId,
        submissionUrl: `https://ac.nowcoder.com/acm/contest/view-submission?submissionId=${platformSubmissionId}`,
        state: "queued",
        verdict: "queued",
        codeSha256: intent.preview.codeSha256,
        submittedAt: checkedAt,
        lastCheckedAt: checkedAt,
        source: judgeSource(intent.preview.problem.url, checkedAt)
      });
    } catch (error) {
      this.intents.delete(intent.preview.intentId);
      if (isDefiniteSubmitRejection(error)) throw error;
      return unknownSubmissionResult(parsed.data.requestId, intent.preview, checkedAt);
    }
  }

  async pollSubmission(
    input: { requestId: string; submissionOperationId: string },
    signal?: AbortSignal
  ): Promise<OjSubmitResult> {
    if (!input.requestId || !input.submissionOperationId) {
      throw new NowCoderAdapterError("request.invalid", "Poll a known NowCoder submission operation.");
    }
    this.purgeExpiredState();
    const job = this.jobs.get(input.submissionOperationId);
    if (!job) throw new NowCoderAdapterError("resource.not_found", "NowCoder submission operation was not found in this process.");
    const cached = cachedSubmissionResult(job, input.requestId);
    if (cached) return cached;
    const data = await this.gateway.poll(job.context, signal);
    const concurrentTerminal = cachedSubmissionResult(job, input.requestId);
    if (concurrentTerminal) return concurrentTerminal;
    const status = numeric(data.status);
    if (status === undefined) throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder judge status did not include a numeric state.");
    const terminal = status >= 3;
    const platformSubmissionId = identifier(data.submissionId) ?? job.platformSubmissionId;
    const checkedAt = this.nowIso();
    const result = ojSubmitResultSchema.parse({
      schemaVersion: "oj.submit-result/v1",
      requestId: input.requestId,
      intentId: job.intentId,
      submissionOperationId: job.operationId,
      jobId: job.jobId,
      platformSubmissionId,
      submissionUrl: `https://ac.nowcoder.com/acm/contest/view-submission?submissionId=${platformSubmissionId}`,
      state: terminal ? "completed" : "judging",
      verdict: judgeVerdict(status, data),
      codeSha256: job.codeSha256,
      submittedAt: job.submittedAt,
      lastCheckedAt: checkedAt,
      source: judgeSource(job.problemUrl, checkedAt)
    });
    if (terminal) job.terminalResult = result;
    return result;
  }

  async preparePlatformRun(input: OjRunRequest, signal?: AbortSignal): Promise<NowCoderPlatformRunPreview> {
    this.purgeExpiredState();
    const parsed = ojRunRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.problem.platform !== "nowcoder" || parsed.data.mode !== "platform") {
      throw new NowCoderAdapterError("request.invalid", "Run a valid immutable code artifact against one NowCoder sample.");
    }
    if (this.runJobs.has(parsed.data.requestId) || this.reservedRunRequestIds.has(parsed.data.requestId)) {
      throw new NowCoderAdapterError("policy.blocked", "This platform-run requestId was already prepared or dispatched; use oj_poll_run after dispatch.");
    }
    this.reservedRunRequestIds.add(parsed.data.requestId);
    try {
    const languageId = parsed.data.code.platformLanguageId;
    if (!languageId || !LANGUAGE_IDS.has(languageId)) throw new NowCoderAdapterError("language.unsupported", "NowCoder does not expose this language ID for the audited ACM editor.");
    if (parsed.data.code.bytes > 1024 * 1024) throw new NowCoderAdapterError("request.invalid", "NowCoder run source must not exceed 1 MiB.");
    assertCodeHash(parsed.data.code.source, parsed.data.code.sha256);
    safeConfirmationValue(parsed.data.code.languageKey, "Language name");
    if ((parsed.data.sampleOrdinals?.length ?? 0) > 1) throw new NowCoderAdapterError("request.invalid", "NowCoder platform self-test accepts one sample per run.");

    const verified = await this.verifyArtifact(parsed.data.code, signal);
    const preparation = await this.gateway.prepareContext(parsed.data.problem.url, undefined, signal);
    assertProblemMatch(parsed.data.problem, preparation.problem);
    if (!preparation.supportedLanguageIds.includes(languageId)) {
      throw new NowCoderAdapterError("language.unsupported", "This NowCoder problem does not accept the selected language ID.");
    }
    const ordinal = parsed.data.sampleOrdinals?.[0] ?? 1;
    const sample = preparation.samples.find((candidate) => candidate.ordinal === ordinal);
    if (!sample) throw new NowCoderAdapterError("resource.not_found", "The selected NowCoder sample was not found.");
    const intentId = randomUUID();
    const preview: NowCoderPlatformRunPreview = {
      intentId,
      expiresAt: new Date(this.now() + INTENT_TTL_MS).toISOString(),
      requestId: parsed.data.requestId,
      problem: preparation.problem,
      submissionTarget: submissionTarget(preparation),
      languageKey: parsed.data.code.languageKey,
      platformLanguageId: languageId,
      filePath: verified.filePath,
      codeSha256: parsed.data.code.sha256,
      codeBytes: parsed.data.code.bytes,
      sampleOrdinal: ordinal
    };
    this.runIntents.set(intentId, {
      preview,
      request: { ...parsed.data, problem: preparation.problem },
      preparation,
      sample,
      phase: "prepared"
    });
    return preview;
    } catch (error) {
      this.reservedRunRequestIds.delete(parsed.data.requestId);
      throw error;
    }
  }

  async commitPlatformRun(intentId: string, authorized: boolean, signal?: AbortSignal): Promise<OjRunResult> {
    const intent = this.runIntents.get(intentId);
    if (!intent) throw new NowCoderAdapterError("confirmation.expired", "Platform-run preview expired or was already consumed.");
    if (!authorized) {
      this.runIntents.delete(intentId);
      this.reservedRunRequestIds.delete(intent.request.requestId);
      throw new NowCoderAdapterError("confirmation.required", "Explicit user confirmation is required before uploading code for a platform run.");
    }
    if (intent.phase !== "prepared" || Date.parse(intent.preview.expiresAt) <= this.now()) {
      this.runIntents.delete(intentId);
      this.reservedRunRequestIds.delete(intent.request.requestId);
      throw new NowCoderAdapterError("confirmation.expired", "Platform-run preview expired or was already consumed.");
    }
    intent.phase = "committing";
    try {
      const verified = await this.verifyArtifact(intent.request.code, signal);
      if (verified.filePath !== intent.preview.filePath) {
        throw new NowCoderAdapterError("confirmation.mismatch", "The resolved source path changed after confirmation.");
      }
    } catch (error) {
      this.runIntents.delete(intentId);
      this.reservedRunRequestIds.delete(intent.request.requestId);
      throw error;
    }
    let token: string;
    try {
      token = await this.gateway.obtainAccessToken(intent.preparation.teamId, signal);
    } catch (error) {
      this.runIntents.delete(intentId);
      this.reservedRunRequestIds.delete(intent.request.requestId);
      throw error;
    }
    intent.phase = "consumed";
    const startedAt = this.nowIso();
    const payload: NowCoderJudgeSubmitPayload = {
      content: intent.request.code.source,
      questionId: intent.preparation.questionId,
      language: intent.preview.platformLanguageId,
      tagId: intent.preparation.tagId,
      appId: 6,
      userId: intent.preparation.userId,
      submitType: 2,
      remark: contestRemark(intent.preparation.contestId),
      token,
      selfInputData: intent.sample.input,
      selfOutputData: intent.sample.output
    };
    let submitted: Record<string, unknown>;
    try {
      submitted = await this.gateway.submit(payload, signal);
    } catch (error) {
      this.runIntents.delete(intentId);
      this.reservedRunRequestIds.delete(intent.request.requestId);
      if (isDefiniteSubmitRejection(error)) throw error;
      const result = runResult(intent.request, randomUUID(), startedAt, this.nowIso(), intent.sample.ordinal, "failed", "unknown", intent.sample, {}, intent.request.problem.url);
      this.runJobs.set(intent.request.requestId, {
        requestId: intent.request.requestId,
        jobId: result.jobId,
        request: compactRunRequest(intent.request),
        sample: intent.sample,
        startedAt,
        problemUrl: intent.request.problem.url,
        expiresAtMs: this.now() + POLL_JOB_TTL_MS,
        terminalResult: result
      });
      return result;
    }
    const jobId = identifier(submitted.id);
    if (!jobId) {
      this.runIntents.delete(intentId);
      const result = runResult(intent.request, randomUUID(), startedAt, this.nowIso(), intent.sample.ordinal, "failed", "unknown", intent.sample, {}, intent.request.problem.url);
      this.runJobs.set(intent.request.requestId, {
        requestId: intent.request.requestId,
        jobId: result.jobId,
        request: compactRunRequest(intent.request),
        sample: intent.sample,
        startedAt,
        problemUrl: intent.request.problem.url,
        expiresAtMs: this.now() + POLL_JOB_TTL_MS,
        terminalResult: result
      });
      this.reservedRunRequestIds.delete(intent.request.requestId);
      return result;
    }
    const context = pollContext(payload, submitted, jobId);
    const job: PlatformRunJob = {
      requestId: intent.request.requestId,
      jobId,
      request: compactRunRequest(intent.request),
      sample: intent.sample,
      startedAt,
      problemUrl: intent.request.problem.url,
      expiresAtMs: this.now() + POLL_JOB_TTL_MS,
      context
    };
    this.runJobs.set(job.requestId, job);
    this.runIntents.delete(intentId);
    this.reservedRunRequestIds.delete(job.requestId);
    try {
      return await this.pollRunJob(job, this.maxPolls, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      return runResult(job.request, job.jobId, job.startedAt, undefined, job.sample.ordinal, "running", "judging", job.sample, {}, job.problemUrl);
    }
  }

  async pollPlatformRun(input: { requestId: string }, signal?: AbortSignal): Promise<OjRunResult> {
    if (!input.requestId) throw new NowCoderAdapterError("request.invalid", "Poll a known NowCoder platform-run requestId.");
    this.purgeExpiredState();
    const job = this.runJobs.get(input.requestId);
    if (!job) throw new NowCoderAdapterError("resource.not_found", "NowCoder platform-run request was not found in this process.");
    return this.pollRunJob(job, 1, signal);
  }

  cancelPlatformRun(intentId: string): void {
    const intent = this.runIntents.get(intentId);
    if (!intent) return;
    this.runIntents.delete(intentId);
    this.reservedRunRequestIds.delete(intent.request.requestId);
  }

  async platformRun(input: OjRunRequest, authorized: boolean, signal?: AbortSignal): Promise<OjRunResult> {
    const preview = await this.preparePlatformRun(input, signal);
    return this.commitPlatformRun(preview.intentId, authorized, signal);
  }

  private async pollRunJob(job: PlatformRunJob, polls: number, signal?: AbortSignal): Promise<OjRunResult> {
    if (job.terminalResult) return job.terminalResult;
    if (!job.context) throw new NowCoderAdapterError("internal", "NowCoder platform-run job lost its polling context.");
    for (let poll = 0; poll < polls; poll += 1) {
      if (poll > 0) await this.sleep(1_000, signal);
      const statusData = await this.gateway.poll(job.context, signal);
      if (job.terminalResult) return job.terminalResult;
      const status = numeric(statusData.status);
      if (status === undefined) throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder run status did not include a numeric state.");
      if (status < 3) continue;
      const output = text(statusData.userOutput) ?? text(statusData.stdout) ?? "";
      const verdict = status === 28
        ? normalizeOutput(output) === normalizeOutput(job.sample.output) ? "accepted" : "wrong_answer"
        : judgeVerdict(status, statusData);
      const result = runResult(job.request, job.jobId, job.startedAt, this.nowIso(), job.sample.ordinal, "completed", verdict, job.sample, statusData, job.problemUrl);
      job.terminalResult = result;
      return result;
    }
    return runResult(job.request, job.jobId, job.startedAt, undefined, job.sample.ordinal, "running", "judging", job.sample, {}, job.problemUrl);
  }

  private purgeExpiredState(): void {
    const now = this.now();
    for (const [intentId, intent] of this.intents) {
      if (Date.parse(intent.preview.expiresAt) <= now) this.intents.delete(intentId);
    }
    for (const [operationId, job] of this.jobs) {
      if (job.expiresAtMs <= now) this.jobs.delete(operationId);
    }
    for (const [intentId, intent] of this.runIntents) {
      if (Date.parse(intent.preview.expiresAt) <= now) {
        this.runIntents.delete(intentId);
        this.reservedRunRequestIds.delete(intent.request.requestId);
      }
    }
    for (const [requestId, job] of this.runJobs) {
      if (job.expiresAtMs <= now) this.runJobs.delete(requestId);
    }
  }
}

function identifier(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function assertCodeHash(source: string, claimedSha256: string): void {
  const actualSha256 = createHash("sha256").update(source).digest("hex");
  if (actualSha256 !== claimedSha256.toLowerCase()) {
    throw new NowCoderAdapterError("request.invalid", "Code artifact SHA-256 does not match its source.");
  }
}

function assertProblemMatch(requested: OjProblemRef, resolved: OjProblemRef): void {
  if (
    requested.platform !== resolved.platform
    || requested.nativeId !== resolved.nativeId
    || requested.canonicalId !== resolved.canonicalId
    || requested.url !== resolved.url
  ) {
    throw new NowCoderAdapterError("confirmation.mismatch", "The requested problem reference does not match the official page resolved from its URL.");
  }
}

function submissionTarget(preparation: NowCoderJudgePreparation): { kind: "account" | "team"; id: string; contestId?: string } {
  return {
    kind: preparation.teamId ? "team" : "account",
    id: preparation.userId,
    ...(preparation.contestId ? { contestId: preparation.contestId } : {})
  };
}

function contestRemark(contestId?: string): string {
  return `{contestId: ${contestId ?? "undefined"}}`;
}

function isDefiniteSubmitRejection(error: unknown): boolean {
  return error instanceof NowCoderAdapterError && [
    "submission.rejected",
    "auth.required",
    "auth.invalid",
    "auth.forbidden",
    "language.unsupported",
    "request.invalid",
    "policy.blocked"
  ].includes(error.code);
}

function unknownSubmissionResult(requestId: string, preview: OjSubmitPreview, checkedAt: string): OjSubmitResult {
  return ojSubmitResultSchema.parse({
    schemaVersion: "oj.submit-result/v1",
    requestId,
    intentId: preview.intentId,
    submissionOperationId: preview.submissionOperationId,
    state: "outcome_unknown",
    verdict: "unknown",
    codeSha256: preview.codeSha256,
    lastCheckedAt: checkedAt,
    source: judgeSource(preview.problem.url, checkedAt)
  });
}

function cachedSubmissionResult(job: PollJob, requestId: string): OjSubmitResult | undefined {
  return job.terminalResult === undefined
    ? undefined
    : ojSubmitResultSchema.parse({ ...job.terminalResult, requestId });
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeOutput(value: string): string {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

interface RunResultRequest {
  requestId: string;
  attemptId: string;
  code: { sha256: string };
}

function compactRunRequest(request: OjRunRequest): RunResultRequest {
  return { requestId: request.requestId, attemptId: request.attemptId, code: { sha256: request.code.sha256 } };
}

function runResult(
  request: RunResultRequest,
  jobId: string,
  startedAt: string,
  completedAt: string | undefined,
  ordinal: number,
  state: OjRunResult["state"],
  verdict: OjVerdict,
  sample: { input: string; output: string },
  data: Record<string, unknown>,
  problemUrl: string
): OjRunResult {
  const stdout = text(data.userOutput) ?? text(data.stdout);
  const stderr = text(data.error) ?? text(data.memo);
  const actualOutputSha256 = stdout === undefined ? undefined : createHash("sha256").update(stdout).digest("hex");
  return ojRunResultSchema.parse({
    schemaVersion: "oj.run-result/v1",
    requestId: request.requestId,
    jobId,
    attemptId: request.attemptId,
    mode: "platform",
    state,
    verdict,
    codeSha256: request.code.sha256,
    cases: [{
      ordinal,
      verdict,
      ...(numeric(data.timeConsumption) === undefined ? {} : { timeMs: numeric(data.timeConsumption) }),
      ...(numeric(data.memoryConsumption) === undefined ? {} : { memoryBytes: numeric(data.memoryConsumption) }),
      ...(stdout === undefined ? {} : { stdout }),
      ...(stderr === undefined ? {} : { stderr }),
      expectedOutputSha256: createHash("sha256").update(sample.output).digest("hex"),
      ...(actualOutputSha256 === undefined ? {} : { actualOutputSha256 })
    }],
    startedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    source: judgeSource(problemUrl, completedAt ?? startedAt)
  });
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("NowCoder run cancelled.", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("NowCoder run cancelled.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function judgeVerdict(status: number, data: Record<string, unknown>): OjVerdict {
  if (status < 3) return status === 0 ? "queued" : "judging";
  if (status === 5) return "accepted";
  if (status === 6) return "time_limit";
  if (status === 12) return "compile_error";
  const description = [data.judgeReplyDesc, data.enJudgeReplyDesc, data.desc, data.memo]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (/答案正确|accepted/i.test(description)) return "accepted";
  if (/答案错误|wrong answer/i.test(description)) return "wrong_answer";
  if (/编译|compile/i.test(description)) return "compile_error";
  if (/超时|time limit/i.test(description)) return "time_limit";
  if (/内存|memory limit/i.test(description)) return "memory_limit";
  if (/运行错误|runtime|段错误|浮点错误|返回非零/i.test(description)) return "runtime_error";
  return "unknown";
}

function pollContext(
  payload: NowCoderJudgeSubmitPayload,
  submitted: Record<string, unknown>,
  jobId: string
): Record<string, unknown> {
  const protectedKeys = new Set(["id", "userId", "appId", "tagId", "submitType", "remark", "token", "showId", "content", "selfInputData", "selfOutputData"]);
  const context: Record<string, unknown> = {
    id: jobId,
    userId: payload.userId,
    appId: payload.appId,
    tagId: payload.tagId,
    submitType: payload.submitType,
    remark: payload.remark,
    token: payload.token,
    showId: 6
  };
  for (const [key, value] of Object.entries(submitted)) {
    if (protectedKeys.has(key)) continue;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    if (typeof value === "string" && value.length <= 4_096) context[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") context[key] = value;
  }
  return context;
}

function judgeSource(problemUrl: string, fetchedAt: string): OjSourceRef {
  return {
    kind: "community_adapter",
    adapterId: "nowcoder-judge-adapter",
    adapterVersion: "0.2.0",
    fetchedAt,
    sourceUrl: problemUrl,
    confidence: "derived"
  };
}
