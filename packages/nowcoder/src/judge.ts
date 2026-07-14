import { createHash, randomUUID } from "node:crypto";
import {
  ojPrepareSubmissionRequestSchema,
  ojRunRequestSchema,
  ojRunResultSchema,
  ojSubmitCommitRequestSchema,
  ojSubmitPreviewSchema,
  ojSubmitResultSchema,
  type OjPrepareSubmissionRequest,
  type OjRunRequest,
  type OjRunResult,
  type OjSubmitCommitRequest,
  type OjSubmitPreview,
  type OjSubmitResult,
  type OjSourceRef,
  type OjVerdict
} from "@kaiserunix/oj-mcp-contracts";
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
  samples: Array<{ ordinal: number; input: string; output: string }>;
  supportedLanguageIds: string[];
}

export interface NowCoderJudgeSubmitPayload {
  content: string;
  questionId: string;
  language: string;
  tagId: 4 | 8;
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
  obtainAccessToken(signal?: AbortSignal): Promise<string>;
  submit(payload: NowCoderJudgeSubmitPayload, signal?: AbortSignal): Promise<Record<string, unknown>>;
  poll(context: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

interface SubmissionIntent {
  preview: OjSubmitPreview;
  request: OjPrepareSubmissionRequest;
  questionId: string;
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
}

export interface NowCoderJudgeServiceOptions {
  gateway: NowCoderJudgeGateway;
  now?: () => number;
  nowIso?: () => string;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  maxPolls?: number;
}

export class NowCoderJudgeService {
  private readonly gateway: NowCoderJudgeGateway;
  private readonly now: () => number;
  private readonly nowIso: () => string;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly maxPolls: number;
  private readonly intents = new Map<string, SubmissionIntent>();
  private readonly jobs = new Map<string, PollJob>();

  constructor(options: NowCoderJudgeServiceOptions) {
    this.gateway = options.gateway;
    this.now = options.now ?? Date.now;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.sleep = options.sleep ?? abortableSleep;
    this.maxPolls = options.maxPolls ?? 32;
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
    const context = await this.gateway.prepareContext(parsed.data.problem.url, parsed.data.accountId, signal);
    if (context.accountId !== parsed.data.accountId) {
      throw new NowCoderAdapterError("auth.forbidden", "The requested NowCoder account does not match the signed-in account.");
    }
    if (!context.supportedLanguageIds.includes(parsed.data.platformLanguageId)) {
      throw new NowCoderAdapterError("language.unsupported", "This NowCoder problem does not accept the selected language ID.");
    }

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
      problem: parsed.data.problem,
      account: { accountId: context.accountId, displayName: context.displayName },
      languageKey: parsed.data.languageKey,
      platformLanguageId: parsed.data.platformLanguageId,
      codeArtifactId,
      fileLabel: parsed.data.code.fileName ?? "student-code",
      sourceWasDirty: parsed.data.code.sourceWasDirty,
      codeSha256: parsed.data.code.sha256,
      codeBytes: parsed.data.code.bytes,
      warnings: parsed.data.code.sourceWasDirty ? ["The captured editor document had unsaved changes."] : [],
      actionLabel: `提交 ${parsed.data.problem.nativeId} 到牛客`
    });
    this.intents.set(intentId, { preview, request: parsed.data, questionId: context.questionId, phase: "prepared" });
    return preview;
  }

