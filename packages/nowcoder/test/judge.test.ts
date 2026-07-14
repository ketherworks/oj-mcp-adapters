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
    const service = new NowCoderJudgeService({ gateway, now: () => Date.parse(capturedAt), nowIso: () => capturedAt });

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
    const service = new NowCoderJudgeService({ gateway });
    const input = request();
    input.code.sha256 = "0".repeat(64);

    await expect(service.prepareSubmission(input)).rejects.toMatchObject({ code: "request.invalid" });
    expect(gateway.prepareContext).not.toHaveBeenCalled();
    expect(gateway.obtainAccessToken).not.toHaveBeenCalled();
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  test("requires server-side authorization and submits exactly once", async () => {
    const gateway = gatewayFixture();
    const service = new NowCoderJudgeService({ gateway, now: () => Date.parse(capturedAt), nowIso: () => capturedAt });
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
    expect(gateway.poll).toHaveBeenCalledWith(expect.objectContaining({ token: "short-token", id: "90001" }), undefined);
    expect(JSON.stringify(polled)).not.toContain("short-token");
    await expect(service.commitSubmission(commit, true)).rejects.toMatchObject({ code: "confirmation.expired" });
  });

  test("returns outcome_unknown after an ambiguous submit failure and never retries", async () => {
    const gateway = gatewayFixture();
    gateway.submit.mockRejectedValueOnce(new NowCoderAdapterError("network.timeout", "ambiguous"));
    const service = new NowCoderJudgeService({ gateway, now: () => Date.parse(capturedAt), nowIso: () => capturedAt });
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

  test("uploads one selected sample for platform self-test after authorization", async () => {
    const gateway = gatewayFixture();
    gateway.poll.mockResolvedValueOnce({ status: 28, userOutput: "3\n", timeConsumption: 12, memoryConsumption: 1024 });
    const service = new NowCoderJudgeService({
      gateway,
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
      tagId: 8,
      submitType: 2,
      selfInputData: "1 2\n",
      selfOutputData: "3\n"
    }), undefined);
  });

  test("rejects a platform-run artifact whose claimed hash does not match its source", async () => {
    const gateway = gatewayFixture();
    const service = new NowCoderJudgeService({ gateway });
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
});

function gatewayFixture(): NowCoderJudgeGateway & {
  obtainAccessToken: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
  poll: ReturnType<typeof vi.fn>;
} {
  return {
    prepareContext: vi.fn(async () => ({
      accountId: "123456789",
      displayName: "student",
      questionId: "1338275",
      samples: [{ ordinal: 1, input: "1 2\n", output: "3\n" }],
      supportedLanguageIds: ["1", "2", "4", "11"]
    })),
    obtainAccessToken: vi.fn(async () => "short-token"),
    submit: vi.fn(async () => ({ id: "90001", submissionId: "90001" })),
    poll: vi.fn(async () => ({ status: 1 }))
  };
}
