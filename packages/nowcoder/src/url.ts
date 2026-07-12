const ALLOWED_URL_MESSAGE =
  "Expected an allowed public NowCoder problem URL on https://ac.nowcoder.com/acm/problem/<id> or /acm/contest/<contest>/<index>.";

export interface NowCoderProblemPage {
  kind: "problem";
  canonicalUrl: string;
  nativeId: string;
  problemId: string;
}

export interface NowCoderContestPage {
  kind: "contest";
  canonicalUrl: string;
  nativeId: string;
  contestId: string;
  index: string;
}

export type NowCoderPageRef = NowCoderProblemPage | NowCoderContestPage;
export type NowCoderProblemLocator = { url: string } | { nativeId: string };

export function resolveNowCoderProblemLocator(locator: NowCoderProblemLocator): NowCoderPageRef {
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) {
    throw new Error(ALLOWED_URL_MESSAGE);
  }
  const keys = Object.keys(locator);
  if (keys.length !== 1) throw new Error(ALLOWED_URL_MESSAGE);
  if ("url" in locator && typeof locator.url === "string") return parseNowCoderProblemUrl(locator.url);
  if ("nativeId" in locator && typeof locator.nativeId === "string") return parseNowCoderNativeId(locator.nativeId);
  throw new Error(ALLOWED_URL_MESSAGE);
}

export function parseNowCoderNativeId(value: string): NowCoderPageRef {
  const problem = /^NC([1-9]\d{0,11})$/.exec(value);
  if (problem) {
    const problemId = problem[1];
    return {
      kind: "problem",
      canonicalUrl: `https://ac.nowcoder.com/acm/problem/${problemId}`,
      nativeId: `NC${problemId}`,
      problemId
    };
  }

  const contest = /^([1-9]\d{0,11})\/([A-Z0-9][A-Z0-9_-]{0,15})$/.exec(value);
  if (contest) {
    const contestId = contest[1];
    const index = contest[2];
    return {
      kind: "contest",
      canonicalUrl: `https://ac.nowcoder.com/acm/contest/${contestId}/${index}`,
      nativeId: `${contestId}/${index}`,
      contestId,
      index
    };
  }

  throw new Error("Expected nativeId NC<positive-id> or <positive-contest-id>/<uppercase-or-numeric-index>.");
}

export function parseNowCoderProblemUrl(value: string): NowCoderPageRef {
  if (value.length > 2_048 || value !== value.trim() || hasRawDotSegment(value)) {
    throw new Error(ALLOWED_URL_MESSAGE);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(ALLOWED_URL_MESSAGE);
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "ac.nowcoder.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(ALLOWED_URL_MESSAGE);
  }

  const problem = /^\/acm\/problem\/([1-9]\d{0,11})$/.exec(url.pathname);
  if (problem) {
    const problemId = problem[1];
    return {
      kind: "problem",
      canonicalUrl: `https://ac.nowcoder.com/acm/problem/${problemId}`,
      nativeId: `NC${problemId}`,
      problemId
    };
  }

  const contest = /^\/acm\/contest\/([1-9]\d{0,11})\/([A-Z0-9][A-Z0-9_-]{0,15})$/.exec(url.pathname);
  if (contest) {
    const contestId = contest[1];
    const index = contest[2];
    return {
      kind: "contest",
      canonicalUrl: `https://ac.nowcoder.com/acm/contest/${contestId}/${index}`,
      nativeId: `${contestId}/${index}`,
      contestId,
      index
    };
  }

  throw new Error(ALLOWED_URL_MESSAGE);
}

function hasRawDotSegment(value: string): boolean {
  const rawPath = /^[A-Za-z][A-Za-z\d+.-]*:\/\/[^/?#]+([^?#]*)/.exec(value)?.[1] ?? "";
  return /(?:^|\/)(?:\.{1,2}|%2e(?:%2e)?)(?:\/|$)/i.test(rawPath);
}