  getSubmissionPreview(intentId: string): OjSubmitPreview {
    this.purgeExpiredState();
    const intent = this.intents.get(intentId);
    if (!intent) throw new NowCoderAdapterError("confirmation.expired", "Submission preview expired or was already consumed.");
    return intent.preview;
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
    let token: string;
    try {
      token = await this.gateway.obtainAccessToken(signal);
    } catch (error) {
      intent.phase = "prepared";
      throw error;
    }
    intent.phase = "consumed";
    const payload: NowCoderJudgeSubmitPayload = {
      content: intent.request.code.source,
      questionId: intent.questionId,
      language: intent.request.platformLanguageId,
      tagId: 4,
      appId: 6,
      userId: intent.request.accountId,
      submitType: 1,
      remark: "{contestId: undefined}",
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
      if (error instanceof NowCoderAdapterError && (error.code === "network.timeout" || error.code === "upstream.unavailable")) {
        return ojSubmitResultSchema.parse({
          schemaVersion: "oj.submit-result/v1",
          requestId: parsed.data.requestId,
          intentId: intent.preview.intentId,
          submissionOperationId: intent.preview.submissionOperationId,
          state: "outcome_unknown",
          verdict: "unknown",
          codeSha256: intent.preview.codeSha256,
          lastCheckedAt: checkedAt,
          source: judgeSource(intent.preview.problem.url, checkedAt)
        });
      }
      throw error;
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
    const data = await this.gateway.poll(job.context, signal);
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
    if (terminal) this.jobs.delete(input.submissionOperationId);
    return result;
  }

  async platformRun(input: OjRunRequest, authorized: boolean, signal?: AbortSignal): Promise<OjRunResult> {
    const parsed = ojRunRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.problem.platform !== "nowcoder" || parsed.data.mode !== "platform") {
      throw new NowCoderAdapterError("request.invalid", "Run a valid immutable code artifact against one NowCoder sample.");
    }
    if (!authorized) throw new NowCoderAdapterError("confirmation.required", "Explicit user confirmation is required before uploading code for a platform run.");
    const languageId = parsed.data.code.platformLanguageId;
    if (!languageId || !LANGUAGE_IDS.has(languageId)) throw new NowCoderAdapterError("language.unsupported", "NowCoder does not expose this language ID for the audited ACM editor.");
    if (parsed.data.code.bytes > 1024 * 1024) throw new NowCoderAdapterError("request.invalid", "NowCoder run source must not exceed 1 MiB.");
    assertCodeHash(parsed.data.code.source, parsed.data.code.sha256);
    if ((parsed.data.sampleOrdinals?.length ?? 0) > 1) throw new NowCoderAdapterError("request.invalid", "NowCoder platform self-test accepts one sample per run.");

    const startedAt = this.nowIso();
    const preparation = await this.gateway.prepareContext(parsed.data.problem.url, undefined, signal);
    if (!preparation.supportedLanguageIds.includes(languageId)) {
      throw new NowCoderAdapterError("language.unsupported", "This NowCoder problem does not accept the selected language ID.");
    }
    const ordinal = parsed.data.sampleOrdinals?.[0] ?? 1;
    const sample = preparation.samples.find((candidate) => candidate.ordinal === ordinal);
    if (!sample) throw new NowCoderAdapterError("resource.not_found", "The selected NowCoder sample was not found.");
    const token = await this.gateway.obtainAccessToken(signal);
    const payload: NowCoderJudgeSubmitPayload = {
      content: parsed.data.code.source,
      questionId: preparation.questionId,
      language: languageId,
      tagId: 8,
      appId: 6,
      userId: preparation.accountId,
      submitType: 2,
      remark: "{contestId: undefined}",
      token,
      selfInputData: sample.input,
      selfOutputData: sample.output
    };
    let submitted: Record<string, unknown>;
    try {
      submitted = await this.gateway.submit(payload, signal);
    } catch (error) {
      if (error instanceof NowCoderAdapterError && (error.code === "network.timeout" || error.code === "upstream.unavailable")) {
        return runResult(parsed.data, randomUUID(), startedAt, this.nowIso(), ordinal, "failed", "unknown", sample, {}, parsed.data.problem.url);
      }
      throw error;
    }
    const jobId = identifier(submitted.id);
    if (!jobId) throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder run response did not contain a job ID.");
    const context = { ...payload, ...submitted, id: jobId, showId: 6 };
    for (let poll = 0; poll < this.maxPolls; poll += 1) {
      if (poll > 0) await this.sleep(1_000, signal);
      const statusData = await this.gateway.poll(context, signal);
      const status = numeric(statusData.status);
      if (status === undefined) throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder run status did not include a numeric state.");
      if (status < 3) continue;
      const output = text(statusData.userOutput) ?? text(statusData.stdout) ?? "";
      const verdict = status === 28
        ? normalizeOutput(output) === normalizeOutput(sample.output) ? "accepted" : "wrong_answer"
        : judgeVerdict(status, statusData);
      return runResult(parsed.data, jobId, startedAt, this.nowIso(), ordinal, "completed", verdict, sample, statusData, parsed.data.problem.url);
    }
    return runResult(parsed.data, jobId, startedAt, undefined, ordinal, "running", "judging", sample, {}, parsed.data.problem.url);
  }

  private purgeExpiredState(): void {
    const now = this.now();
    for (const [intentId, intent] of this.intents) {
      if (Date.parse(intent.preview.expiresAt) <= now) this.intents.delete(intentId);
    }
    for (const [operationId, job] of this.jobs) {
      if (job.expiresAtMs <= now) this.jobs.delete(operationId);
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

function runResult(
  request: OjRunRequest,
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
