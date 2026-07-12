import {
  ojProblemDocumentSchema,
  type OjProblemDocument,
  type OjSourceRef,
  type OjTextBlock
} from "@kaiserunix/oj-mcp-contracts";
import { AtCoderClientError, type AtCoderHtmlPage, type AtCoderLocale } from "./client.js";
import {
  findAll,
  findFirst,
  hasClass,
  HtmlLimitError,
  parseHtml,
  plainText,
  preformattedText,
  sanitizeHtml,
  type HtmlElement,
  type HtmlNode
} from "./html.js";

export interface AtCoderNormalizerOptions {
  fetchedAt: string;
  adapterVersion: string;
}

interface SectionEntry {
  element: HtmlElement;
  heading: HtmlElement;
  label: string;
}

export async function parseAtCoderProblem(
  page: AtCoderHtmlPage,
  options: AtCoderNormalizerOptions
): Promise<OjProblemDocument> {
  let root: HtmlElement;
  try {
    root = parseHtml(page.html);
  } catch (error) {
    if (error instanceof HtmlLimitError) throw drift(`AtCoder HTML exceeded an audited parser limit: ${error.message}`);
    throw error;
  }
  const taskContainer = findFirst(root, (element) => {
    const children = directElements(element);
    if (!children.some((child) => hasClass(child, "h2"))) return false;
    if (children.some((child) => hasClass(child, `lang-${page.locale}`))) return true;
    const statement = children.find((child) => child.attributes.id === "task-statement");
    return statement !== undefined && findFirst(statement, (child) => hasClass(child, `lang-${page.locale}`)) !== undefined;
  });
  if (!taskContainer) throw drift("AtCoder did not expose the audited task container structure.");
  const taskChildren = directElements(taskContainer);
  const statementContainer = taskChildren.find((element) => element.attributes.id === "task-statement");
  const localeRoot =
    taskChildren.find((element) => hasClass(element, `lang-${page.locale}`)) ??
    (statementContainer
      ? findFirst(statementContainer, (element) => hasClass(element, `lang-${page.locale}`))
      : undefined);
  if (!localeRoot) throw drift(`AtCoder did not expose a ${page.locale} statement container.`);

  const titleElement = taskChildren.find((element) => hasClass(element, "h2"));
  const titleText = titleElement
    ? titleElement.children
        .filter((child): child is Extract<HtmlNode, { type: "text" }> => child.type === "text")
        .map((child) => child.value)
        .join(" ")
        .trim()
    : undefined;
  const titleMatch = titleText ? /^([a-zA-Z0-9]+)\s*-\s*(.+)$/s.exec(titleText) : undefined;
  if (!titleMatch) throw drift("AtCoder task title no longer matches the audited heading structure.");

  const sections = findAll(localeRoot, (element) => element.name === "section")
    .map(sectionEntry)
    .filter((entry): entry is SectionEntry => entry !== undefined);
  const labels = localizedLabels(page.locale);
  const statementSection = sections.find((section) => labels.statement.test(section.label));
  if (!statementSection) throw drift(`AtCoder ${page.locale} statement is missing its problem statement section.`);

  const rawSha256 = await sha256(page.html);
  const source: OjSourceRef = {
    kind: "page_adapter",
    adapterId: "atcoder-page-adapter",
    adapterVersion: options.adapterVersion,
    fetchedAt: options.fetchedAt,
    sourceUrl: page.sourceUrl,
    ...(page.etag ? { etag: page.etag } : {}),
    rawRef: `sha256:${rawSha256}`,
    confidence: "authoritative"
  };

  const inputSection = sections.find((section) => labels.input.test(section.label));
  if (!inputSection) throw drift(`AtCoder ${page.locale} statement is missing its required Input section.`);
  const outputSection = sections.find((section) => labels.output.test(section.label));
  if (!outputSection) throw drift(`AtCoder ${page.locale} statement is missing its required Output section.`);
  const notesSection = sections.find((section) => labels.notes.test(section.label));
  const taskStructure = classifyTaskStructure(statementSection, sections);
  const constraintsSection = sections.find((section) => labels.constraints.test(section.label));
  if (taskStructure.constraintsRequired && !constraintsSection) {
    throw drift(`AtCoder ${page.locale} ordinary/interactive task is missing its required Constraints section.`);
  }
  const constraints = constraintsSection ? extractConstraints(constraintsSection, page.canonicalUrl) : [];
  if (constraintsSection && constraints.length === 0) {
    throw drift(`AtCoder ${page.locale} Constraints section has no extractable content.`);
  }
  const samples = extractSamples(sections, labels, page.canonicalUrl);
  if (taskStructure.samplesRequired && samples.length === 0) {
    throw drift(`AtCoder ${page.locale} ordinary task is missing all sample input/output sections.`);
  }
  const content: OjProblemDocument["content"] = {
    statement: await textBlock(statementSection, page.locale, page.canonicalUrl),
    input: await textBlock(inputSection, page.locale, page.canonicalUrl),
    output: await textBlock(outputSection, page.locale, page.canonicalUrl),
    ...(notesSection ? { notes: await textBlock(notesSection, page.locale, page.canonicalUrl) } : {})
  };
  const limits = parseLimits(taskContainer, taskStructure.limitsRequired);

  return ojProblemDocumentSchema.parse({
    schemaVersion: "oj.problem-document/v1",
    ref: {
      schemaVersion: "oj.problem-ref/v1",
      platform: "atcoder",
      site: "global",
      nativeId: `${page.contestId}/${page.taskId}`,
      canonicalId: `atcoder:${page.contestId}/${page.taskId}`,
      url: page.canonicalUrl,
      contest: { nativeId: page.contestId, index: titleMatch[1]!.toUpperCase() },
      source
    },
    title: titleMatch[2]!.trim(),
    locale: page.locale,
    access: "public",
    tags: [],
    content,
    constraints,
    samples,
    limits,
    io: { mode: taskStructure.interactive ? "interactive" : taskStructure.outputOnly ? "file" : "stdin_stdout" },
    starterCode: [],
    source
  });
}

