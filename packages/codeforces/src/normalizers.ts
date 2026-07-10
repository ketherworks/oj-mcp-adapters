import type { OjProblemSummary, OjSourceRef } from "@kaiserunix/oj-mcp-contracts";
import { ojProblemSummarySchema } from "@kaiserunix/oj-mcp-contracts";
import type { CodeforcesProblemsetResponse } from "./client.js";

export interface NormalizeCodeforcesOptions {
  fetchedAt: string;
  adapterVersion: string;
}

export function normalizeCodeforcesProblemset(payload: unknown, options: NormalizeCodeforcesOptions): OjProblemSummary[] {
  const response = payload as CodeforcesProblemsetResponse;
  const solvedByProblem = new Map(
    response.result.problemStatistics.map((statistic) => [`${statistic.contestId}/${statistic.index}`, statistic.solvedCount])
  );

  return response.result.problems.map((problem) => {
    const nativeId = `${problem.contestId}/${problem.index}`;
    const problemUrl = `https://codeforces.com/problemset/problem/${problem.contestId}/${problem.index}`;
    const source: OjSourceRef = {
      kind: "official_api",
      adapterId: "codeforces-official-api",
      adapterVersion: options.adapterVersion,
      fetchedAt: options.fetchedAt,
      sourceUrl: "https://codeforces.com/api/problemset.problems",
      rawRef: nativeId,
      confidence: "authoritative"
    };
    return ojProblemSummarySchema.parse({
      schemaVersion: "oj.problem-summary/v1",
      ref: {
        schemaVersion: "oj.problem-ref/v1",
        platform: "codeforces",
        nativeId,
        canonicalId: `codeforces:${nativeId}`,
        url: problemUrl,
        contest: { nativeId: String(problem.contestId), index: problem.index },
        source
      },
      title: problem.name,
      difficulty: problem.rating === undefined ? undefined : { scale: "codeforces-rating", value: problem.rating },
      tags: problem.tags.map((tag) => ({ namespace: "platform", slug: slug(tag), name: tag })),
      acceptance: { accepted: solvedByProblem.get(nativeId) },
      source
    });
  });
}

export function searchCodeforcesProblems(summaries: OjProblemSummary[], query: string, limit: number): OjProblemSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return summaries
    .map((summary) => ({ summary, score: matchScore(summary, normalizedQuery) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.summary.ref.nativeId.localeCompare(right.summary.ref.nativeId))
    .slice(0, limit)
    .map((candidate) => candidate.summary);
}

function matchScore(summary: OjProblemSummary, query: string): number {
  const id = summary.ref.nativeId.toLocaleLowerCase();
  if (id === query) return 100;
  if (id.includes(query)) return 80;
  const title = summary.title.toLocaleLowerCase();
  if (title === query) return 70;
  if (title.includes(query)) return 60;
  if (summary.tags.some((tag) => tag.name.toLocaleLowerCase().includes(query))) return 40;
  return 0;
}

function slug(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, "-");
}
