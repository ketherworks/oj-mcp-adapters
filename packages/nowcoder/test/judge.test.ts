import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import type { OjPrepareSubmissionRequest, OjRunRequest, OjSubmitCommitRequest } from "@kaiserunix/oj-mcp-contracts";
import { NowCoderAdapterError } from "../src/errors.js";
import { NowCoderJudgeService, type NowCoderJudgeGateway } from "../src/judge.js";

const capturedAt = "2026-07-14T17:00:00.000Z";
const source = "#include <iostream>\nint main(){return 0;}\n";
const sha256 = createHash("sha256").update(source).digest("hex");

function request(): OjPrepareSubmissionRequest {
  return {
    schemaVersion: "oj.prepare-submission/v1",
    requestId: "prepare-1",
    attemptId: "attempt-1",
    providerId: "nowcoder-public-page",
    problem: {
      schemaVersion: "oj.problem-ref/v1",
      platform: "nowcoder",
      nativeId: "NC218144",
      canonicalId: "nowcoder:NC218144",
      url: "https://ac.nowcoder.com/acm/problem/218144",
      source: {
        kind: "page_adapter",
        adapterId: "nowcoder-public-page",
        adapterVersion: "0.2.0",
        fetchedAt: capturedAt,
        sourceUrl: "https://ac.nowcoder.com/acm/problem/218144",
        confidence: "derived"
      }
    },
    accountId: "123456789",
    languageKey: "cpp",
    platformLanguageId: "2",
    code: {
      languageKey: "cpp",
      platformLanguageId: "2",
      source,
      sha256,
      bytes: Buffer.byteLength(source),
      fileName: "main.cpp",
      capturedAt,
      sourceWasDirty: false
    }
  };
}