function sectionEntry(element: HtmlElement): SectionEntry | undefined {
  const heading = findFirst(element, (candidate) => candidate.name === "h3");
  if (!heading) return undefined;
  const label = plainText(heading);
  return label ? { element, heading, label } : undefined;
}

async function textBlock(section: SectionEntry, locale: AtCoderLocale, baseUrl: string): Promise<OjTextBlock> {
  const sanitized = sanitizeHtml(section.element.children, baseUrl, new Set<HtmlNode>([section.heading]));
  if (!sanitized.text) throw drift(`AtCoder section '${section.label}' has no meaningful sanitized content.`);
  return {
    text: sanitized.html,
    format: "html",
    locale,
    truncated: false,
    sha256: await sha256(sanitized.html)
  };
}

function extractConstraints(section: SectionEntry, baseUrl: string): string[] {
  const listItems = findAll(section.element, (element) => element.name === "li")
    .map((element) => sanitizeHtml([element], baseUrl).text)
    .filter(Boolean);
  if (listItems.length > 0) return listItems;
  return sanitizeHtml(section.element.children, baseUrl, new Set<HtmlNode>([section.heading])).text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractSamples(
  sections: SectionEntry[],
  labels: ReturnType<typeof localizedLabels>,
  baseUrl: string
): OjProblemDocument["samples"] {
  const inputs = new Map<number, SectionEntry>();
  const outputs = new Map<number, SectionEntry>();
  for (const section of sections) {
    const inputMatch = labels.sampleInput.exec(section.label);
    const outputMatch = labels.sampleOutput.exec(section.label);
    if (inputMatch) inputs.set(Number(inputMatch[1]), section);
    if (outputMatch) outputs.set(Number(outputMatch[1]), section);
  }
  if (inputs.size !== outputs.size || [...inputs.keys()].some((ordinal) => !outputs.has(ordinal))) {
    throw drift("AtCoder sample input/output sections were not paired.");
  }

  return [...inputs.entries()]
    .sort(([left], [right]) => left - right)
    .map(([ordinal, inputSection]) => {
      const outputSection = outputs.get(ordinal)!;
      const inputPre = findFirst(inputSection.element, (element) => element.name === "pre");
      const outputPre = findFirst(outputSection.element, (element) => element.name === "pre");
      if (!inputPre || !outputPre) throw drift(`AtCoder sample ${ordinal} is missing a preformatted input or output block.`);
      const input = preformattedText(inputPre);
      const output = preformattedText(outputPre);
      if (!sanitizeHtml([inputPre], baseUrl).text || !input.trim()) {
        throw drift(`AtCoder sample ${ordinal} input has no meaningful sanitized text.`);
      }
      if (!sanitizeHtml([outputPre], baseUrl).text || !output.trim()) {
        throw drift(`AtCoder sample ${ordinal} output has no meaningful sanitized text.`);
      }
      const explanationNodes = outputSection.element.children.filter(
        (node) => node !== outputSection.heading && node !== outputPre
      );
      const explanation = sanitizeHtml(explanationNodes, baseUrl).text;
      return {
        ordinal,
        input,
        output,
        ...(explanation ? { explanation } : {})
      };
    });
}

function classifyTaskStructure(statementSection: SectionEntry, sections: SectionEntry[]) {
  const headings = sections.map((section) => normalizeClassificationText(section.label));
  const notices = findAll(statementSection.element, (element) => element.name === "p").map((element) =>
    normalizeClassificationText(plainText(element))
  );
  const interactive = headings.some((heading) => INTERACTIVE_HEADINGS.has(heading)) ||
    notices.some((notice) => INTERACTIVE_NOTICES.has(notice));
  const outputOnly = headings.some((heading) => OUTPUT_ONLY_HEADINGS.has(heading)) ||
    notices.some((notice) => OUTPUT_ONLY_NOTICES.has(notice));
  if (interactive && outputOnly) throw drift("AtCoder task exposes conflicting audited special-task markers.");
  return {
    interactive,
    outputOnly,
    samplesRequired: !interactive && !outputOnly,
    constraintsRequired: !outputOnly,
    limitsRequired: !outputOnly
  };
}

function normalizeClassificationText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

const INTERACTIVE_HEADINGS = new Set(["interaction", "インタラクション", "対話"]);
const OUTPUT_ONLY_HEADINGS = new Set(["output-only", "output only", "output-only task", "output only task", "出力のみ", "出力のみの問題"]);
const INTERACTIVE_NOTICES = new Set([
  "this is an interactive task.",
  "this is an interactive task",
  "これはインタラクティブな問題です。",
  "これはインタラクティブ問題です。"
]);
const OUTPUT_ONLY_NOTICES = new Set([
  "this is an output-only task.",
  "this is an output-only task",
  "これは出力のみの問題です。"
]);

function parseLimits(taskContainer: HtmlElement, required: boolean): OjProblemDocument["limits"] {
  const candidates = directElements(taskContainer).filter(
    (element) => element.name === "p" && /(?:Time Limit|実行時間制限|Memory Limit|メモリ制限)\s*:/i.test(plainText(element))
  );
  if (candidates.length === 0) {
    if (required) throw drift("AtCoder ordinary/interactive task is missing its required limits banner.");
    return {};
  }
  if (candidates.length !== 1) throw drift("AtCoder task exposes multiple candidate limits banners.");
  const value = plainText(candidates[0]!);
  const hasTimeLabel = /(?:Time Limit|実行時間制限)\s*:/i.test(value);
  const hasMemoryLabel = /(?:Memory Limit|メモリ制限)\s*:/i.test(value);
  if (!hasTimeLabel && !hasMemoryLabel) throw drift("AtCoder limits banner no longer exposes audited labels.");
  const time = /(?:Time Limit|実行時間制限)\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*(ms|msec|sec|s)\b/i.exec(value);
  const memory = /(?:Memory Limit|メモリ制限)\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*(KiB|MiB|GiB|KB|MB|GB)\b/i.exec(value);
  if (!time || !memory) throw drift("AtCoder limits banner no longer exposes a parseable time/memory pair.");
  return {
    timeMs: Number(time[1]) * (/^m/i.test(time[2]!) ? 1 : 1_000),
    memoryBytes: memoryBytes(Number(memory[1]), memory[2]!)
  };
}

function directElements(element: HtmlElement): HtmlElement[] {
  return element.children.filter((node): node is HtmlElement => node.type === "element");
}

function memoryBytes(value: number, unit: string): number {
  const binary = unit.includes("i");
  const base = binary ? 1_024 : 1_000;
  const exponent = { KIB: 1, KB: 1, MIB: 2, MB: 2, GIB: 3, GB: 3 }[unit.toUpperCase()] ?? 0;
  return Math.round(value * base ** exponent);
}

function localizedLabels(locale: AtCoderLocale) {
  return locale === "ja"
    ? {
        statement: /^問題文$/,
        constraints: /^制約$/,
        input: /^入力$/,
        output: /^出力$/,
        notes: /^(?:注記|注意|備考)$/,
        sampleInput: /^入力例\s*([1-9][0-9]*)$/,
        sampleOutput: /^出力例\s*([1-9][0-9]*)$/
      }
    : {
        statement: /^Problem Statement$/i,
        constraints: /^Constraints$/i,
        input: /^Input$/i,
        output: /^Output$/i,
        notes: /^Notes?$/i,
        sampleInput: /^Sample Input\s*([1-9][0-9]*)$/i,
        sampleOutput: /^Sample Output\s*([1-9][0-9]*)$/i
      };
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function drift(message: string): AtCoderClientError {
  return new AtCoderClientError("upstream.schema_changed", message);
}
