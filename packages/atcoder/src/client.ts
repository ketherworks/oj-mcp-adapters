export type AtCoderLocale = "en" | "ja";

export interface AtCoderTaskLocator {
  contestId: string;
  taskId: string;
  locale: AtCoderLocale;
}

export interface AtCoderHtmlPage {
  contestId: string;
  taskId: string;
  locale: AtCoderLocale;
  canonicalUrl: string;
  sourceUrl: string;
  html: string;
  etag?: string;
}

export interface AtCoderHtmlClientOptions {
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  timeoutMs?: number;
}

export type AtCoderClientErrorCode =
  | "request.invalid"
  | "policy.blocked"
  | "challenge.required"
  | "resource.not_found"
  | "rate_limited"
  | "network.timeout"
  | "upstream.unavailable"
  | "upstream.schema_changed";

export type AtCoderTransportCause = "consumer_cancelled" | "timeout";

export class AtCoderClientError extends Error {
  constructor(
    readonly code: AtCoderClientErrorCode,
    message: string,
    readonly httpStatus?: number,
    readonly retryAfterMs?: number,
    readonly transportCause?: AtCoderTransportCause
  ) {
    super(message);
    this.name = "AtCoderClientError";
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TASK_PATH_PATTERN = /^\/contests\/([a-z0-9][a-z0-9_-]{0,63})\/tasks\/([a-z0-9][a-z0-9_-]{0,63})$/;

export function parseAtCoderTaskUrl(value: string, localeOverride?: AtCoderLocale): AtCoderTaskLocator {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Expected a canonical AtCoder task URL.");
  }

  const match = TASK_PATH_PATTERN.exec(url.pathname);
  const queryKeys: string[] = [];
  url.searchParams.forEach((_value, key) => queryKeys.push(key));
  if (
    url.protocol !== "https:" ||
    url.hostname !== "atcoder.jp" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !match ||
    queryKeys.some((key) => key !== "lang") ||
    url.searchParams.getAll("lang").length > 1
  ) {
    throw new TypeError("Only canonical https://atcoder.jp/contests/{contest}/tasks/{task} URLs are allowed.");
  }

  const requestedLocale = localeOverride ?? url.searchParams.get("lang") ?? "en";
  if (requestedLocale !== "en" && requestedLocale !== "ja") {
    throw new TypeError("AtCoder locale must be 'en' or 'ja'.");
  }
  return { contestId: match[1]!, taskId: match[2]!, locale: requestedLocale };
}

export class AtCoderHtmlClient {
  private readonly fetchImpl: typeof fetch;
  private readonly maxResponseBytes: number;
  private readonly timeoutMs: number;

  constructor(options: AtCoderHtmlClientOptions = {}) {
    const fetchImpl = options.fetchImpl ?? fetch;
    this.fetchImpl = (input, init) => fetchImpl(input, init);
    this.maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  async fetchTask(locator: AtCoderTaskLocator, callerSignal?: AbortSignal): Promise<AtCoderHtmlPage> {
    if (!ID_PATTERN.test(locator.contestId) || !ID_PATTERN.test(locator.taskId)) {
      throw new TypeError("AtCoder contest and task ids must use canonical lowercase identifier syntax.");
    }
    if (locator.locale !== "en" && locator.locale !== "ja") {
      throw new TypeError("AtCoder locale must be 'en' or 'ja'.");
    }

    const canonicalUrl = `https://atcoder.jp/contests/${locator.contestId}/tasks/${locator.taskId}`;
    let sourceUrl = `${canonicalUrl}?lang=${locator.locale}`;
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () =>
      controller.abort(callerSignal?.reason ?? new DOMException("AtCoder request was cancelled.", "AbortError"));
    if (callerSignal?.aborted) abortFromCaller();
    else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort(new DOMException("AtCoder request timed out.", "TimeoutError"));
      },
      this.timeoutMs
    );
    try {
      let response: Response | undefined;
      for (let redirectCount = 0; redirectCount <= 2; redirectCount += 1) {
        response = await this.fetchImpl(sourceUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Accept: "text/html",
            "User-Agent": "oj-mcp-atcoder/0.1.0"
          }
        });
        if (response.status < 300 || response.status >= 400) break;

