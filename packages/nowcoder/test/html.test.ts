import { describe, expect, test } from "vitest";
import { findElements, parseHtmlDocument, renderText, type HtmlParserLimits } from "../src/html.js";

const roomyLimits: HtmlParserLimits = {
  maxInputChars: 200_000,
  maxNodes: 20_000,
  maxDepth: 6_000,
  maxTextChars: 100_000
};

describe("bounded HTML parsing", () => {
  test.each([
    ["input", "<p>x</p>", { ...roomyLimits, maxInputChars: 4 }],
    ["node", "<div><span>x</span></div>", { ...roomyLimits, maxNodes: 2 }],
    ["depth", "<div><span>x</span></div>", { ...roomyLimits, maxDepth: 1 }],
    ["text", "<p>abcd</p>", { ...roomyLimits, maxTextChars: 3 }]
  ])("enforces the explicit %s limit", (_name, html, limits) => {
    expect(() => parseHtmlDocument(html, limits)).toThrowError(/HTML .* limit/i);
  });

  test("precomputes case-insensitive search text instead of lowercasing per raw element", () => {
    const html = "<script>x</script>".repeat(200);
    const original = String.prototype.toLowerCase;
    let lowercasedCharacters = 0;
    String.prototype.toLowerCase = function trackedToLowerCase(this: string): string {
      lowercasedCharacters += this.length;
      return original.call(this);
    };

    try {
      parseHtmlDocument(html, roomyLimits);
    } finally {
      String.prototype.toLowerCase = original;
    }

    expect(lowercasedCharacters).toBeLessThanOrEqual(html.length * 2);
  });

  test("traverses and renders deep allowed trees without recursion", () => {
    const depth = 5_000;
    const html = `${"<div>".repeat(depth)}x${"</div>".repeat(depth)}`;
    const root = parseHtmlDocument(html, roomyLimits);

    expect(findElements(root, (element) => element.tagName === "div")).toHaveLength(depth);
    expect(renderText(root)).toBe("x");
  });

  test("uses strict top-of-stack semantics for mismatched closing tags", () => {
    const limits = { ...roomyLimits, maxDepth: 2 };

    expect(() => parseHtmlDocument("<div><span></div><section>x</section>", limits))
      .toThrowError(/HTML depth limit/i);
  });

  test("bounds a large mismatched-closing-tag stream by input size without stack-dependent work", () => {
    const depth = 5_000;
    const mismatches = 20_000;
    const html = `${"<div>".repeat(depth)}${"</missing>".repeat(mismatches)}x`;
    const limits = {
      ...roomyLimits,
      maxInputChars: html.length,
      maxNodes: depth + 2
    };

    expect(renderText(parseHtmlDocument(html, limits))).toBe("x");
    expect(() => parseHtmlDocument(html, { ...limits, maxInputChars: html.length - 1 }))
      .toThrowError(/HTML input limit/i);
  });
});
