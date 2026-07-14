import { describe, expect, test } from "vitest";
import { parseNowCoderProfileHtml } from "../src/profile.js";
import { loadFixture } from "./fixtureLoader.js";

describe("NowCoder profile", () => {
  test("normalizes the compact competition profile", async () => {
    const profile = parseNowCoderProfileHtml(await loadFixture("profile.html"), {
      accountId: "886965097",
      fetchedAt: "2026-07-14T16:00:00.000Z"
    });

    expect(profile).toEqual({
      schemaVersion: "nowcoder.profile/v1",
      accountId: "886965097",
      displayName: "HoMaMaOvO",
      bio: "maroonrk的团队",
      isTeam: true,
      rating: 3979,
      ratingRankLabel: "1",
      followers: 226,
      members: 3,
      source: {
        kind: "page_adapter",
        adapterId: "nowcoder-public-page",
        adapterVersion: "0.2.0",
        fetchedAt: "2026-07-14T16:00:00.000Z",
        sourceUrl: "https://ac.nowcoder.com/acm/contest/profile/886965097",
        rawRef: "886965097",
        confidence: "derived"
      }
    });
  });
});
