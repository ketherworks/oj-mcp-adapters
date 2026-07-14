import { ojSourceRefSchema, ojVerdictSchema, type OjSourceRef, type OjVerdict } from "@kaiserunix/oj-mcp-contracts";
import { z } from "zod";
import { NowCoderAdapterError } from "./errors.js";
import { findElements, findFirst, hasClass, HtmlParseLimitError, parseHtmlDocument, renderText, type HtmlElement } from "./html.js";
import { isChallengeHtml } from "./parser.js";

const submissionItemSchema = z.object({
  submissionId: z.string().regex(/^[1-9]\d*$/),
  submissionUrl: z.string().url(),
  problem: z.object({
    nativeId: z.string().regex(/^NC[1-9]\d*$/),
    title: z.string().min(1),
    url: z.string().url()
  }).strict(),
  verdict: ojVerdictSchema,
  verdictRaw: z.string().min(1),
  score: z.number().finite().optional(),
  timeMs: z.number().int().nonnegative().optional(),
  memoryBytes: z.number().int().nonnegative().optional(),
  codeLength: z.number().int().nonnegative().optional(),
  language: z.string().min(1),
  submittedAtRaw: z.string().min(1)
}).strict();

export const nowCoderSubmissionListSchema = z.object({
  schemaVersion: z.literal("nowcoder.submission-list/v1"),
  accountId: z.string().regex(/^[1-9]\d{0,11}$/),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
  totalPages: z.number().int().nonnegative(),
  summary: z.object({
    challenged: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    submissions: z.number().int().nonnegative()
  }).strict(),
  items: z.array(submissionItemSchema),
  source: ojSourceRefSchema
}).strict();

export type NowCoderSubmissionList = z.infer<typeof nowCoderSubmissionListSchema>;

export function parseNowCoderSubmissionsHtml(
  html: string,
  options: { accountId: string; page: number; pageSize: number; sourceUrl: string; fetchedAt: string }
): NowCoderSubmissionList {
  if (isChallengeHtml(html)) {
    throw new NowCoderAdapterError("challenge.required", "NowCoder returned an anti-bot challenge. Complete it in a browser, then retry.");
  }
  try {
    const root = parseHtmlDocument(html);
    const table = findFirst(root, (element) => element.tagName === "table" && hasClass(element, "table-hover"));
    if (!table) {
      throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder submission history no longer contains the audited table.");
    }
    const rows = findElements(table, (element) => element.tagName === "tr")
      .filter((row) => directCells(row).length > 0)
      .map(parseSubmissionRow);
    const summary = parseSummary(root);
    const pagination = findFirst(root, (element) => element.tagName === "ul" && element.attributes["data-total"] !== undefined);
    const totalPages = pagination ? integer(pagination.attributes["data-total"]) : rows.length === 0 ? 0 : options.page;
    if (totalPages === undefined) {
      throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder submission pagination is malformed.");
    }
    const source: OjSourceRef = {
      kind: "page_adapter",
      adapterId: "nowcoder-public-page",
      adapterVersion: "0.2.0",
      fetchedAt: options.fetchedAt,
      sourceUrl: options.sourceUrl,
      rawRef: options.accountId,
      confidence: "derived"
    };
    return nowCoderSubmissionListSchema.parse({
      schemaVersion: "nowcoder.submission-list/v1",
      accountId: options.accountId,
      page: options.page,
      pageSize: options.pageSize,
      totalPages,
      summary,
      items: rows,
      source
    });
  } catch (error) {
    if (error instanceof NowCoderAdapterError) throw error;
    if (error instanceof HtmlParseLimitError) {
      throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder submission history exceeded parser limits.");
    }
    throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder submission history no longer matches the audited schema.");
  }
}

function parseSubmissionRow(row: HtmlElement): z.infer<typeof submissionItemSchema> {
  const cells = directCells(row);
  if (cells.length !== 9) {
    throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder returned a malformed submission row.");
  }
  const submissionLink = findFirst(cells[0]!, (element) => element.tagName === "a");
  const problemLink = findFirst(cells[1]!, (element) => element.tagName === "a");
  const submissionId = submissionLink ? renderText(submissionLink) : "";
  const submissionUrl = submissionLink?.attributes.href
    ? new URL(submissionLink.attributes.href, "https://ac.nowcoder.com")
    : undefined;
  const problemMatch = /^\/acm\/problem\/([1-9]\d*)$/.exec(problemLink?.attributes.href ?? "");
  if (
    !/^[1-9]\d*$/.test(submissionId)
    || !problemMatch
    || !submissionUrl
    || submissionUrl.protocol !== "https:"
    || submissionUrl.hostname !== "ac.nowcoder.com"
    || submissionUrl.pathname !== "/acm/contest/view-submission"
    || submissionUrl.searchParams.get("submissionId") !== submissionId
  ) {
    throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder submission links are malformed.");
  }
  const verdictRaw = renderText(cells[2]!);
  const score = decimal(renderText(cells[3]!));
  const timeMs = integer(renderText(cells[4]!));
  const memoryKb = integer(renderText(cells[5]!));
  const codeLength = integer(renderText(cells[6]!));
  return submissionItemSchema.parse({
    submissionId,
    submissionUrl: submissionUrl.href,
    problem: {
      nativeId: `NC${problemMatch[1]}`,
      title: renderText(problemLink!),
      url: `https://ac.nowcoder.com/acm/problem/${problemMatch[1]}`
    },
    verdict: verdict(verdictRaw),
    verdictRaw,
    ...(score === undefined ? {} : { score }),
    ...(timeMs === undefined ? {} : { timeMs }),
    ...(memoryKb === undefined ? {} : { memoryBytes: memoryKb * 1024 }),
    ...(codeLength === undefined ? {} : { codeLength }),
    language: renderText(cells[7]!),
    submittedAtRaw: renderText(cells[8]!)
  });
}

function parseSummary(root: HtmlElement) {
  const values = new Map<string, number>();
  for (const item of findElements(root, (element) => hasClass(element, "my-state-item"))) {
    const labelElement = findFirst(item, (element) => element.tagName === "span");
    const valueElement = findFirst(item, (element) => hasClass(element, "state-num"));
    const label = labelElement ? renderText(labelElement) : "";
    const value = valueElement ? integer(renderText(valueElement)) : undefined;
    if (label && value !== undefined) values.set(label, value);
  }
  return {
    challenged: values.get("题已挑战") ?? 0,
    accepted: values.get("题已通过") ?? 0,
    submissions: values.get("次提交") ?? 0
  };
}

function directCells(row: HtmlElement): HtmlElement[] {
  return row.children.filter((child): child is HtmlElement => child.type === "element" && child.tagName === "td");
}

function verdict(raw: string): OjVerdict {
  const exact: Record<string, OjVerdict> = {
    "答案正确": "accepted",
    "答案错误": "wrong_answer",
    "编译错误": "compile_error",
    "运行超时": "time_limit",
    "内存超限": "memory_limit",
    "输出超限": "output_limit",
    "正在判题": "judging"
  };
  if (exact[raw]) return exact[raw]!;
  if (/运行错误|浮点错误|段错误|返回非零/.test(raw)) return "runtime_error";
  return "unknown";
}

function integer(value: string | undefined): number | undefined {
  const normalized = value?.replace(/,/g, "").trim();
  return normalized !== undefined && /^\d+$/.test(normalized) ? Number(normalized) : undefined;
}

function decimal(value: string): number | undefined {
  const normalized = value.trim();
  return /^\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : undefined;
}
