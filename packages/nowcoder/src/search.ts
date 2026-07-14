import {
  ojSearchResultSchema,
  type OjProblemSummary,
  type OjSearchResult,
  type OjSourceRef
} from "@kaiserunix/oj-mcp-contracts";
import { NowCoderAdapterError } from "./errors.js";
import {
  findElements,
  findFirst,
  hasClass,
  HtmlParseLimitError,
  parseHtmlDocument,
  renderText,
  type HtmlElement
} from "./html.js";
import { isChallengeHtml } from "./parser.js";

const ADAPTER_ID = "nowcoder-public-page";
const ADAPTER_VERSION = "0.2.0";

export interface ParseNowCoderSearchOptions {
  requestId: string;
  query: string;
  page: number;
  limit: number;
  fetchedAt: string;
}

export function nowCoderSearchUrl(query: string, page: number, limit: number): string {
  const url = new URL("https://ac.nowcoder.com/acm/problem/list");
  url.searchParams.set("keyword", query);
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(limit));
  url.searchParams.set("order", "id");
  url.searchParams.set("asc", "false");
  url.searchParams.set("difficulty", "0");
  url.searchParams.set("platformTagId", "0");
  url.searchParams.set("sourceTagId", "0");
  url.searchParams.set("status", "all");
  url.searchParams.set("tagId", "");
  return url.href;
}

export function parseNowCoderProblemListHtml(
  html: string,
  options: ParseNowCoderSearchOptions
): OjSearchResult {
  if (isChallengeHtml(html)) {
    throw new NowCoderAdapterError(
      "challenge.required",
      "NowCoder returned an anti-bot challenge. Complete it in a browser, then retry."
    );
  }

  try {
    const root = parseHtmlDocument(html);
    const list = findFirst(root, (element) => hasClass(element, "js-problem-list"));
    if (!list) {
      throw new NowCoderAdapterError(
        "upstream.schema_changed",
        "NowCoder problem search no longer contains the audited result table."
      );
    }
    const sourceUrl = nowCoderSearchUrl(options.query, options.page, options.limit);
    const source = searchSource(sourceUrl, options.fetchedAt);
    const items = findElements(list, (element) => (
      element.tagName === "tr" && /^\d+$/.test(element.attributes["data-problemid"] ?? "")
    )).map((row) => parseProblemRow(row, sourceUrl, options.fetchedAt));
    const nextPage = findNextPage(root, options.page);
    return ojSearchResultSchema.parse({
      schemaVersion: "oj.search-result/v1",
      requestId: options.requestId,
      items,
      ...(nextPage === undefined ? {} : { nextCursor: String(nextPage) }),
      source
    });
  } catch (error) {
    if (error instanceof NowCoderAdapterError) throw error;
    if (error instanceof HtmlParseLimitError) {
      throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder problem search exceeded parser limits.");
    }
    throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder problem search HTML no longer matches the audited schema.");
  }
}

function parseProblemRow(row: HtmlElement, sourceUrl: string, fetchedAt: string): OjProblemSummary {
  const problemId = row.attributes["data-problemid"]!;
  const nativeId = `NC${problemId}`;
  const problemUrl = `https://ac.nowcoder.com/acm/problem/${problemId}`;
  const cells = row.children.filter((child): child is HtmlElement => child.type === "element" && child.tagName === "td");
  const titleElement = findFirst(row, (element) => element.tagName === "a" && hasClass(element, "title"));
  const title = titleElement ? renderText(titleElement) : "";
  if (!title || cells.length < 4) {
    throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder returned a malformed problem-search row.");
  }
  const difficultyLabel = renderText(cells[2]!);
  const difficulty = integer(difficultyLabel);
  const accepted = integer(renderText(cells[3]!));
  const tags = findElements(row, (element) => element.tagName === "a" && hasClass(element, "tag-label"))
    .map((element) => {
      const name = renderText(element);
      const id = element.attributes["data-id"];
      return name ? {
        namespace: "platform" as const,
        ...(id ? { id } : {}),
        slug: id ?? name,
        name
      } : undefined;
    })
    .filter((tag): tag is NonNullable<typeof tag> => tag !== undefined);
  const refSource: OjSourceRef = {
    ...searchSource(sourceUrl, fetchedAt),
    rawRef: nativeId
  };
  return {
    schemaVersion: "oj.problem-summary/v1",
    ref: {
      schemaVersion: "oj.problem-ref/v1",
      platform: "nowcoder",
      nativeId,
      canonicalId: `nowcoder:${nativeId}`,
      url: problemUrl,
      source: refSource
    },
    title,
    ...(difficulty === undefined ? {} : {
      difficulty: { scale: "nowcoder", value: difficulty, label: difficultyLabel }
    }),
    tags,
    ...(accepted === undefined ? {} : { acceptance: { accepted } }),
    source: refSource
  };
}

function findNextPage(root: HtmlElement, currentPage: number): number | undefined {
  const expected = currentPage + 1;
  const link = findFirst(root, (element) => {
    if (element.tagName !== "a" || renderText(element) !== String(expected)) return false;
    const href = element.attributes.href;
    if (!href) return false;
    try {
      return Number(new URL(href, "https://ac.nowcoder.com").searchParams.get("page")) === expected;
    } catch {
      return false;
    }
  });
  return link ? expected : undefined;
}

function searchSource(sourceUrl: string, fetchedAt: string): OjSourceRef {
  return {
    kind: "page_adapter",
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    fetchedAt,
    sourceUrl,
    confidence: "derived"
  };
}

function integer(value: string): number | undefined {
  return /^\d+$/.test(value) ? Number(value) : undefined;
}
