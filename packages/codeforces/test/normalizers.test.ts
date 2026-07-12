import { describe, expect, test } from "vitest";
import { ojProblemSummarySchema } from "@kaiserunix/oj-mcp-contracts";
import { normalizeCodeforcesProblemset, searchCodeforcesProblems } from "../src/normalizers.js";
import { loadFixture } from "./fixtureLoader.js";

describe("Codeforces normalizers", () => {
  test("normalizes official 4/A metadata with authoritative provenance", async () => {
    const summaries = normalizeCodeforcesProblemset(await loadFixture("problemset-ok.json"), {
      fetchedAt: "2026-07-10T12:00:00.000Z",
      adapterVersion: "0.1.0"
    });
    const watermelon = summaries.find((item) => item.ref.nativeId === "4/A");

    expect(watermelon).toMatchObject({
      schemaVersion: "oj.problem-summary/v1",
      title: "Watermelon",
      difficulty: { scale: "codeforces-rating", value: 800 },
      acceptance: { accepted: 215000 },
      source: { kind: "official_api", confidence: "authoritative" }
    });
    expect(ojProblemSummarySchema.parse(watermelon)).toEqual(watermelon);
  });

  test("searches by id, title, and tag with exact ids first", async () => {
    const summaries = normalizeCodeforcesProblemset(await loadFixture("problemset-ok.json"), {
      fetchedAt: "2026-07-10T12:00:00.000Z",
      adapterVersion: "0.1.0"
    });

    expect(searchCodeforcesProblems(summaries, "4/A", 10)[0].ref.nativeId).toBe("4/A");
    expect(searchCodeforcesProblems(summaries, "water", 10)[0].title).toBe("Watermelon");
    expect(searchCodeforcesProblems(summaries, "strings", 10)[0].ref.nativeId).toBe("71/A");
  });

  test("normalizes a stable problemsetName/index identity when contestId is absent", () => {
    const summaries = normalizeCodeforcesProblemset(
      {
        status: "OK",
        result: {
          problems: [
            {
              problemsetName: "acmsguru",
              index: "100",
              name: "A+B",
              type: "PROGRAMMING",
              tags: []
            }
          ],
          problemStatistics: [{ index: "100", solvedCount: 99 }]
        }
      },
      { fetchedAt: "2026-07-10T12:00:00.000Z", adapterVersion: "0.1.0" }
    );

    expect(summaries[0]).toMatchObject({
      ref: {
        nativeId: "acmsguru/100",
        canonicalId: "codeforces:acmsguru/100",
        contest: { nativeId: "acmsguru", index: "100" }
      },
      acceptance: { accepted: 99 }
    });
  });
});