describe("NowCoder submission controller", () => {
  test("prepares an immutable preview without obtaining a token or submitting", async () => {
    const gateway = gatewayFixture();
    const service = new NowCoderJudgeService({ gateway, verifyArtifact, now: () => Date.parse(capturedAt), nowIso: () => capturedAt });

    const preview = await service.prepareSubmission(request());

    expect(preview).toMatchObject({
      schemaVersion: "oj.submit-preview/v1",
      attemptId: "attempt-1",
      account: { accountId: "123456789", displayName: "student" },
      languageKey: "cpp",
      platformLanguageId: "2",
      fileLabel: "main.cpp",
      codeSha256: sha256,
      codeBytes: Buffer.byteLength(source),
      actionLabel: "提交 NC218144 到牛客"
    });
    expect(gateway.obtainAccessToken).not.toHaveBeenCalled();
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  test("rejects a submission artifact whose claimed hash does not match its source", async () => {
    const gateway = gatewayFixture();
    const service = new NowCoderJudgeService({ gateway, verifyArtifact });
    const input = request();
    input.code.sha256 = "0".repeat(64);

    await expect(service.prepareSubmission(input)).rejects.toMatchObject({ code: "request.invalid" });
    expect(gateway.prepareContext).not.toHaveBeenCalled();
    expect(gateway.obtainAccessToken).not.toHaveBeenCalled();
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  test("rejects a caller-supplied problem label that does not match the fetched URL", async () => {
    const gateway = gatewayFixture();
    const service = new NowCoderJudgeService({ gateway, verifyArtifact });
    const input = request();
    input.problem.nativeId = "NC999999";
    input.problem.canonicalId = "nowcoder:NC999999";

    await expect(service.prepareSubmission(input)).rejects.toMatchObject({ code: "confirmation.mismatch" });
    expect(gateway.obtainAccessToken).not.toHaveBeenCalled();
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  test("re-reads the saved file after confirmation and blocks a changed artifact", async () => {
    const gateway = gatewayFixture();
    const verifier = vi.fn()
      .mockResolvedValueOnce({ filePath: "C:\\workspace\\main.cpp", fileName: "main.cpp" })
      .mockRejectedValueOnce(new NowCoderAdapterError("confirmation.mismatch", "changed"));
    const service = new NowCoderJudgeService({ gateway, verifyArtifact: verifier });
    const preview = await service.prepareSubmission(request());

    await expect(service.commitSubmission(commit(preview), true)).rejects.toMatchObject({ code: "confirmation.mismatch" });
    expect(gateway.obtainAccessToken).not.toHaveBeenCalled();
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  test("requires server-side authorization and submits exactly once", async () => {
    const gateway = gatewayFixture();
    const service = new NowCoderJudgeService({ gateway, verifyArtifact, now: () => Date.parse(capturedAt), nowIso: () => capturedAt });
    const preview = await service.prepareSubmission(request());
    const commit: OjSubmitCommitRequest = {
      schemaVersion: "oj.submit-commit/v1",
      requestId: "commit-1",
      intentId: preview.intentId,
      submissionOperationId: preview.submissionOperationId,
      codeArtifactId: preview.codeArtifactId,
      confirmationProof: "server-elicitation",
      codeSha256: preview.codeSha256
    };

    await expect(service.commitSubmission(commit, false)).rejects.toMatchObject({ code: "confirmation.required" });
    const result = await service.commitSubmission(commit, true);

    expect(result).toMatchObject({
      schemaVersion: "oj.submit-result/v1",
      requestId: "commit-1",
      intentId: preview.intentId,
      submissionOperationId: preview.submissionOperationId,
      platformSubmissionId: "90001",
      state: "queued",
      verdict: "queued",
      codeSha256: sha256
    });
    expect(gateway.obtainAccessToken).toHaveBeenCalledTimes(1);
    expect(gateway.submit).toHaveBeenCalledTimes(1);
    expect(gateway.submit).toHaveBeenCalledWith(expect.objectContaining({
      content: source,
      questionId: "1338275",
      language: "2",
      tagId: 4,
      submitType: 1,
      token: "short-token"
    }), undefined);
    gateway.poll.mockResolvedValueOnce({ status: 5, submissionId: "90001", judgeReplyDesc: "答案正确" });
    const polled = await service.pollSubmission({
      requestId: "poll-1",
      submissionOperationId: preview.submissionOperationId
    });
    expect(polled).toMatchObject({ state: "completed", verdict: "accepted", platformSubmissionId: "90001" });
    expect(gateway.poll).toHaveBeenCalledWith(expect.objectContaining({
      token: "short-token",
      id: "90001",
      userId: "123456789"
    }), undefined);
    expect(JSON.stringify(polled)).not.toContain("short-token");
    await expect(service.commitSubmission(commit, true)).rejects.toMatchObject({ code: "confirmation.expired" });
  });

  test("returns outcome_unknown after an ambiguous submit failure and never retries", async () => {
    const gateway = gatewayFixture();
    gateway.submit.mockRejectedValueOnce(new NowCoderAdapterError("network.timeout", "ambiguous"));
    const service = new NowCoderJudgeService({ gateway, verifyArtifact, now: () => Date.parse(capturedAt), nowIso: () => capturedAt });
    const preview = await service.prepareSubmission(request());
    const commit: OjSubmitCommitRequest = {
      schemaVersion: "oj.submit-commit/v1",
      requestId: "commit-timeout",
      intentId: preview.intentId,
      submissionOperationId: preview.submissionOperationId,
      codeArtifactId: preview.codeArtifactId,
      confirmationProof: "server-elicitation",
      codeSha256: preview.codeSha256
    };

    const result = await service.commitSubmission(commit, true);

    expect(result.state).toBe("outcome_unknown");
    expect(result.verdict).toBe("unknown");
    expect(gateway.submit).toHaveBeenCalledTimes(1);
    await expect(service.commitSubmission(commit, true)).rejects.toMatchObject({ code: "confirmation.expired" });
  });

  test.each([
    new DOMException("cancelled after dispatch", "AbortError"),
    new NowCoderAdapterError("upstream.schema_changed", "malformed success response")
  ])("treats every unprovable post-dispatch result as outcome_unknown", async (failure) => {
    const gateway = gatewayFixture();
    gateway.submit.mockRejectedValueOnce(failure);
    const service = new NowCoderJudgeService({ gateway, verifyArtifact });
    const preview = await service.prepareSubmission(request());

    await expect(service.commitSubmission(commit(preview), true)).resolves.toMatchObject({ state: "outcome_unknown" });
    expect(gateway.submit).toHaveBeenCalledTimes(1);
    await expect(service.commitSubmission(commit(preview), true)).rejects.toMatchObject({ code: "confirmation.expired" });
  });

  test("treats a success response without a job ID as outcome_unknown", async () => {
    const gateway = gatewayFixture();
    gateway.submit.mockResolvedValueOnce({ accepted: true });
    const service = new NowCoderJudgeService({ gateway, verifyArtifact });
    const preview = await service.prepareSubmission(request());

    await expect(service.commitSubmission(commit(preview), true)).resolves.toMatchObject({ state: "outcome_unknown" });
    expect(gateway.submit).toHaveBeenCalledTimes(1);
  });

  test("caches a terminal submission verdict for idempotent polling", async () => {
    const gateway = gatewayFixture();
    const service = new NowCoderJudgeService({ gateway, verifyArtifact });
    const preview = await service.prepareSubmission(request());
    await service.commitSubmission(commit(preview), true);
    gateway.poll.mockResolvedValueOnce({ status: 5, submissionId: "90001", judgeReplyDesc: "答案正确" });

    const first = await service.pollSubmission({ requestId: "poll-a", submissionOperationId: preview.submissionOperationId });
    const second = await service.pollSubmission({ requestId: "poll-b", submissionOperationId: preview.submissionOperationId });

    expect(first.verdict).toBe("accepted");
    expect(second).toMatchObject({ requestId: "poll-b", verdict: "accepted" });
    expect(gateway.poll).toHaveBeenCalledTimes(1);
  });

  test("never returns a stale nonterminal submission state after a concurrent terminal poll", async () => {
    const gateway = gatewayFixture();
    const service = new NowCoderJudgeService({ gateway, verifyArtifact });
    const preview = await service.prepareSubmission(request());
    await service.commitSubmission(commit(preview), true);
    let resolveSlow!: (value: Record<string, unknown>) => void;
    gateway.poll
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSlow = resolve; }))
      .mockResolvedValueOnce({ status: 5, submissionId: "90001", judgeReplyDesc: "答案正确" });

    const slow = service.pollSubmission({ requestId: "poll-slow", submissionOperationId: preview.submissionOperationId });
    const terminal = await service.pollSubmission({ requestId: "poll-terminal", submissionOperationId: preview.submissionOperationId });
    resolveSlow({ status: 1 });

    expect(terminal.verdict).toBe("accepted");
    await expect(slow).resolves.toMatchObject({ requestId: "poll-slow", state: "completed", verdict: "accepted" });
  });

  test("uses the contest and team context in the confirmed payload", async () => {
    const gateway = gatewayFixture();
    const service = new NowCoderJudgeService({ gateway, verifyArtifact });
    const input = request();
    input.problem = {
      ...input.problem,
      nativeId: "11244/A",
      canonicalId: "nowcoder:11244/A",
      url: "https://ac.nowcoder.com/acm/contest/11244/A",
      contest: { nativeId: "11244", index: "A" }
    };
    vi.mocked(gateway.prepareContext).mockResolvedValueOnce(preparation({
      problem: input.problem,
      userId: "778899",
      teamId: "778899",
      contestId: "11244"
    }));
    const preview = await service.prepareSubmission(input);

    await service.commitSubmission(commit(preview), true);

    expect(preview.submissionTarget).toEqual({ kind: "team", id: "778899", contestId: "11244" });
    expect(gateway.obtainAccessToken).toHaveBeenCalledWith("778899", undefined);
    expect(gateway.submit).toHaveBeenCalledWith(expect.objectContaining({
      userId: "778899",
      tagId: 4,
      remark: "{contestId: 11244}"
    }), undefined);
  });

  test("uploads one selected sample for platform self-test after authorization", async () => {
    const gateway = gatewayFixture();
    gateway.poll.mockResolvedValueOnce({ status: 28, userOutput: "3\n", timeConsumption: 12, memoryConsumption: 1024 });
    const service = new NowCoderJudgeService({
      gateway,
      verifyArtifact,
      nowIso: () => capturedAt,
      sleep: async () => undefined,
      maxPolls: 2
    });
    const prepared = request();
    const run: OjRunRequest = {
      schemaVersion: "oj.run-request/v1",
      requestId: "run-1",
      attemptId: "attempt-1",
      problem: prepared.problem,
      mode: "platform",
      code: prepared.code,
      sampleOrdinals: [1],
      limits: { wallTimeMs: 32_000, outputBytes: 1_048_576, network: "deny" }
    };

    const result = await service.platformRun(run, true);

    expect(result).toMatchObject({
      schemaVersion: "oj.run-result/v1",
      requestId: "run-1",
      mode: "platform",
      state: "completed",
      verdict: "accepted",
      cases: [{ ordinal: 1, verdict: "accepted", stdout: "3\n", timeMs: 12 }]
    });
    expect(gateway.submit).toHaveBeenCalledWith(expect.objectContaining({
      tagId: 4,
      submitType: 2,
      selfInputData: "1 2\n",
      selfOutputData: "3\n"
    }), undefined);
  });

  test("rejects a platform-run artifact whose claimed hash does not match its source", async () => {
    const gateway = gatewayFixture();
    const service = new NowCoderJudgeService({ gateway, verifyArtifact });
    const prepared = request();
    const run: OjRunRequest = {
      schemaVersion: "oj.run-request/v1",
      requestId: "run-bad-hash",
      attemptId: "attempt-1",
      problem: prepared.problem,
      mode: "platform",
      code: { ...prepared.code, sha256: "0".repeat(64) },
      sampleOrdinals: [1],
      limits: { wallTimeMs: 32_000, outputBytes: 1_048_576, network: "deny" }
    };

    await expect(service.platformRun(run, true)).rejects.toMatchObject({ code: "request.invalid" });
    expect(gateway.prepareContext).not.toHaveBeenCalled();
    expect(gateway.obtainAccessToken).not.toHaveBeenCalled();
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  test("continues a dispatched platform run through oj_poll_run without another upload", async () => {
    const gateway = gatewayFixture();
    gateway.poll
      .mockRejectedValueOnce(new NowCoderAdapterError("network.timeout", "poll timeout"))
      .mockResolvedValueOnce({ status: 28, userOutput: "3\n" });
    const service = new NowCoderJudgeService({ gateway, verifyArtifact, maxPolls: 1 });
    const prepared = request();
    const run: OjRunRequest = {
      schemaVersion: "oj.run-request/v1",
      requestId: "run-resume",
      attemptId: "attempt-1",
      problem: prepared.problem,
      mode: "platform",
      code: prepared.code,
      sampleOrdinals: [1],
      limits: { wallTimeMs: 32_000, outputBytes: 1_048_576, network: "deny" }
    };
    const preview = await service.preparePlatformRun(run);

    const initial = await service.commitPlatformRun(preview.intentId, true);
    const completed = await service.pollPlatformRun({ requestId: "run-resume" });

    expect(initial).toMatchObject({ state: "running", verdict: "judging" });
    expect(completed).toMatchObject({ state: "completed", verdict: "accepted" });
    expect(gateway.submit).toHaveBeenCalledTimes(1);
    await expect(service.preparePlatformRun(run)).rejects.toMatchObject({ code: "policy.blocked" });
  });

  test("never returns a stale running state after a concurrent terminal run poll", async () => {
    const gateway = gatewayFixture();
    const service = new NowCoderJudgeService({ gateway, verifyArtifact, maxPolls: 0 });
    const prepared = request();
    const run: OjRunRequest = {
      schemaVersion: "oj.run-request/v1",
      requestId: "run-concurrent-poll",
      attemptId: "attempt-1",
      problem: prepared.problem,
      mode: "platform",
      code: prepared.code,
      sampleOrdinals: [1],
      limits: { wallTimeMs: 32_000, outputBytes: 1_048_576, network: "deny" }
    };
    const preview = await service.preparePlatformRun(run);
    await service.commitPlatformRun(preview.intentId, true);
    let resolveSlow!: (value: Record<string, unknown>) => void;
    gateway.poll
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSlow = resolve; }))
      .mockResolvedValueOnce({ status: 28, userOutput: "3\n" });

    const slow = service.pollPlatformRun({ requestId: "run-concurrent-poll" });
    const terminal = await service.pollPlatformRun({ requestId: "run-concurrent-poll" });
    resolveSlow({ status: 1 });

    expect(terminal).toMatchObject({ state: "completed", verdict: "accepted" });
    await expect(slow).resolves.toMatchObject({ state: "completed", verdict: "accepted" });
    expect(gateway.submit).toHaveBeenCalledTimes(1);
  });

  test("reserves a platform-run requestId before asynchronous preparation", async () => {
    const gateway = gatewayFixture();
    const service = new NowCoderJudgeService({ gateway, verifyArtifact });
    const prepared = request();
    const run: OjRunRequest = {
      schemaVersion: "oj.run-request/v1",
      requestId: "run-concurrent",
      attemptId: "attempt-1",
      problem: prepared.problem,
      mode: "platform",
      code: prepared.code,
      sampleOrdinals: [1],
      limits: { wallTimeMs: 32_000, outputBytes: 1_048_576, network: "deny" }
    };

    const first = service.preparePlatformRun(run);
    await expect(service.preparePlatformRun(run)).rejects.toMatchObject({ code: "policy.blocked" });
    await expect(first).resolves.toMatchObject({ requestId: "run-concurrent" });
  });

  test("releases a platform-run requestId after a definite pre-dispatch token failure", async () => {
    const gateway = gatewayFixture();
    gateway.obtainAccessToken.mockRejectedValueOnce(new NowCoderAdapterError("auth.invalid", "expired"));
    const service = new NowCoderJudgeService({ gateway, verifyArtifact });
    const prepared = request();
    const run: OjRunRequest = {
      schemaVersion: "oj.run-request/v1",
      requestId: "run-token-failure",
      attemptId: "attempt-1",
      problem: prepared.problem,
      mode: "platform",
      code: prepared.code,
      sampleOrdinals: [1],
      limits: { wallTimeMs: 32_000, outputBytes: 1_048_576, network: "deny" }
    };
    const preview = await service.preparePlatformRun(run);

    await expect(service.commitPlatformRun(preview.intentId, true)).rejects.toMatchObject({ code: "auth.invalid" });
    await expect(service.preparePlatformRun(run)).resolves.toMatchObject({ requestId: "run-token-failure" });
    expect(gateway.submit).not.toHaveBeenCalled();
  });
});

function gatewayFixture(): NowCoderJudgeGateway & {
  obtainAccessToken: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
  poll: ReturnType<typeof vi.fn>;
} {
  return {
    prepareContext: vi.fn(async () => preparation()),
    obtainAccessToken: vi.fn(async () => "short-token"),
    submit: vi.fn(async () => ({
      id: "90001",
      submissionId: "90001",
      token: "untrusted-response-token",
      userId: "untrusted-response-user"
    })),
    poll: vi.fn(async () => ({ status: 1 }))
  };
}

async function verifyArtifact() {
  return { filePath: "C:\\workspace\\main.cpp", fileName: "main.cpp" };
}

function preparation(overrides: Partial<Awaited<ReturnType<NowCoderJudgeGateway["prepareContext"]>>> = {}) {
  return {
    accountId: "123456789",
    displayName: "student",
    questionId: "1338275",
    problem: request().problem,
    userId: "123456789",
    tagId: 4 as const,
    samples: [{ ordinal: 1, input: "1 2\n", output: "3\n" }],
    supportedLanguageIds: ["1", "2", "4", "11"],
    ...overrides
  };
}

function commit(preview: Awaited<ReturnType<NowCoderJudgeService["prepareSubmission"]>>): OjSubmitCommitRequest {
  return {
    schemaVersion: "oj.submit-commit/v1",
    requestId: "commit-helper",
    intentId: preview.intentId,
    submissionOperationId: preview.submissionOperationId,
    codeArtifactId: preview.codeArtifactId,
    confirmationProof: "server-elicitation",
    codeSha256: preview.codeSha256
  };
}
