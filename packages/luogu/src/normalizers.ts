import {
  ojProblemDocumentSchema,
  ojProblemSummarySchema,
  type OjProblemDocument,
  type OjProblemSummary,
  type OjSourceRef,
  type OjTextBlock
} from "@kaiserunix/oj-mcp-contracts";
import { LuoguAdapterError } from "./client.js";
import { luoguProblemPayloadSchema, luoguProblemSearchPayloadSchema } from "./upstreamSchemas.js";

const LUOGU_ORIGIN = "https://www.luogu.com.cn";
const DEFAULT_LOCALE = "zh-CN";

export interface LuoguNormalizeOptions {
  fetchedAt: string;
  adapterVersion: string;
  sourceUrl: string;
}

export interface LuoguProblemNormalizeOptions extends LuoguNormalizeOptions {
  maxContentChars: number;
}

export function normalizeLuoguSearch(payload: unknown, options: LuoguNormalizeOptions): OjProblemSummary[] {
  const parsed = luoguProblemSearchPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new LuoguAdapterError("upstream.schema_changed", "Luogu problem search no longer matches the audited schema.", {
      cause: parsed.error
    });
  }
  assertSourceUrl(options.sourceUrl);
  return parsed.data.data.problems.result.map((problem) => {
    const nativeId = problem.pid.toUpperCase();
    const source = sourceRef(options, nativeId);
    return ojProblemSummarySchema.parse({
      schemaVersion: "oj.problem-summary/v1",
      ref: problemRef(nativeId, source),
      title: problem.title ?? problem.name,
      difficulty:
        problem.difficulty === undefined || problem.difficulty === null
          ? undefined
          : { scale: "luogu-difficulty", value: problem.difficulty },
      tags: normalizeTags(problem.tags ?? []),
      source
    });
  });
}

export async function normalizeLuoguProblem(payload: unknown, options: LuoguProblemNormalizeOptions): Promise<OjProblemDocument> {
  const parsed = luoguProblemPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new LuoguAdapterError("upstream.schema_changed", "Luogu problem page no longer matches the audited schema.", {
      cause: parsed.error
    });
  }
  assertSourceUrl(options.sourceUrl);
  if (!Number.isSafeInteger(options.maxContentChars) || options.maxContentChars < 1 || options.maxContentChars > 50_000) {
    throw new LuoguAdapterError("request.invalid", "maxContentChars must be an integer from 1 to 50000.");
  }

  const problem = parsed.data.data.problem;
  const nativeId = problem.pid.toUpperCase();
  // Both keys are live, tested compatibility shapes in the attributed upstream adapter.
  const statement =
    joinSections(problem.content?.background ?? "", problem.content?.description ?? "") ||
    joinSections(problem.contenu?.background ?? "", problem.contenu?.description ?? "") ||
    problem.description?.trim() ||
    "";
  if (!statement) {
    throw new LuoguAdapterError("upstream.schema_changed", "Luogu problem page did not contain public statement text.");
  }
  const source = sourceRef(options, nativeId);
  const input = (problem.inputFormat ?? problem.content?.formatI ?? problem.contenu?.formatI)?.trim();
  const output = (problem.outputFormat ?? problem.content?.formatO ?? problem.contenu?.formatO)?.trim();
  const notes = (problem.hint ?? problem.content?.hint ?? problem.contenu?.hint)?.trim();

  return ojProblemDocumentSchema.parse({
    schemaVersion: "oj.problem-document/v1",
    ref: problemRef(nativeId, source),
    title: problem.title ?? problem.name ?? problem.content?.name ?? problem.contenu?.name,
    locale: DEFAULT_LOCALE,
    access: "public",
    difficulty:
      problem.difficulty === undefined || problem.difficulty === null
        ? undefined
        : { scale: "luogu-difficulty", value: problem.difficulty },
    tags: normalizeTags(problem.tags ?? []),
    content: {
      statement: await textBlock(statement, options.maxContentChars),
      input: input ? await textBlock(input, options.maxContentChars) : undefined,
      output: output ? await textBlock(output, options.maxContentChars) : undefined,
      notes: notes ? await textBlock(notes, options.maxContentChars) : undefined
    },
    constraints: [],
    samples: (problem.samples ?? []).map((sample, index) => ({
      ordinal: index + 1,
      input: Array.isArray(sample) ? sample[0] : sample.input,
      output: Array.isArray(sample) ? sample[1] : sample.output
    })),
    limits: {},
    io: { mode: "stdin_stdout" },
    starterCode: [],
    source
  });
}

export function luoguSourceRef(options: LuoguNormalizeOptions, rawRef?: string): OjSourceRef {
  assertSourceUrl(options.sourceUrl);
  return sourceRef(options, rawRef);
}

function sourceRef(options: LuoguNormalizeOptions, rawRef?: string): OjSourceRef {
  return {
    kind: "page_adapter",
    adapterId: "luogu-lentille-page-adapter",
    adapterVersion: options.adapterVersion,
    fetchedAt: options.fetchedAt,
    sourceUrl: options.sourceUrl,
    rawRef,
    confidence: "derived"
  };
}

function problemRef(nativeId: string, source: OjSourceRef) {
  return {
    schemaVersion: "oj.problem-ref/v1" as const,
    platform: "luogu" as const,
    nativeId,
    canonicalId: `luogu:${nativeId}`,
    url: `${LUOGU_ORIGIN}/problem/${encodeURIComponent(nativeId)}`,
    source
  };
}

function normalizeTags(tags: Array<string | number>) {
  return tags.map((tag) => {
    const name = String(tag).trim();
    const numeric = typeof tag === "number";
    const slug = numeric ? `luogu-tag-${name}` : slugify(name);
    return {
      namespace: "platform" as const,
      id: numeric ? name : undefined,
      slug,
      name
    };
  });
}

function slugify(value: string): string {
  const slug = value.toLocaleLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]+/gu, "");
  return slug || "luogu-tag";
}

function joinSections(...sections: string[]): string {
  return sections
    .map((section) => section.trim())
    .filter(Boolean)
    .join("\n\n");
}

async function textBlock(original: string, maxChars: number): Promise<OjTextBlock> {
  const truncated = original.length > maxChars;
  const text = truncated ? original.slice(0, maxChars) : original;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return {
    text,
    format: "markdown",
    locale: DEFAULT_LOCALE,
    truncated,
    originalChars: truncated ? original.length : undefined,
    sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  };
}

function assertSourceUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (caught) {
    throw new LuoguAdapterError("policy.blocked", "Luogu source URL was invalid.", { cause: caught });
  }
  if (url.origin !== LUOGU_ORIGIN || url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new LuoguAdapterError("policy.blocked", "Luogu source URL must stay on the fixed www.luogu.com.cn HTTPS origin.");
  }
}
