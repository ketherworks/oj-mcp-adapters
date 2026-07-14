import { NowCoderPageClient } from "./client.js";
import { NowCoderAdapterError } from "./errors.js";
import type { NowCoderJudgeGateway, NowCoderJudgePreparation, NowCoderJudgeSubmitPayload } from "./judge.js";
import { parseNowCoderProfileHtml } from "./profile.js";
import { parseNowCoderProblemHtml } from "./parser.js";

export class NowCoderPageJudgeGateway implements NowCoderJudgeGateway {
  constructor(
    private readonly client: NowCoderPageClient,
    private readonly nowIso: () => string = () => new Date().toISOString()
  ) {}

  async prepareContext(problemUrl: string, accountId?: string, signal?: AbortSignal): Promise<NowCoderJudgePreparation> {
    const [profilePage, problem] = await Promise.all([
      this.client.getProfilePage(undefined, { signal }),
      this.client.getProblemPage(problemUrl, { signal })
    ]);
    if (accountId !== undefined && profilePage.accountId !== accountId) {
      throw new NowCoderAdapterError("auth.forbidden", "The requested account does not match the signed-in NowCoder account.");
    }
    const profile = parseNowCoderProfileHtml(profilePage.html, {
      accountId: profilePage.accountId,
      fetchedAt: this.nowIso()
    });
    const document = parseNowCoderProblemHtml(problem.html, { url: problem.url, fetchedAt: this.nowIso(), etag: problem.etag });
    const pageInfo = parseNowCoderJudgePageInfo(problem.html);
    const documentContestId = document.ref.contest?.nativeId;
    if (documentContestId !== pageInfo.contestId) {
      throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder pageInfo contest does not match the canonical problem URL.");
    }
    const teamId = pageInfo.isTeamSignUp ? pageInfo.teamId : undefined;
    if (pageInfo.isTeamSignUp && !teamId) {
      throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder marked the contest as a team signup without a team ID.");
    }
    const supportedLanguageIds = await this.client.getQuestionSupportLanguageIds(pageInfo.questionId, { signal });
    return {
      accountId: profile.accountId,
      displayName: profile.displayName,
      questionId: pageInfo.questionId,
      problem: document.ref,
      userId: teamId ?? profile.accountId,
      tagId: 4,
      ...(pageInfo.contestId ? { contestId: pageInfo.contestId } : {}),
      ...(teamId ? { teamId } : {}),
      samples: document.samples,
      supportedLanguageIds
    };
  }

  obtainAccessToken(teamId?: string, signal?: AbortSignal): Promise<string> {
    return this.client.obtainJudgeAccessToken({ signal, ...(teamId ? { teamId } : {}) });
  }

  submit(payload: NowCoderJudgeSubmitPayload, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.client.submitJudge(payload as unknown as Record<string, unknown>, { signal });
  }

  poll(context: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.client.pollJudge(context, { signal });
  }
}

interface NowCoderJudgePageInfo {
  questionId: string;
  contestId?: string;
  isTeamSignUp: boolean;
  teamId?: string;
}

export function parseNowCoderJudgePageInfo(html: string): NowCoderJudgePageInfo {
  const pageInfoScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]{0,100000}?)<\/script>/gi)]
    .map((match) => match[1] ?? "")
    .filter((script) => /\bwindow\.pageInfo\s*=/.test(script));
  if (pageInfoScripts.length !== 1) {
    throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder problem page did not expose a bounded pageInfo object.");
  }
  const block = /\bwindow\.pageInfo\s*=\s*\{([\s\S]{0,100000}?)\}\s*;/.exec(pageInfoScripts[0]!)?.[1];
  if (!block) throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder pageInfo object did not match the audited script shape.");
  const questionId = field(block, "questionId");
  if (!questionId) {
    throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder pageInfo did not expose the internal judge question ID.");
  }
  const contestId = field(block, "contestId");
  const teamId = positiveIdentifier(/\bteamId\s*:\s*([1-9]\d*)\b/.exec(block)?.[1]);
  const teamFlag = /\bisTeamSignUp\s*:\s*(true|false)\b/.exec(block)?.[1];
  if (contestId && teamFlag === undefined) {
    throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder contest pageInfo did not expose a literal team-signup state.");
  }
  const isTeamSignUp = teamFlag === "true";
  return {
    questionId,
    ...(contestId ? { contestId } : {}),
    isTeamSignUp,
    ...(teamId ? { teamId } : {})
  };
}

function field(block: string, name: "questionId" | "contestId"): string | undefined {
  return positiveIdentifier(new RegExp(`\\b${name}\\s*:\\s*["']([1-9]\\d*)["']`).exec(block)?.[1]);
}

function positiveIdentifier(value: string | undefined): string | undefined {
  return value && /^[1-9]\d{0,15}$/.test(value) ? value : undefined;
}
