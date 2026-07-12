import { ojProblemDocumentSchema, ojProblemSummarySchema } from "@kaiserunix/oj-mcp-contracts";
import { describe, expect, test } from "vitest";
import { normalizeLuoguProblem, normalizeLuoguSearch } from "../src/normalizers.js";
import { loadJsonFixture } from "./fixtureLoader.js";

const baseOptions = {
  fetchedAt: "2026-07-11T08:00:00.000Z",
  adapterVersion: "0.1.0",
  sourceUrl: "https://www.luogu.com.cn/problem/list?type=P&keyword=tree"
};

describe("Luogu shared-schema normalizers", () => {
  test("normalizes search fixtures into bounded shared problem summaries", async () => {
    const payload = await loadJsonFixture("problem-search-ok.json");
    const summaries = normalizeLuoguSearch(payload, baseOptions);

    expect(summaries).toHaveLength(3);
    expect(summaries.every((summary) => ojProblemSummarySchema.safeParse(summary).success)).toBe(true);
    expect(summaries[0]).toMatchObject({
      schemaVersion: "oj.problem-summary/v1",
      title: "新二叉树",
      difficulty: { scale: "luogu-difficulty", value: 2 },
      ref: {
        platform: "luogu",
        nativeId: "P1305",
        canonicalId: "luogu:P1305",
        url: "https://www.luogu.com.cn/problem/P1305"
      },
      source: {
        kind: "page_adapter",
        confidence: "derived"
      }
    });
    expect(summaries[0].tags.map((tag) => tag.name)).toEqual(["72", "tree"]);
  });

  test("normalizes and hashes a truncated shared problem document", async () => {
    const payload = await loadJsonFixture("problem-ok.json");
    const document = await normalizeLuoguProblem(payload, {
      ...baseOptions,
      sourceUrl: "https://www.luogu.com.cn/problem/P1305",
      maxContentChars: 24
    });

    expect(() => ojProblemDocumentSchema.parse(document)).not.toThrow();
    expect(document.ref.nativeId).toBe("P1305");
    expect(document.content.statement.truncated).toBe(true);
    expect(document.content.statement.text).toHaveLength(24);
    expect(document.content.statement.originalChars).toBeGreaterThan(24);
    expect(document.content.statement.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(document.samples).toEqual([
      { ordinal: 1, input: "abc\n", output: "abc\n" },
      { ordinal: 2, input: "a**\n", output: "a\n" }
    ]);
    expect(document.io).toEqual({ mode: "stdin_stdout" });
  });

  test("retains the proven contenu fallback without accepting an empty statement", async () => {
    const payload = {
      data: {
        problem: {
          pid: "P1001",
          name: "A+B Problem",
          content: {
            name: "A+B Problem"
          },
          contenu: {
            background: "背景",
            description: "输入两个整数并输出它们的和。",
            formatI: "两个整数。",
            formatO: "一个整数。"
          },
          samples: []
        }
      }
    };

    const document = await normalizeLuoguProblem(payload, {
      ...baseOptions,
      sourceUrl: "https://www.luogu.com.cn/problem/P1001",
      maxContentChars: 500
    });

    expect(document.content.statement.text).toBe("背景\n\n输入两个整数并输出它们的和。");
    expect(document.content.input?.text).toBe("两个整数。");
    expect(document.content.output?.text).toBe("一个整数。");
  });
});
