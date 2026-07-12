import { createHash } from "node:crypto";
import {
  ojProblemDocumentSchema,
  type OjProblemDocument,
  type OjSourceRef,
  type OjTextBlock
} from "@kaiserunix/oj-mcp-contracts";
import { NowCoderAdapterError } from "./errors.js";
import {
  findElements,
  findFirst,
  hasClass,
  HtmlParseLimitError,
  isWithinClass,
  parseHtmlDocument,
  renderText,
  sampleText,
  type HtmlElement
} from "./html.js";
import { parseNowCoderProblemUrl } from "./url.js";

const ADAPTER_ID = "nowcoder-public-page";
const ADAPTER_VERSION = "0.1.0";

export interface ParseNowCoderOptions {
  url: string;
  fetchedAt: string;
  etag?: string;
}

export function parseNowCoderProblemHtml(html: string, options: ParseNowCoderOptions): OjProblemDocument {
  if (isChallengeHtml(html)) {
    throw new NowCoderAdapterError(
      "challenge.required",
      "NowCoder returned an anti-bot challenge. This adapter does not use cookies or a browser to bypass it."
    );
  }

  const page = parseNowCoderProblemUrl(options.url);
  let root: HtmlElement;
  try {
    root = parseHtmlDocument(html);
  } catch (error) {
    if (error instanceof HtmlParseLimitError) throw schemaDrift(error.message);
    throw error;
  }
  const titleElement = findFirst(root, (element) => hasClass(element, "terminal-topic-title"));
  const statementElement = findFirst(root, (element) => hasClass(element, "subject-question"));
  const metadataElement = findFirst(root, (element) => hasClass(element, "subject-item-wrap"));
  const title = titleElement ? renderText(titleElement) : "";
  const statement = statementElement ? renderText(statementElement) : "";
  const metadata = metadataElement ? renderText(metadataElement) : "";

  if (!title || !statement || !metadata) {
    throw schemaDrift("NowCoder problem HTML is missing the audited title, statement, or metadata nodes.");
  }
  if (page.kind === "problem") {
    const displayedId = /题号\s*[：:]\s*(NC\d+)/i.exec(metadata)?.[1]?.toUpperCase();
    if (displayedId !== page.nativeId) {
      throw schemaDrift("NowCoder problem metadata does not match the requested public problem URL.");
    }
  }

  const input = findSection(root, ["输入描述"]);
  const output = findSection(root, ["输出描述"]);
  const notes = findSection(root, ["备注", "说明"], true);
  if (input === undefined || output === undefined) {
    throw schemaDrift("NowCoder problem HTML is missing a required input or output section.");
  }
  const source: OjSourceRef = {
    kind: "page_adapter",
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    fetchedAt: options.fetchedAt,
    sourceUrl: page.canonicalUrl,
    rawRef: page.nativeId,
    confidence: "derived",
    ...(options.etag ? { etag: options.etag } : {})
  };
  const content = {
    statement: textBlock(statement),
    input: textBlock(input),
    output: textBlock(output),
    ...(notes ? { notes: textBlock(notes) } : {})
  };
  const difficulty = parseDifficulty(metadata);

  return ojProblemDocumentSchema.parse({
    schemaVersion: "oj.problem-document/v1",
    ref: {
      schemaVersion: "oj.problem-ref/v1",
      platform: "nowcoder",
      site: "cn",
      nativeId: page.nativeId,
      canonicalId: `nowcoder:${page.nativeId}`,
      url: page.canonicalUrl,
      ...(page.kind === "contest" ? { contest: { nativeId: page.contestId, index: page.index } } : {}),
      source
    },
    title,
    locale: "zh-CN",
    access: "public",
    ...(difficulty ? { difficulty } : {}),
    tags: parseTags(root),
    content,
    constraints: extractConstraints(statement, input),
    samples: parseSamples(root),
    limits: parseLimits(metadata),
    io: { mode: "stdin_stdout" },
    starterCode: [],
    source
  });
}

