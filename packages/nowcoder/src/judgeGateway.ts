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
    const questionId = /\bquestionId\s*:\s*["']([1-9]\d*)["']/.exec(problem.html)?.[1];
    if (!questionId) {
      throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder problem page did not expose the internal judge question ID.");
    }
    const document = parseNowCoderProblemHtml(problem.html, { url: problem.url, fetchedAt: this.nowIso(), etag: problem.etag });
    const supportedLanguageIds = await this.client.getQuestionSupportLanguageIds(questionId, { signal });
    return { accountId: profile.accountId, displayName: profile.displayName, questionId, samples: document.samples, supportedLanguageIds };
  }

  obtainAccessToken(signal?: AbortSignal): Promise<string> {
    return this.client.obtainJudgeAccessToken({ signal });
  }

  submit(payload: NowCoderJudgeSubmitPayload, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.client.submitJudge(payload as unknown as Record<string, unknown>, { signal });
  }

  poll(context: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.client.pollJudge(context, { signal });
  }
}
