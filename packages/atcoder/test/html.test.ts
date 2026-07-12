import { describe, expect, test } from "vitest";
import { HtmlLimitError, parseHtml, preflightHtml, sanitizeHtml } from "../src/html.js";

const BASE_URL = "https://atcoder.jp/contests/abc001/tasks/abc001_a";

describe("bounded HTML5 parsing and sanitization", () => {
  test("decodes full HTML5 named entities and preserves semantic inline separators", () => {
    const root = parseHtml("<p>A&CounterClockwiseContourIntegral;B <var>x</var> <strong>y</strong></p>");

    expect(sanitizeHtml(root.children, BASE_URL)).toEqual({
      html: "<p>A∳B <var>x</var> <strong>y</strong></p>",
      text: "A∳B x y"
    });
  });

  test.each([
    ["nodes", "<i></i><i></i><i></i>", { maxNodes: 3, maxDepth: 10, maxTextChars: 100 }],
    ["depth", "<div><div><div>x</div></div></div>", { maxNodes: 20, maxDepth: 3, maxTextChars: 100 }],
    ["text", "<p>123456</p>", { maxNodes: 20, maxDepth: 10, maxTextChars: 5 }]
  ])("rejects HTML exceeding the configured %s limit", (_name, source, limits) => {
    expect(() => parseHtml(source, limits)).toThrow(HtmlLimitError);
  });

  test("traverses and sanitizes deeply nested HTML iteratively", () => {
    const depth = 12_000;
    const root = parseHtml(`${"<span>".repeat(depth)}value${"</span>".repeat(depth)}`, {
      maxNodes: 1_000_000,
      maxDepth: depth + 2,
      maxTextChars: 10
    });

    const sanitized = sanitizeHtml(root.children, BASE_URL);
    expect(sanitized.text).toBe("value");
    expect(sanitized.html).toContain("value");
    expect(sanitized.html.startsWith("<span>")).toBe(true);
  });

  test("rejects the 1.995 MB many-element document during direct bounded preflight", () => {
    const source = "<i></i>".repeat(285_000);
    let caught: unknown;

    try {
      preflightHtml(source);
    } catch (error) {
      caught = error;
    }

    expect(source.length).toBe(1_995_000);
    expect(caught).toBeInstanceOf(HtmlLimitError);
    expect((caught as HtmlLimitError).scannedChars).toBeGreaterThan(0);
    expect((caught as HtmlLimitError).scannedChars).toBeLessThan(100_000);
  });

  test("tokenizes abrupt empty comments instead of hiding following elements", () => {
    const source = `<!-->${"<i></i>".repeat(100)}`;

    expect(() =>
      preflightHtml(source, { maxNodes: 100, maxDepth: 256, maxTextChars: 10_000 })
    ).toThrow(HtmlLimitError);
  });

  test("tokenizes quotes in unquoted attributes instead of hiding following elements", () => {
    const source = `<div data-value=x">${"<i></i>".repeat(100)}`;

    expect(() =>
      preflightHtml(source, { maxNodes: 100, maxDepth: 256, maxTextChars: 10_000 })
    ).toThrow(HtmlLimitError);
  });

  test("enforces the decoded text character limit during direct preflight", () => {
    expect(() =>
      preflightHtml("<p>&amp;&amp;&amp;&amp;&amp;&amp;</p>", {
        maxNodes: 100,
        maxDepth: 10,
        maxTextChars: 5,
        maxTextBytes: 100
      })
    ).toThrow(HtmlLimitError);
  });

  test("counts non-void '/>' start tags toward the HTML5 preflight depth", () => {
    const source = "<div/>".repeat(300);

    expect(() => preflightHtml(source)).toThrow(HtmlLimitError);
  });

  test("fails closed when an end tag crosses the bounded open-element stack", () => {
    expect(() => preflightHtml("<div><span></div>")).toThrow(/could not safely resolve malformed element nesting/);
  });

  test("reserves implicit html and body depth while leaving true void elements depth-neutral", () => {
    expect(() =>
      preflightHtml("<main><section>nested</section></main>", {
        maxNodes: 200,
        maxDepth: 3,
        maxTextChars: 100
      })
    ).toThrow(HtmlLimitError);
    expect(() =>
      preflightHtml("<br/>".repeat(100), { maxNodes: 4_000, maxDepth: 2, maxTextChars: 100 })
    ).not.toThrow();
  });

  test("fails preflight when the depth limit cannot contain the implicit document structure", () => {
    expect(() =>
      preflightHtml("", { maxNodes: 20, maxDepth: 1, maxTextChars: 100 })
    ).toThrow(HtmlLimitError);
  });

  test("rejects nested table rows before parse5 can insert tbody wrappers past the depth limit", () => {
    const groups = 84;
    const source = `${"<table><tr><td>".repeat(groups)}x${"</td></tr></table>".repeat(groups)}`;

    expect(() => preflightHtml(source)).toThrow(HtmlLimitError);
  });

  test("reserves tbody and tr depth for cells placed directly under nested tables", () => {
    const groups = 64;
    const source = `${"<table><td>".repeat(groups)}x${"</td></table>".repeat(groups)}`;

    expect(() => preflightHtml(source)).toThrow(HtmlLimitError);
  });

  test("does not treat quoted markup or raw script text as nested elements", () => {
    const source = `<script>${"<div>".repeat(300)}</script><p title="${"<i>".repeat(300)}">ok</p>`;

    const root = parseHtml(source, { maxNodes: 200, maxDepth: 10, maxTextChars: 10_000 });

    expect(sanitizeHtml(root.children, BASE_URL).text).toBe("ok");
  });
});
