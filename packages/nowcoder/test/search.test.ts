import { describe, expect, test } from "vitest";
import { parseNowCoderProblemListHtml } from "../src/search.js";
import { loadFixture } from "./fixtureLoader.js";

describe("NowCoder problem search", () => {
  test("normalizes official problem-list rows into typed summaries", async () => {
    const html = await loadFixture("problem-list.html");

    const result = parseNowCoderProblemListHtml(html, {
      requestId: "search-1",
      query: "二分",
      page: 1,
      limit: 20,
      fetchedAt: "2026-07-14T14:00:00.000Z"
    });

    expect(result).toMatchObject({
      schemaVersion: "oj.search-result/v1",
      requestId: "search-1",
      nextCursor: "2",
      items: [
        {
          title: "小红的二分图构造",
          ref: { platform: "nowcoder", nativeId: "NC286185" },
          difficulty: { scale: "nowcoder", value: 2000, label: "2000" },
          tags: [
            { namespace: "platform", id: "145496", slug: "145496", name: "图论" },
            { namespace: "platform", id: "146979", slug: "146979", name: "二分图" }
          ],
          acceptance: { accepted: 830 }
        },
        {
          title: "二分类逻辑回归",
          ref: { platform: "nowcoder", nativeId: "NC306825" },
          difficulty: { scale: "nowcoder", value: 1554, label: "1554" },
          tags: [],
          acceptance: { accepted: 273 }
        }
      ]
    });
  });
});
