import { readFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { NowCoderPageJudgeGateway, parseNowCoderJudgePageInfo } from "../src/judgeGateway.js";

describe("NowCoder judge page context", () => {
  test("extracts question, contest, and team only from bounded pageInfo", async () => {
    const html = await fixture("acm-contest.html");

    expect(parseNowCoderJudgePageInfo(html)).toEqual({
      questionId: "1751829",
      contestId: "11244",
      isTeamSignUp: true,
      teamId: "778899"
    });
  });

  test("returns a canonical problem and contest-aware submitter context", async () => {
    const html = await fixture("acm-contest.html");
    const profile = await fixture("profile.html");
    const client = {
      getProfilePage: vi.fn(async () => ({ accountId: "886965097", html: profile, url: "https://ac.nowcoder.com/acm/contest/profile/886965097" })),
      getProblemPage: vi.fn(async () => ({ html, url: "https://ac.nowcoder.com/acm/contest/11244/A" })),
      getQuestionSupportLanguageIds: vi.fn(async () => ["2", "11"])
    };
    const gateway = new NowCoderPageJudgeGateway(client as never, () => "2026-07-14T17:00:00.000Z");

    const context = await gateway.prepareContext("https://ac.nowcoder.com/acm/contest/11244/A", "886965097");

    expect(context).toMatchObject({
      accountId: "886965097",
      questionId: "1751829",
      problem: { nativeId: "11244/A", canonicalId: "nowcoder:11244/A" },
      userId: "778899",
      teamId: "778899",
      contestId: "11244",
      tagId: 4,
      supportedLanguageIds: ["2", "11"]
    });
  });

  test("ignores questionId-like text outside pageInfo", () => {
    expect(() => parseNowCoderJudgePageInfo(`
      <p>questionId: '999'</p>
      <script>window.pageInfo = { problemId: '218144' };</script>
    `)).toThrow("pageInfo did not expose");
  });

  test("fails closed when a contest omits the literal team-signup state", async () => {
    const html = (await fixture("acm-contest.html")).replace("isTeamSignUp: true,", "");

    expect(() => parseNowCoderJudgePageInfo(html)).toThrow("team-signup state");
  });
});

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}