        const location = response.headers.get("location");
        await cancelResponseBody(response);
        if (!location) {
          throw new AtCoderClientError("upstream.unavailable", "AtCoder returned a redirect without a Location header.", response.status);
        }
        let redirected: AtCoderTaskLocator;
        try {
          redirected = parseAtCoderTaskUrl(new URL(location, sourceUrl).toString());
        } catch {
          throw new AtCoderClientError("policy.blocked", "AtCoder redirected outside the canonical task allowlist.", response.status);
        }
        if (
          redirected.contestId !== locator.contestId ||
          redirected.taskId !== locator.taskId ||
          redirected.locale !== locator.locale
        ) {
          throw new AtCoderClientError("policy.blocked", "AtCoder redirected to a different task or locale.", response.status);
        }
        if (redirectCount === 2) {
          throw new AtCoderClientError("upstream.unavailable", "AtCoder exceeded the two-redirect limit.", response.status);
        }
        sourceUrl = `https://atcoder.jp/contests/${redirected.contestId}/tasks/${redirected.taskId}?lang=${redirected.locale}`;
      }

      if (!response) {
        throw new AtCoderClientError("upstream.unavailable", "AtCoder did not return a response.");
      }

      if (response.status === 404) {
        await cancelResponseBody(response);
        throw new AtCoderClientError("resource.not_found", `AtCoder task ${locator.contestId}/${locator.taskId} was not found.`, 404);
      }
      if (response.status === 429) {
        const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
        await cancelResponseBody(response);
        throw new AtCoderClientError(
          "rate_limited",
          "AtCoder rate limited this anonymous read. Retry after the reported delay.",
          429,
          retryAfterMs
        );
      }
      if (response.status === 401 || response.status === 403) {
        await cancelResponseBody(response);
        throw new AtCoderClientError(
          "challenge.required",
          "AtCoder blocked the anonymous page request; retry later rather than supplying credentials.",
          response.status
        );
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new AtCoderClientError("upstream.unavailable", `AtCoder returned HTTP ${response.status}.`, response.status);
      }
      if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) {
        await cancelResponseBody(response);
        throw new AtCoderClientError("upstream.schema_changed", "AtCoder returned a non-HTML task response.", response.status);
      }
      const declaredBytes = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredBytes) && declaredBytes > this.maxResponseBytes) {
        await cancelResponseBody(response);
        throw new AtCoderClientError("upstream.unavailable", "AtCoder HTML exceeded the configured response size limit.", response.status);
      }

      const html = await readUtf8Body(response, this.maxResponseBytes);
      const etag = response.headers.get("etag");
      return {
        ...locator,
        canonicalUrl,
        sourceUrl,
        html,
        ...(etag ? { etag } : {})
      };
    } catch (error) {
      if (error instanceof AtCoderClientError) throw error;
      if (controller.signal.aborted || isTimeoutError(error)) {
        const transportCause: AtCoderTransportCause = timedOut || !callerSignal?.aborted ? "timeout" : "consumer_cancelled";
        throw new AtCoderClientError(
          "network.timeout",
          transportCause === "timeout" ? "AtCoder did not respond before the request timeout." : "The AtCoder request was cancelled.",
          undefined,
          undefined,
          transportCause
        );
      }
      throw new AtCoderClientError(
        "upstream.unavailable",
        error instanceof Error ? `AtCoder request failed: ${error.message}` : "AtCoder request failed."
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

async function readUtf8Body(response: Response, maxResponseBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let consumed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        consumed = true;
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxResponseBytes) {
        throw new AtCoderClientError("upstream.unavailable", "AtCoder HTML exceeded the configured response size limit.", response.status);
      }
      chunks.push(value);
    }
  } finally {
    if (!consumed) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the transport or size error that interrupted body consumption.
      }
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AtCoderClientError("upstream.schema_changed", "AtCoder returned HTML that was not valid UTF-8.", response.status);
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body || response.body.locked) return;
  try {
    await response.body.cancel();
  } catch {
    // The mapped response error is more useful than a disposal failure.
  }
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } };
  return (
    candidate.name === "TimeoutError" ||
    candidate.name === "AbortError" ||
    candidate.code === "ETIMEDOUT" ||
    candidate.code === "UND_ERR_CONNECT_TIMEOUT" ||
    candidate.cause?.code === "ETIMEDOUT" ||
    candidate.cause?.code === "UND_ERR_CONNECT_TIMEOUT"
  );
}