export function isChallengeHtml(html: string): boolean {
  const title = /<title\b[^>]*>([\s\S]{0,256}?)<\/title>/i.exec(html)?.[1] ?? "";
  return /安全验证|访问验证|人机验证|验证码|captcha|just a moment/i.test(title)
    || /(?:class|id)\s*=\s*["'][^"']*(?:captcha|geetest|challenge)[^"']*["']/i.test(html)
    || /challenge-platform|cf-chl|_cf_chl/i.test(html)
    || /请.{0,8}(?:完成|通过).{0,12}(?:验证|验证码).{0,12}(?:继续访问|后重试)/i.test(html);
}

function findSection(root: HtmlElement, labels: string[], excludeSamples = false): string | undefined {
  const elements = findElements(root, () => true);
  const headingIndex = elements.findIndex((element) => {
    if (!/^h[1-6]$/.test(element.tagName)) return false;
    if (excludeSamples && isWithinClass(element, "question-oi-bd")) return false;
    return labels.includes(normalizeHeading(renderText(element)));
  });
  if (headingIndex < 0) return undefined;
  for (const element of elements.slice(headingIndex + 1)) {
    if (/^h[1-6]$/.test(element.tagName)) break;
    if (element.tagName === "pre") {
      const text = renderText(element);
      return text || undefined;
    }
  }
  return undefined;
}

function parseSamples(root: HtmlElement): OjProblemDocument["samples"] {
  const bodies = findElements(root, (element) => hasClass(element, "question-oi-bd"));
  return bodies.map((body, index) => {
    const modules = findElements(body, (element) => hasClass(element, "question-oi-mod"));
    let input: string | undefined;
    let output: string | undefined;
    let explanation: string | undefined;

    for (const module of modules) {
      const heading = findFirst(module, (element) => /^h[1-6]$/.test(element.tagName));
      const label = heading ? normalizeHeading(renderText(heading)) : "";
      const valueElement = findFirst(module, (element) => element.tagName === "textarea")
        ?? findFirst(module, (element) => element.tagName === "pre");
      if (!valueElement) continue;
      const value = label === "说明" ? renderText(valueElement) : sampleText(valueElement);
      if (label === "输入") input = value;
      if (label === "输出") output = value;
      if (label === "说明" && value) explanation = value;
    }

    if (input === undefined || output === undefined) {
      throw schemaDrift(`NowCoder sample ${index + 1} is missing its input or output block.`);
    }
    return { ordinal: index + 1, input, output, ...(explanation ? { explanation } : {}) };
  });
}

function parseTags(root: HtmlElement): OjProblemDocument["tags"] {
  const names = findElements(root, (element) =>
    ["tag-label", "tag-item", "question-tag", "knowledge-point"].some((className) => hasClass(element, className))
  )
    .map((element) => renderText(element))
    .filter(Boolean);
  return [...new Set(names)].map((name) => ({ namespace: "platform" as const, slug: slug(name), name }));
}

function parseLimits(metadata: string): OjProblemDocument["limits"] {
  const timeLine = metadata.split("\n").find((line) => line.includes("时间限制")) ?? "";
  const memoryLine = metadata.split("\n").find((line) => line.includes("空间限制")) ?? "";
  const timeValues = [...timeLine.matchAll(/(\d+(?:\.\d+)?)\s*(毫秒|ms|秒|s)/gi)].map((match) =>
    Number(match[1]) * (/毫秒|ms/i.test(match[2]) ? 1 : 1_000)
  );
  const memoryValues = [...memoryLine.matchAll(/(\d+(?:\.\d+)?)\s*(GB|G|MB|M|KB|K|字节|B)/gi)].map((match) => {
    const unit = match[2].toUpperCase();
    const multiplier = unit === "GB" || unit === "G" ? 1024 ** 3 : unit === "MB" || unit === "M" ? 1024 ** 2 : unit === "KB" || unit === "K" ? 1024 : 1;
    return Math.round(Number(match[1]) * multiplier);
  });
  return {
    ...(timeValues.length ? { timeMs: Math.max(...timeValues) } : {}),
    ...(memoryValues.length ? { memoryBytes: Math.max(...memoryValues) } : {})
  };
}

function parseDifficulty(metadata: string): OjProblemDocument["difficulty"] | undefined {
  const value = /难度\s*[：:]\s*(\d+(?:\.\d+)?)/.exec(metadata)?.[1];
  return value ? { scale: "nowcoder-rating", value: Number(value) } : undefined;
}

function extractConstraints(...sections: Array<string | undefined>): string[] {
  const candidates = sections
    .filter((section): section is string => Boolean(section))
    .flatMap((section) => section.split(/\n|(?<=[。；;])/))
    .map((candidate) => candidate.trim())
    .filter((candidate) => /\d/.test(candidate) && /\\(?:le|ge)|<=|>=|≤|≥|不超过|至少|至多|范围|保证/.test(candidate));
  return [...new Set(candidates)];
}

function textBlock(text: string): OjTextBlock {
  return {
    text,
    format: "text",
    locale: "zh-CN",
    truncated: false,
    sha256: createHash("sha256").update(text, "utf8").digest("hex")
  };
}

function normalizeHeading(value: string): string {
  return value.replace(/[\s：:]+$/g, "").trim();
}

function slug(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN").replace(/\s+/g, "-");
}

function schemaDrift(message: string): NowCoderAdapterError {
  return new NowCoderAdapterError("upstream.schema_changed", message);
}
