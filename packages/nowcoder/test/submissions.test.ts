import { describe, expect, test } from "vitest";
import { parseNowCoderSubmissionsHtml } from "../src/submissions.js";
import { loadFixture } from "./fixtureLoader.js";

describe("NowCoder submission list", () => {
  test("normalizes server-rendered rows without reading source code", async () => {
    const result = parseNowCoderSubmissionsHtml(await loadFixture("submissions.html"), {
      accountId: "776966013",
      page: 1,
      pageSize: 2,
      sourceUrl: "https://ac.nowcoder.com/acm/contest/profile/776966013/practice-coding?pageSize=2&search=&statusTypeFilter=-1&languageCategoryFilter=-1&orderType=DESC&page=1",
      fetchedAt: "2026-07-14T16:30:00.000Z"
    });

    expect(result).toMatchObject({
      schemaVersion: "nowcoder.submission-list/v1",
      accountId: "776966013",
      page: 1,
      pageSize: 2,
      totalPages: 3,
      summary: { challenged: 1, accepted: 1, submissions: 6 },
      items: [
        {
          submissionId: "83132818",
          problem: { nativeId: "NC312754", title: "MuQ 的魔咒" },
          verdict: "accepted",
          verdictRaw: "答案正确",
          score: 100,
          timeMs: 190,
          memoryBytes: 97_193_984,
          codeLength: 16975,
          language: "C++",
          submittedAtRaw: "2026-04-03 21:19:51"
        },
        {
          submissionId: "83132781",
          verdict: "wrong_answer",
          score: 51.67
        }
      ],
      source: { kind: "page_adapter", confidence: "derived" }
    });
    expect(JSON.stringify(result)).not.toContain("sourceCode");
  });
});
