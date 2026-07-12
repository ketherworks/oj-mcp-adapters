import { ojProblemDocumentSchema } from "@kaiserunix/oj-mcp-contracts";
import { describe, expect, test } from "vitest";
import type { AtCoderHtmlPage } from "../src/client.js";
import { parseAtCoderProblem } from "../src/normalizer.js";
import { loadHtmlFixture } from "./fixtureLoader.js";

describe("AtCoder problem normalizer", () => {
  test("normalizes an English ABC task with safe HTML, math, constraints, samples, limits, hashes, and source", async () => {
    const html = await loadHtmlFixture("abc086-a-en.html");
    const document = await parseAtCoderProblem(page(html), {
      fetchedAt: "2026-07-11T00:00:00.000Z",
      adapterVersion: "0.1.0"
    });

    expect(document).toMatchObject({
      schemaVersion: "oj.problem-document/v1",
      title: "Product",
      locale: "en",
      access: "public",
      ref: {
        nativeId: "abc086/abc086_a",
        canonicalId: "atcoder:abc086/abc086_a",
        contest: { nativeId: "abc086", index: "A" }
      },
      constraints: ["\\(1 \\le A,B \\le 10^4\\)", "All values in input are integers."],
      samples: [{ ordinal: 1, input: "3 4", output: "Even", explanation: "\\(3 \\times 4 = 12\\), so print Even." }],
      limits: { timeMs: 2_000, memoryBytes: 268_435_456 },
      io: { mode: "stdin_stdout" },
      source: { kind: "page_adapter", confidence: "authoritative" }
    });
    expect(document.content.statement).toMatchObject({ format: "html", locale: "en", truncated: false });
    expect(document.content.statement.text).toContain("<var>A</var>");
    expect(document.content.statement.text).toContain("\\(A \\times B\\)");
    expect(document.content.statement.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(document.source.rawRef).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(ojProblemDocumentSchema.parse(document)).toEqual(document);
  });

  test("normalizes the current nested task wrapper without including the editorial link in the title", async () => {
    const document = await parseAtCoderProblem(page(await loadHtmlFixture("current-task-wrapper.html")), {
      fetchedAt: "2026-07-12T00:00:00.000Z",
      adapterVersion: "0.1.0"
    });

    expect(document).toMatchObject({
      title: "Product",
      ref: { nativeId: "abc086/abc086_a", contest: { index: "A" } },
      samples: [{ ordinal: 1, input: "3 4", output: "Even" }],
      limits: { timeMs: 2_000, memoryBytes: 268_435_456 }
    });
  });

  test("normalizes Japanese ARC sections and takes the displayed contest index from the page", async () => {
    const html = await loadHtmlFixture("arc065-a-ja.html");
    const document = await parseAtCoderProblem(
      {
        contestId: "arc065",
        taskId: "arc065_a",
        locale: "ja",
        canonicalUrl: "https://atcoder.jp/contests/arc065/tasks/arc065_a",
        sourceUrl: "https://atcoder.jp/contests/arc065/tasks/arc065_a?lang=ja",
        html
      },
      { fetchedAt: "2026-07-11T00:00:00.000Z", adapterVersion: "0.1.0" }
    );

    expect(document).toMatchObject({
      title: "白昼夢",
      locale: "ja",
      ref: { nativeId: "arc065/arc065_a", contest: { nativeId: "arc065", index: "C" } },
      constraints: ["\\(1 \\le |S| \\le 10^5\\)", "S は英小文字からなる。"],
      samples: [
        { ordinal: 1, input: "erasedream", output: "YES" },
        { ordinal: 2, input: "dreamerer", output: "NO", explanation: "条件を満たす分割は存在しない。" }
      ],
      limits: { timeMs: 2_000, memoryBytes: 268_435_456 }
    });
    expect(document.content.statement.text).toContain("<var>S</var>");
    expect(ojProblemDocumentSchema.parse(document)).toEqual(document);
  });

  test("reports audited section-heading drift instead of returning a partial document", async () => {
    await expect(
      parseAtCoderProblem(page(await loadHtmlFixture("schema-drift.html")), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("reports malformed HTML that cannot expose a locale container", async () => {
    await expect(
      parseAtCoderProblem(page(await loadHtmlFixture("malformed.html")), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("reports schema drift when the required Input section is missing", async () => {
    await expect(
      parseAtCoderProblem(page(await loadHtmlFixture("missing-input.html")), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("reports schema drift when the required Input section has only empty HTML wrappers and whitespace", async () => {
    await expect(
      parseAtCoderProblem(page(await loadHtmlFixture("empty-input-body.html")), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("reports schema drift when the required Output section is missing", async () => {
    await expect(
      parseAtCoderProblem(page(await loadHtmlFixture("missing-output.html")), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("reports schema drift when the required Output section has only empty HTML wrappers and decoded whitespace", async () => {
    await expect(
      parseAtCoderProblem(page(await loadHtmlFixture("empty-output-body.html")), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("reports schema drift when an ordinary task loses all sample sections", async () => {
    await expect(
      parseAtCoderProblem(page(await loadHtmlFixture("missing-samples.html")), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("reports schema drift when a sample input body decodes to whitespace only", async () => {
    await expect(
      parseAtCoderProblem(page(await loadHtmlFixture("empty-sample-input.html")), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("reports schema drift when a sample output body decodes to whitespace only", async () => {
    await expect(
      parseAtCoderProblem(page(await loadHtmlFixture("empty-sample-output.html")), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("reports schema drift when a Constraints heading has no extractable content", async () => {
    await expect(
      parseAtCoderProblem(page(await loadHtmlFixture("empty-constraints.html")), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("reports schema drift when an ordinary task is missing its Constraints section", async () => {
    await expect(
      parseAtCoderProblem(page(await loadHtmlFixture("missing-constraints.html")), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("reports schema drift when a limits banner is only partially parseable", async () => {
    await expect(
      parseAtCoderProblem(page(await loadHtmlFixture("partial-limits.html")), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("reports schema drift when an ordinary task is missing its limits banner", async () => {
    await expect(
      parseAtCoderProblem(page(await loadHtmlFixture("missing-limits.html")), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("reports schema drift when an ordinary task omits both Constraints and limits", async () => {
    await expect(
      parseAtCoderProblem(page(await loadHtmlFixture("optional-metadata-absent.html")), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("permits no samples only when an explicit Interaction section proves the task is interactive", async () => {
    const document = await parseAtCoderProblem(page(await loadHtmlFixture("interactive-no-samples.html")), {
      fetchedAt: "2026-07-11T00:00:00.000Z",
      adapterVersion: "0.1.0"
    });

    expect(document).toMatchObject({ samples: [], io: { mode: "interactive" } });
  });

  test("permits no samples when the statement explicitly identifies an output-only task", async () => {
    const document = await parseAtCoderProblem(page(await loadHtmlFixture("output-only-no-samples.html")), {
      fetchedAt: "2026-07-11T00:00:00.000Z",
      adapterVersion: "0.1.0"
    });

    expect(document).toMatchObject({ samples: [], io: { mode: "file" } });
  });

  test.each(["Problem Statement", "Input", "Output"])(
    "rejects a required %s body whose only content is removed by sanitization",
    async (heading) => {
      const html = (await loadHtmlFixture("abc086-a-en.html")).replace(
        new RegExp(`(<h3>${heading}</h3>)[\\s\\S]*?(</section>)`),
        "$1<script>unsafeOnly()</script><iframe>hidden</iframe>$2"
      );

      await expect(
        parseAtCoderProblem(page(html), {
          fetchedAt: "2026-07-11T00:00:00.000Z",
          adapterVersion: "0.1.0"
        })
      ).rejects.toMatchObject({ code: "upstream.schema_changed" });
    }
  );

  test.each(["Sample Input 1", "Sample Output 1"])(
    "rejects a %s body whose only content is removed by sanitization",
    async (heading) => {
      const html = (await loadHtmlFixture("abc086-a-en.html")).replace(
        new RegExp(`(<h3>${heading}</h3>)[\\s\\S]*?(</section>)`),
        "$1<pre><script>unsafeOnly()</script></pre>$2"
      );

      await expect(
        parseAtCoderProblem(page(html), {
          fetchedAt: "2026-07-11T00:00:00.000Z",
          adapterVersion: "0.1.0"
        })
      ).rejects.toMatchObject({ code: "upstream.schema_changed" });
    }
  );

  test("does not recover missing audited limits from statement prose", async () => {
    const html = (await loadHtmlFixture("missing-limits.html")).replace(
      "<h3>Problem Statement</h3>",
      "<h3>Problem Statement</h3><p>Example metadata: Time Limit: 2 sec / Memory Limit: 256 MiB</p>"
    );

    await expect(
      parseAtCoderProblem(page(html), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("rejects multiple audited limits banners", async () => {
    const html = (await loadHtmlFixture("abc086-a-en.html")).replace(
      "<p>Time Limit: 2 sec / Memory Limit: 256 MiB</p>",
      "<p>Time Limit: 2 sec / Memory Limit: 256 MiB</p><p>Time Limit: 3 sec / Memory Limit: 512 MiB</p>"
    );

    await expect(
      parseAtCoderProblem(page(html), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("maps parser resource-limit failures to schema drift", async () => {
    const html = (await loadHtmlFixture("abc086-a-en.html")).replace(
      "<p>Given",
      `${"<span>".repeat(300)}<p>Given`
    );

    await expect(
      parseAtCoderProblem(page(html), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("does not classify negated output-only prose as an affirmative special-task notice", async () => {
    await expect(
      parseAtCoderProblem(page(await loadHtmlFixture("negated-output-only.html")), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("does not classify negated interactive prose as an affirmative special-task notice", async () => {
    await expect(
      parseAtCoderProblem(page(await loadHtmlFixture("negated-interactive.html")), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("does not classify exact special-task prose outside audited statement notices or headings", async () => {
    await expect(
      parseAtCoderProblem(page(await loadHtmlFixture("unscoped-special-notice.html")), {
        fetchedAt: "2026-07-11T00:00:00.000Z",
        adapterVersion: "0.1.0"
      })
    ).rejects.toMatchObject({ code: "upstream.schema_changed" });
  });

  test("strips executable markup and unsafe URLs while retaining safe statement content", async () => {
    const document = await parseAtCoderProblem(page(await loadHtmlFixture("unsafe-html.html")), {
      fetchedAt: "2026-07-11T00:00:00.000Z",
      adapterVersion: "0.1.0"
    });

    expect(document.content.statement.text).toContain("<a>this link text</a>");
    expect(document.content.statement.text).toContain('src="https://atcoder.jp/img/task.png"');
    expect(document.content.statement.text).not.toMatch(/javascript:|onclick|onerror|<script|<iframe|evil\.example/);
  });
});

function page(html: string): AtCoderHtmlPage {
  return {
    contestId: "abc086",
    taskId: "abc086_a",
    locale: "en",
    canonicalUrl: "https://atcoder.jp/contests/abc086/tasks/abc086_a",
    sourceUrl: "https://atcoder.jp/contests/abc086/tasks/abc086_a?lang=en",
    html,
    etag: '"fixture-etag"'
  };
}
