import { describe, expect, test } from "vitest";
import { parseNowCoderProblemUrl } from "../src/url.js";

describe("parseNowCoderProblemUrl", () => {
  test.each([
    [
      "https://ac.nowcoder.com/acm/problem/218144?from=profile#answer",
      {
        kind: "problem",
        canonicalUrl: "https://ac.nowcoder.com/acm/problem/218144",
        nativeId: "NC218144"
      }
    ],
    [
      "https://ac.nowcoder.com/acm/contest/11244/A",
      {
        kind: "contest",
        canonicalUrl: "https://ac.nowcoder.com/acm/contest/11244/A",
        nativeId: "11244/A",
        contestId: "11244",
        index: "A"
      }
    ]
  ])("canonicalizes the audited public URL shape %s", (url, expected) => {
    expect(parseNowCoderProblemUrl(url)).toMatchObject(expected);
  });

  test.each([
    "http://ac.nowcoder.com/acm/problem/218144",
    "https://nowcoder.com/acm/problem/218144",
    "https://www.nowcoder.com/practice/6dd1bc8539db4b7199f4972a5dc14bd2",
    "https://ac.nowcoder.com:444/acm/problem/218144",
    "https://user@ac.nowcoder.com/acm/problem/218144",
    "https://ac.nowcoder.com/acm/problem/0",
    "https://ac.nowcoder.com/acm/problem/001",
    "https://ac.nowcoder.com/acm/contest/011244/A",
    "https://ac.nowcoder.com/acm/contest/11244/a",
    "https://ac.nowcoder.com/acm/problem/218144/submit-list",
    "https://ac.nowcoder.com/acm/contest/11244/A/../../problem/218144",
    "https://ac.nowcoder.com/acm/contest/11244/%2e./problem/218144",
    "https://ac.nowcoder.com/acm/contest/11244/.%2e/problem/218144",
    "https://127.0.0.1/acm/problem/218144"
  ])("rejects hosts, schemes, credentials, ports, and paths outside the allowlist: %s", (url) => {
    expect(() => parseNowCoderProblemUrl(url)).toThrowError(/allowed public NowCoder problem URL/i);
  });
});
