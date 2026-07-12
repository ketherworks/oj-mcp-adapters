import { createHash } from "node:crypto";
import { ojProblemDocumentSchema } from "@kaiserunix/oj-mcp-contracts";
import { describe, expect, test } from "vitest";
import { parseNowCoderProblemHtml } from "../src/parser.js";
import { loadFixture } from "./fixtureLoader.js";

const fetchedAt = "2026-07-11T01:02:03.000Z";

describe("parseNowCoderProblemHtml", () => {
  test("normalizes Chinese ACM content, samples, limits, tags, constraints, hashes, and source", async () => {
    const html = await loadFixture("acm-problem.html");
    const document = parseNowCoderProblemHtml(html, {
      url: "https://ac.nowcoder.com/acm/problem/218144?from=profile",
      fetchedAt,
      etag: '"problem-v1"'
    });

    expect(() => ojProblemDocumentSchema.parse(document)).not.toThrow();
    expect(document).toMatchObject({
      schemaVersion: "oj.problem-document/v1",
      title: "静态特征查询",
      locale: "zh-CN",
      access: "public",
      ref: {
        platform: "nowcoder",
        site: "cn",
        nativeId: "NC218144",
        canonicalId: "nowcoder:NC218144",
        url: "https://ac.nowcoder.com/acm/problem/218144"
      },
      difficulty: { scale: "nowcoder-rating", value: 1500 },
      limits: { timeMs: 6000, memoryBytes: 512 * 1024 * 1024 },
      io: { mode: "stdin_stdout" },
      source: {
        kind: "page_adapter",
        adapterId: "nowcoder-public-page",
        adapterVersion: "0.1.0",
        fetchedAt,
        sourceUrl: "https://ac.nowcoder.com/acm/problem/218144",
        rawRef: "NC218144",
        etag: '"problem-v1"',
        confidence: "derived"
      }
    });
    expect(document.content.statement.text).toContain("$n$");
    expect(document.content.input?.text).toContain("$1\\le n\\le 10^5$");
    expect(document.content.output?.text).toBe("每次查询输出 YES 或 NO。");
    expect(document.content.notes?.text).toBe("请使用标准输入输出。");
    expect(document.constraints).toEqual(expect.arrayContaining([
      expect.stringContaining("1\\le n\\le 10^5"),
      expect.stringContaining("长度不超过 10")
    ]));
    expect(document.tags.map((tag) => tag.name)).toEqual(["哈希", "模拟"]);
    expect(document.samples).toEqual([
      { ordinal: 1, input: "3\nA X\nA X\nB Y", output: "YES\nNO\nYES", explanation: "第二次查询命中缓存。" },
      { ordinal: 2, input: "1\nC Z", output: "YES" }
    ]);

    for (const block of Object.values(document.content)) {
      expect(block?.sha256).toBe(createHash("sha256").update(block?.text ?? "", "utf8").digest("hex"));
      expect(block?.truncated).toBe(false);
      expect(block?.format).toBe("text");
    }
  });

  test("keeps contest identity from the canonical URL", async () => {
    const html = await loadFixture("acm-contest.html");
    const document = parseNowCoderProblemHtml(html, {
      url: "https://ac.nowcoder.com/acm/contest/11244/A",
      fetchedAt
    });

    expect(document.ref).toMatchObject({
      nativeId: "11244/A",
      canonicalId: "nowcoder:11244/A",
      contest: { nativeId: "11244", index: "A" }
    });
    expect(document.title).toBe("A-原样输出");
    expect(document.samples).toEqual([{ ordinal: 1, input: "7", output: "7" }]);
  });

  test("preserves significant whitespace from textarea and pre samples", async () => {
    const html = await loadFixture("whitespace-samples.html");
    const document = parseNowCoderProblemHtml(html, {
      url: "https://ac.nowcoder.com/acm/problem/218144",
      fetchedAt
    });

    expect(document.samples).toEqual([{
      ordinal: 1,
      input: "  alpha   beta\n\tgamma\n\n",
      output: "  one   two\n\tthree\n"
    }]);
  });

  test("reports anti-bot pages as a challenge instead of schema drift", async () => {
    const html = await loadFixture("challenge.html");

    expect(() => parseNowCoderProblemHtml(html, {
      url: "https://ac.nowcoder.com/acm/problem/218144",
      fetchedAt
    })).toThrowError(expect.objectContaining({ code: "challenge.required" }));
  });

  test("does not mistake a legitimate problem about verification codes for an anti-bot page", async () => {
    const html = (await loadFixture("acm-problem.html")).replace(
      "若缓存不存在，则记录机器与文章的组合。",
      "若验证码字符串不存在，则输出 EMPTY。"
    );

    expect(() => parseNowCoderProblemHtml(html, {
      url: "https://ac.nowcoder.com/acm/problem/218144",
      fetchedAt
    })).not.toThrow();
  });

  test("reports missing audited problem nodes as schema drift", async () => {
    const html = await loadFixture("malformed.html");

    expect(() => parseNowCoderProblemHtml(html, {
      url: "https://ac.nowcoder.com/acm/problem/218144",
      fetchedAt
    })).toThrowError(expect.objectContaining({ code: "upstream.schema_changed" }));
  });

  test("maps parser structural limits to schema drift", () => {
    const html = `${"<div>".repeat(300)}text${"</div>".repeat(300)}`;

    expect(() => parseNowCoderProblemHtml(html, {
      url: "https://ac.nowcoder.com/acm/problem/218144",
      fetchedAt
    })).toThrowError(expect.objectContaining({ code: "upstream.schema_changed" }));
  });

  test.each(["missing-input.html", "missing-output.html"])(
    "fails closed when a required input/output section is absent in %s",
    async (fixture) => {
      const html = await loadFixture(fixture);

      expect(() => parseNowCoderProblemHtml(html, {
        url: "https://ac.nowcoder.com/acm/problem/218144",
        fetchedAt
      })).toThrowError(expect.objectContaining({ code: "upstream.schema_changed" }));
    }
  );
});
