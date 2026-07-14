import { ojSourceRefSchema, type OjSourceRef } from "@kaiserunix/oj-mcp-contracts";
import { z } from "zod";
import { NowCoderAdapterError } from "./errors.js";
import { findElements, findFirst, hasClass, HtmlParseLimitError, parseHtmlDocument, renderText } from "./html.js";
import { isChallengeHtml } from "./parser.js";

export const nowCoderProfileSchema = z.object({
  schemaVersion: z.literal("nowcoder.profile/v1"),
  accountId: z.string().regex(/^[1-9]\d{0,11}$/),
  displayName: z.string().min(1).max(500),
  bio: z.string().max(2_000).optional(),
  isTeam: z.boolean(),
  rating: z.number().int().nonnegative().optional(),
  ratingRankLabel: z.string().min(1).max(32).optional(),
  followers: z.number().int().nonnegative().optional(),
  members: z.number().int().nonnegative().optional(),
  source: ojSourceRefSchema
}).strict();

export type NowCoderProfile = z.infer<typeof nowCoderProfileSchema>;

export function parseNowCoderProfileHtml(
  html: string,
  options: { accountId: string; fetchedAt: string }
): NowCoderProfile {
  if (isChallengeHtml(html)) {
    throw new NowCoderAdapterError("challenge.required", "NowCoder returned an anti-bot challenge. Complete it in a browser, then retry.");
  }
  try {
    const root = parseHtmlDocument(html);
    const nameElement = findFirst(root, (element) => hasClass(element, "coder-name"));
    const displayName = nameElement?.attributes["data-title"]?.trim() || (nameElement ? renderText(nameElement) : "");
    if (!displayName) {
      throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder profile no longer contains the audited display name.");
    }
    const pageAccountId = /\bwindow\.curUser\.id\s*=\s*["']([1-9]\d{0,11})["']/.exec(html)?.[1];
    if (pageAccountId !== options.accountId) {
      throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder profile account identity did not match the requested profile.");
    }
    const bioElement = findFirst(root, (element) => hasClass(element, "coder-brief"));
    const bio = bioElement ? renderText(bioElement) : "";
    const stats = new Map<string, string>();
    for (const item of findElements(root, (element) => hasClass(element, "status-item"))) {
      const labelElement = findFirst(item, (element) => element.tagName === "span");
      const label = labelElement ? renderText(labelElement) : "";
      const valueElement = findFirst(item, (element) => hasClass(element, "state-num"))
        ?? findFirst(item, (element) => element.tagName === "a");
      const value = valueElement ? renderText(valueElement).replace(/,/g, "").trim() : "";
      if (label && value) stats.set(label, value);
    }
    const source: OjSourceRef = {
      kind: "page_adapter",
      adapterId: "nowcoder-public-page",
      adapterVersion: "0.2.0",
      fetchedAt: options.fetchedAt,
      sourceUrl: `https://ac.nowcoder.com/acm/contest/profile/${options.accountId}`,
      rawRef: options.accountId,
      confidence: "derived"
    };
    return nowCoderProfileSchema.parse({
      schemaVersion: "nowcoder.profile/v1",
      accountId: options.accountId,
      displayName,
      ...(bio ? { bio } : {}),
      isTeam: /\bwindow\.curUser\.isTeam\s*=\s*true\b/.test(html),
      ...(integer(stats.get("Rating")) === undefined ? {} : { rating: integer(stats.get("Rating")) }),
      ...(stats.get("Rating排名") === undefined ? {} : { ratingRankLabel: stats.get("Rating排名") }),
      ...(integer(stats.get("粉丝")) === undefined ? {} : { followers: integer(stats.get("粉丝")) }),
      ...(integer(stats.get("成员")) === undefined ? {} : { members: integer(stats.get("成员")) }),
      source
    });
  } catch (error) {
    if (error instanceof NowCoderAdapterError) throw error;
    if (error instanceof HtmlParseLimitError) {
      throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder profile exceeded parser limits.");
    }
    throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder profile HTML no longer matches the audited schema.");
  }
}

function integer(value: string | undefined): number | undefined {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
}
