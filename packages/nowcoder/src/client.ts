import { Resolver } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { SecureContextOptions } from "node:tls";
import { MAX_RETRY_AFTER_MS, NowCoderAdapterError } from "./errors.js";
import { isChallengeHtml } from "./parser.js";
import { nowCoderSearchUrl } from "./search.js";
import { parseNowCoderProblemUrl } from "./url.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 2;
const MAX_SESSION_COOKIE_BYTES = 16 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface NowCoderHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface NowCoderRequestLimits {
  timeoutMs: number;
  maxBytes: number;
}

export interface NowCoderRequestContext extends NowCoderRequestLimits {
  signal: AbortSignal;
  sessionCookie?: string;
  method?: "GET" | "POST";
  body?: string;
  headers?: Readonly<Record<string, string>>;
}

export type NowCoderHttpRequester = (url: URL, context: NowCoderRequestContext) => Promise<NowCoderHttpResponse>;

export interface NowCoderResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type NowCoderHostResolver = (hostname: string, signal: AbortSignal) => Promise<NowCoderResolvedAddress[]>;

export interface NowCoderPinnedSocketRequest {
  url: URL;
  serverName: string;
  addresses: NowCoderResolvedAddress[];
  signal: AbortSignal;
  sessionCookie?: string;
  method?: "GET" | "POST";
  body?: string;
  headers?: Readonly<Record<string, string>>;
}

export interface NowCoderPinnedSocketResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}

export type NowCoderPinnedSocketOpener = (request: NowCoderPinnedSocketRequest) => Promise<NowCoderPinnedSocketResponse>;

interface ResolverLike {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  cancel(): void;
}

type NodeHttpsRequestOptions = HttpsRequestOptions & {
  autoSelectFamily?: boolean;
  autoSelectFamilyAttemptTimeout?: number;
};

type NodeHttpsRequest = (
  options: NodeHttpsRequestOptions,
  callback: (response: IncomingMessage) => void
) => ClientRequest;

/** Injection points for lower-transport tests; production uses all defaults. */
export interface NowCoderNodeHttpsSocketOptions {
  requestImpl?: NodeHttpsRequest;
  port?: number;
  ca?: SecureContextOptions["ca"];
  autoSelectFamilyAttemptTimeoutMs?: number;
}

export interface NowCoderPageClientOptions {
  requester?: NowCoderHttpRequester;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  sessionCookie?: string;
}

export interface NowCoderProblemPageResponse {
  html: string;
  url: string;
  etag?: string;
}

export interface NowCoderProblemListPageResponse {
  html: string;
  url: string;
}

export interface NowCoderProfilePageResponse {
  accountId: string;
  html: string;
  url: string;
}

export interface NowCoderSubmissionsPageResponse {
  accountId: string;
  html: string;
  url: string;
}

export interface NowCoderSessionStatus {
  configured: boolean;
  state: "not_configured" | "authenticated" | "expired" | "challenge" | "unknown";
}

export class NowCoderPageClient {
  private readonly requester: NowCoderHttpRequester;
  private readonly limits: NowCoderRequestLimits;
  private readonly maxRedirects: number;
  private readonly sessionCookie?: string;

  constructor(options: NowCoderPageClientOptions = {}) {
    this.requester = options.requester ?? createPinnedHttpsRequester();
    this.limits = {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES
    };
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.sessionCookie = options.sessionCookie === undefined
      ? undefined
      : validateSessionCookie(options.sessionCookie);
  }

  async getSessionStatus(options: { signal?: AbortSignal } = {}): Promise<NowCoderSessionStatus> {
    if (this.sessionCookie === undefined) return { configured: false, state: "not_configured" };
    const controller = new AbortController();
    const cancelFromCaller = () => {
      controller.abort(options.signal?.reason ?? new DOMException("NowCoder request cancelled.", "AbortError"));
    };
    if (options.signal?.aborted) cancelFromCaller();
    else options.signal?.addEventListener("abort", cancelFromCaller, { once: true });
    const deadline = setTimeout(() => {
      controller.abort(new DOMException("NowCoder request deadline exceeded.", "TimeoutError"));
    }, this.limits.timeoutMs);
    try {
      const response = await this.request(new URL("https://ac.nowcoder.com/"), controller.signal, options.signal);
      const responseStatus = validHttpStatus(response.status);
      if (responseStatus === undefined) {
        throw new NowCoderAdapterError("upstream.unavailable", "NowCoder returned an invalid HTTP status.");
      }
      if (Buffer.byteLength(response.body, "utf8") > this.limits.maxBytes) {
        throw new NowCoderAdapterError("upstream.unavailable", "NowCoder response exceeded the adapter's safe size limit.");
      }
      if (isChallengeHtml(response.body)) return { configured: true, state: "challenge" };
      if (responseStatus === 401 || responseStatus === 403) {
        return { configured: true, state: "expired" };
      }
      this.assertSuccessfulResponse({ ...response, status: responseStatus });
      const contentType = header(response.headers, "content-type") ?? "";
      if (!/^text\/html\b|^application\/xhtml\+xml\b/i.test(contentType)) {
        throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder returned a non-HTML session status response.");
      }
      if (/\bwindow\.isLogin\s*=\s*true\b/.test(response.body) && authenticatedOwnerId(response.body) !== undefined) {
        return { configured: true, state: "authenticated" };
      }
      if (/\bwindow\.isLogin\s*=\s*false\b/.test(response.body)) {
        return { configured: true, state: "expired" };
      }
      return { configured: true, state: "unknown" };
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", cancelFromCaller);
    }
  }

  hasSessionCookie(): boolean {
    return this.sessionCookie !== undefined;
  }

  async getProblemListPage(
    input: { query: string; page: number; limit: number },
    options: { signal?: AbortSignal } = {}
  ): Promise<NowCoderProblemListPageResponse> {
    const query = input.query.trim();
    if (
      query.length === 0
      || query.length > 300
      || !Number.isInteger(input.page)
      || input.page < 1
      || input.page > 10_000
      || !Number.isInteger(input.limit)
      || input.limit < 1
      || input.limit > 50
    ) {
      throw new NowCoderAdapterError("request.invalid", "Use a 1-300 character query, page 1-10000, and limit 1-50.");
    }
    const url = new URL(nowCoderSearchUrl(query, input.page, input.limit));
    const controller = new AbortController();
    const cancelFromCaller = () => {
      controller.abort(options.signal?.reason ?? new DOMException("NowCoder request cancelled.", "AbortError"));
    };
    if (options.signal?.aborted) cancelFromCaller();
    else options.signal?.addEventListener("abort", cancelFromCaller, { once: true });
    const deadline = setTimeout(() => {
      controller.abort(new DOMException("NowCoder request deadline exceeded.", "TimeoutError"));
    }, this.limits.timeoutMs);
    try {
      const response = await this.request(url, controller.signal, options.signal);
      const responseStatus = validHttpStatus(response.status);
      if (responseStatus === undefined) {
        throw new NowCoderAdapterError("upstream.unavailable", "NowCoder returned an invalid HTTP status.");
      }
      if (Buffer.byteLength(response.body, "utf8") > this.limits.maxBytes) {
        throw new NowCoderAdapterError("upstream.unavailable", "NowCoder response exceeded the adapter's safe size limit.");
      }
      if (isChallengeHtml(response.body)) {
        throw new NowCoderAdapterError(
          "challenge.required",
          "NowCoder returned an anti-bot challenge. Complete it in a browser, then retry.",
          { httpStatus: responseStatus }
        );
      }
      this.assertSuccessfulResponse({ ...response, status: responseStatus });
      const contentType = header(response.headers, "content-type") ?? "";
      if (!/^text\/html\b|^application\/xhtml\+xml\b/i.test(contentType)) {
        throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder returned a non-HTML problem-search response.");
      }
      return { html: response.body, url: url.href };
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", cancelFromCaller);
    }
  }

  async getProfilePage(
    accountId?: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<NowCoderProfilePageResponse> {
    if (accountId !== undefined && !/^[1-9]\d{0,11}$/.test(accountId)) {
      throw new NowCoderAdapterError("request.invalid", "NowCoder profile accountId must be a positive numeric ID.");
    }
    if (accountId === undefined && this.sessionCookie === undefined) {
      throw new NowCoderAdapterError("auth.required", "Configure a local NowCoder session or provide a public accountId.");
    }

    const controller = new AbortController();
    const cancelFromCaller = () => {
      controller.abort(options.signal?.reason ?? new DOMException("NowCoder request cancelled.", "AbortError"));
    };
    if (options.signal?.aborted) cancelFromCaller();
    else options.signal?.addEventListener("abort", cancelFromCaller, { once: true });
    const deadline = setTimeout(() => {
      controller.abort(new DOMException("NowCoder request deadline exceeded.", "TimeoutError"));
    }, this.limits.timeoutMs);
    try {
      let resolvedId = accountId;
      if (resolvedId === undefined) {
        const home = await this.request(new URL("https://ac.nowcoder.com/"), controller.signal, options.signal);
        this.assertHtmlResponse(home, "profile discovery");
        if (/\bwindow\.isLogin\s*=\s*false\b/.test(home.body)) {
          throw new NowCoderAdapterError("auth.invalid", "The configured NowCoder session has expired.");
        }
        resolvedId = authenticatedOwnerId(home.body);
        if (!resolvedId) {
          throw new NowCoderAdapterError("auth.invalid", "The configured NowCoder session did not expose a competition profile.");
        }
      }
      const url = new URL(`https://ac.nowcoder.com/acm/contest/profile/${resolvedId}`);
      const page = await this.request(url, controller.signal, options.signal);
      this.assertHtmlResponse(page, "profile");
      return { accountId: resolvedId, html: page.body, url: url.href };
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", cancelFromCaller);
    }
  }

  async getSubmissionsPage(
    input: { accountId?: string; page: number; limit: number; query?: string },
    options: { signal?: AbortSignal } = {}
  ): Promise<NowCoderSubmissionsPageResponse> {
    if (
      (input.accountId !== undefined && !/^[1-9]\d{0,11}$/.test(input.accountId))
      || !Number.isInteger(input.page) || input.page < 1 || input.page > 10_000
      || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50
      || (input.query?.length ?? 0) > 100
    ) {
      throw new NowCoderAdapterError("request.invalid", "Use a valid accountId, page 1-10000, limit 1-50, and query up to 100 characters.");
    }
    const controller = new AbortController();
    const cancelFromCaller = () => {
      controller.abort(options.signal?.reason ?? new DOMException("NowCoder request cancelled.", "AbortError"));
    };
    if (options.signal?.aborted) cancelFromCaller();
    else options.signal?.addEventListener("abort", cancelFromCaller, { once: true });
    const deadline = setTimeout(() => controller.abort(new DOMException("NowCoder request deadline exceeded.", "TimeoutError")), this.limits.timeoutMs);
    try {
      const accountId = await this.resolveProfileAccountId(input.accountId, controller.signal, options.signal);
      const url = new URL(`https://ac.nowcoder.com/acm/contest/profile/${accountId}/practice-coding`);
      url.searchParams.set("pageSize", String(input.limit));
      url.searchParams.set("search", input.query?.trim() ?? "");
      url.searchParams.set("statusTypeFilter", "-1");
      url.searchParams.set("languageCategoryFilter", "-1");
      url.searchParams.set("orderType", "DESC");
      url.searchParams.set("page", String(input.page));
      const page = await this.request(url, controller.signal, options.signal);
      this.assertHtmlResponse(page, "submission-history");
      return { accountId, html: page.body, url: url.href };
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", cancelFromCaller);
    }
  }

  async getProblemPage(inputUrl: string, options: { signal?: AbortSignal } = {}): Promise<NowCoderProblemPageResponse> {
    let page;
    try {
      page = parseNowCoderProblemUrl(inputUrl);
    } catch {
      throw new NowCoderAdapterError("request.invalid", "Use an allowlisted public ac.nowcoder.com ACM problem URL.");
    }

    const controller = new AbortController();
    const cancelFromCaller = () => {
      controller.abort(options.signal?.reason ?? new DOMException("NowCoder request cancelled.", "AbortError"));
    };
    if (options.signal?.aborted) cancelFromCaller();
    else options.signal?.addEventListener("abort", cancelFromCaller, { once: true });
    const deadline = setTimeout(() => {
      controller.abort(new DOMException("NowCoder request deadline exceeded.", "TimeoutError"));
    }, this.limits.timeoutMs);
    try {
      const visited = new Set<string>();
      for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
        const currentUrl = new URL(page.canonicalUrl);
        if (visited.has(currentUrl.href)) {
          throw new NowCoderAdapterError("upstream.unavailable", "NowCoder returned a redirect loop.");
        }
        visited.add(currentUrl.href);

        const response = await this.request(currentUrl, controller.signal, options.signal);
        const responseStatus = validHttpStatus(response.status);
        if (responseStatus === undefined) {
          throw new NowCoderAdapterError("upstream.unavailable", "NowCoder returned an invalid HTTP status.");
        }
        if (Buffer.byteLength(response.body, "utf8") > this.limits.maxBytes) {
          throw new NowCoderAdapterError("upstream.unavailable", "NowCoder response exceeded the adapter's safe size limit.");
        }
        if (isChallengeHtml(response.body)) {
          throw new NowCoderAdapterError(
            "challenge.required",
            "NowCoder returned an anti-bot challenge. This adapter does not use browser automation or attempt to bypass it.",
            { httpStatus: responseStatus }
          );
        }

        if (REDIRECT_STATUSES.has(responseStatus)) {
          if (redirects === this.maxRedirects) {
            throw new NowCoderAdapterError("upstream.unavailable", "NowCoder exceeded the adapter's redirect limit.");
          }
          const location = header(response.headers, "location");
          if (!location) {
            throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder returned a redirect without a Location header.");
          }
          try {
            page = parseNowCoderProblemUrl(new URL(location, currentUrl).href);
          } catch {
            throw new NowCoderAdapterError("policy.blocked", "NowCoder redirected outside the audited public problem allowlist.");
          }
          continue;
        }

        this.assertSuccessfulResponse({ ...response, status: responseStatus });
        const contentType = header(response.headers, "content-type") ?? "";
        if (!/^text\/html\b|^application\/xhtml\+xml\b/i.test(contentType)) {
          throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder returned a non-HTML problem response.");
        }
        return {
          html: response.body,
          url: currentUrl.href,
          ...(header(response.headers, "etag") ? { etag: header(response.headers, "etag") } : {})
        };
      }

      throw new NowCoderAdapterError("internal", "NowCoder redirect handling reached an invalid state.");
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", cancelFromCaller);
    }
  }

  async obtainJudgeAccessToken(options: { signal?: AbortSignal; teamId?: string } = {}): Promise<string> {
    const csrf = this.cookieValue("csrf_token");
    if (!csrf) throw new NowCoderAdapterError("auth.invalid", "The configured NowCoder session does not contain csrf_token.");
    if (options.teamId !== undefined && !/^[1-9]\d{0,15}$/.test(options.teamId)) {
      throw new NowCoderAdapterError("request.invalid", "NowCoder teamId must be a positive numeric ID.");
    }
    const url = new URL("https://gw-c.nowcoder.com/api/sparta/base-oauth/access-token");
    url.searchParams.set("sceneType", "2");
    url.searchParams.set("token", csrf);
    url.searchParams.set("lang", "zh-CN");
    if (options.teamId) url.searchParams.set("teamId", options.teamId);
    const response = await this.jsonAction(url, {
      method: "GET",
      headers: { Origin: "https://d.nowcoder.com", Referer: "https://d.nowcoder.com/" }
    }, options);
    const envelope = response as { success?: unknown; code?: unknown; data?: unknown };
    const data = envelope.data as { accessToken?: unknown } | null;
    if (envelope.success !== true || !data || typeof data.accessToken !== "string" || !data.accessToken.trim()) {
      throw new NowCoderAdapterError("auth.invalid", "NowCoder did not issue a judge access token for the configured session.");
    }
    return data.accessToken.replace(/^Bearer\s+/i, "").trim();
  }

  async submitJudge(payload: Record<string, unknown>, options: { signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    const response = await this.jsonAction(
      new URL("https://victorinox.nowcoder.com/api/service/judge/submit"),
      { method: "POST", body: JSON.stringify(payload) },
      options
    );
    return judgeEnvelopeData(response, "submission");
  }

  async getQuestionSupportLanguageIds(questionId: string, options: { signal?: AbortSignal } = {}): Promise<string[]> {
    if (!/^[1-9]\d*$/.test(questionId)) throw new NowCoderAdapterError("request.invalid", "NowCoder questionId must be a positive integer.");
    const url = new URL("https://questionbank.nowcoder.com/api/qmp/question/detail");
    url.searchParams.set("id", questionId);
    url.searchParams.set("version", "3");
    url.searchParams.set("sceneType", "3001");
    const response = await this.jsonAction(url, { method: "GET" }, options);
    const envelope = response as { code?: unknown; data?: unknown };
    const data = envelope.data as { codingInfo?: { supportLanguages?: unknown } } | undefined;
    if (envelope.code !== 0 || !Array.isArray(data?.codingInfo?.supportLanguages)) {
      throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder question metadata did not contain supported languages.");
    }
    const ids = data.codingInfo.supportLanguages
      .map((entry) => entry && typeof entry === "object" ? (entry as { langId?: unknown }).langId : undefined)
      .map((value) => typeof value === "number" || typeof value === "string" ? String(value) : "")
      .filter((value) => /^[1-9]\d*$/.test(value));
    if (ids.length === 0) throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder question metadata returned no supported languages.");
    return [...new Set(ids)];
  }

  async pollJudge(context: Record<string, unknown>, options: { signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    const url = new URL("https://victorinox.nowcoder.com/api/service/judge/submit-status");
    const blocked = new Set(["content", "selfInputData", "selfOutputData", "userInput", "expectedOutput", "userOutput", "stdout"]);
    for (const [key, value] of Object.entries(context)) {
      if (blocked.has(key) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
      if (typeof value === "string" && value.length > 4_096) continue;
      url.searchParams.set(key, String(value));
    }
    const response = await this.jsonAction(url, { method: "GET" }, options);
    return judgeEnvelopeData(response, "status");
  }

  private async request(
    url: URL,
    signal: AbortSignal,
    callerSignal?: AbortSignal,
    init: { method?: "GET" | "POST"; body?: string; headers?: Readonly<Record<string, string>> } = {}
  ): Promise<NowCoderHttpResponse> {
    try {
      const requestCookie = this.cookieForRequest(url);
      return await abortable(this.requester(url, {
        ...this.limits,
        signal,
        ...init,
        ...(requestCookie === undefined ? {} : { sessionCookie: requestCookie })
      }), signal);
    } catch (error) {
      if (callerSignal?.aborted) {
        throw callerSignal.reason ?? new DOMException("NowCoder request cancelled.", "AbortError");
      }
      if (error instanceof NowCoderAdapterError) throw error;
      if (isTimeoutError(error)) {
        throw new NowCoderAdapterError("network.timeout", "NowCoder public page request timed out.");
      }
      throw new NowCoderAdapterError("upstream.unavailable", "NowCoder public page request failed.");
    }
  }

  private assertSuccessfulResponse(response: NowCoderHttpResponse): void {
    if (response.status === 404) {
      throw new NowCoderAdapterError("resource.not_found", "NowCoder problem was not found.", { httpStatus: 404 });
    }
    if (response.status === 429) {
      throw new NowCoderAdapterError("rate_limited", "NowCoder rate limited the public page request.", {
        httpStatus: 429,
        retryAfterMs: retryAfterMilliseconds(response.headers)
      });
    }
    if (response.status === 401) {
      throw new NowCoderAdapterError("auth.required", "This NowCoder page unexpectedly requires authentication.", { httpStatus: 401 });
    }
    if (response.status === 403) {
      throw new NowCoderAdapterError("auth.forbidden", "NowCoder refused this page request.", { httpStatus: 403 });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new NowCoderAdapterError("upstream.unavailable", `NowCoder returned HTTP ${response.status}.`, {
        httpStatus: response.status
      });
    }
  }

  private async jsonAction(
    url: URL,
    init: { method: "GET" | "POST"; body?: string; headers?: Readonly<Record<string, string>> },
    options: { signal?: AbortSignal }
  ): Promise<unknown> {
    if (this.sessionCookie === undefined) throw new NowCoderAdapterError("auth.required", "Configure a local NowCoder session for judge operations.");
    const controller = new AbortController();
    const cancelFromCaller = () => controller.abort(options.signal?.reason ?? new DOMException("NowCoder request cancelled.", "AbortError"));
    if (options.signal?.aborted) cancelFromCaller();
    else options.signal?.addEventListener("abort", cancelFromCaller, { once: true });
    const deadline = setTimeout(() => controller.abort(new DOMException("NowCoder judge request deadline exceeded.", "TimeoutError")), this.limits.timeoutMs);
    try {
      const response = await this.request(url, controller.signal, options.signal, {
        ...init,
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Origin: "https://ac.nowcoder.com",
          Referer: "https://ac.nowcoder.com/",
          ...(init.method === "POST" ? { "Content-Type": "application/json" } : {}),
          ...init.headers
        }
      });
      const responseStatus = validHttpStatus(response.status);
      if (responseStatus === undefined) throw new NowCoderAdapterError("upstream.unavailable", "NowCoder judge service returned an invalid HTTP status.");
      if (Buffer.byteLength(response.body, "utf8") > this.limits.maxBytes) throw new NowCoderAdapterError("upstream.unavailable", "NowCoder judge response exceeded the safe size limit.");
      this.assertSuccessfulResponse({ ...response, status: responseStatus });
      const contentType = header(response.headers, "content-type") ?? "";
      if (!/^application\/json\b/i.test(contentType)) throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder judge service returned a non-JSON response.");
      try {
        return JSON.parse(response.body) as unknown;
      } catch {
        throw new NowCoderAdapterError("upstream.schema_changed", "NowCoder judge service returned malformed JSON.");
      }
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", cancelFromCaller);
    }
  }

  private cookieValue(name: string): string | undefined {
    for (const part of this.sessionCookie?.split(";") ?? []) {
      const separator = part.indexOf("=");
      if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
      const value = part.slice(separator + 1).trim();
      return value || undefined;
    }
    return undefined;
  }

  private cookieForRequest(url: URL): string | undefined {
    if (url.hostname === "ac.nowcoder.com") return this.sessionCookie;
    if (url.hostname !== "gw-c.nowcoder.com") return undefined;

    const selected: string[] = [];
    for (const part of this.sessionCookie?.split(";") ?? []) {
      const separator = part.indexOf("=");
      if (separator < 1) continue;
      const name = part.slice(0, separator).trim();
      if (name !== "csrf_token" && !name.startsWith("NOWCODER")) continue;
      selected.push(`${name}=${part.slice(separator + 1).trim()}`);
    }
    return selected.length === 0 ? undefined : selected.join("; ");
  }

  private assertHtmlResponse(response: NowCoderHttpResponse, label: string): void {
    const responseStatus = validHttpStatus(response.status);
    if (responseStatus === undefined) {
      throw new NowCoderAdapterError("upstream.unavailable", "NowCoder returned an invalid HTTP status.");
    }
    if (Buffer.byteLength(response.body, "utf8") > this.limits.maxBytes) {
      throw new NowCoderAdapterError("upstream.unavailable", "NowCoder response exceeded the adapter's safe size limit.");
    }
    if (isChallengeHtml(response.body)) {
      throw new NowCoderAdapterError("challenge.required", "NowCoder returned an anti-bot challenge. Complete it in a browser, then retry.");
    }
    this.assertSuccessfulResponse({ ...response, status: responseStatus });
    const contentType = header(response.headers, "content-type") ?? "";
    if (!/^text\/html\b|^application\/xhtml\+xml\b/i.test(contentType)) {
      throw new NowCoderAdapterError("upstream.schema_changed", `NowCoder returned a non-HTML ${label} response.`);
    }
  }

  private async resolveProfileAccountId(
    accountId: string | undefined,
    signal: AbortSignal,
    callerSignal?: AbortSignal
  ): Promise<string> {
    if (accountId !== undefined) return accountId;
    if (this.sessionCookie === undefined) {
      throw new NowCoderAdapterError("auth.required", "Configure a local NowCoder session or provide a public accountId.");
    }
    const home = await this.request(new URL("https://ac.nowcoder.com/"), signal, callerSignal);
    this.assertHtmlResponse(home, "profile discovery");
    if (/\bwindow\.isLogin\s*=\s*false\b/.test(home.body)) {
      throw new NowCoderAdapterError("auth.invalid", "The configured NowCoder session has expired.");
    }
    const resolvedId = authenticatedOwnerId(home.body);
    if (!resolvedId) {
      throw new NowCoderAdapterError("auth.invalid", "The configured NowCoder session did not expose a competition profile.");
    }
    return resolvedId;
  }
}

function authenticatedOwnerId(html: string): string | undefined {
  return /\bwindow\.globalInfo\.ownerId\s*=\s*["']([1-9]\d{0,11})["']/.exec(html)?.[1]
    ?? /\bownerId\s*:\s*["']([1-9]\d{0,11})["']/.exec(html)?.[1];
}

function judgeEnvelopeData(input: unknown, operation: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new NowCoderAdapterError("upstream.schema_changed", `NowCoder ${operation} response was not an object.`);
  }
  const envelope = input as Record<string, unknown>;
  if (envelope.code === 998 || envelope.code === 999) {
    throw new NowCoderAdapterError("auth.invalid", "The configured NowCoder session is no longer valid.");
  }
  if (envelope.code !== 0 || !envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) {
    throw new NowCoderAdapterError(
      operation === "submission" ? "submission.rejected" : "upstream.unavailable",
      `NowCoder ${operation} request was rejected.`
    );
  }
  return envelope.data as Record<string, unknown>;
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const value = ipv6ToBigInt(address);
  if (value === undefined) return false;

  if (isIpv6InCidr(value, "64:ff9b::", 96)) {
    return isPublicIpv4(ipv4FromNumber(Number(value & 0xffff_ffffn)));
  }
  if (isIpv6InCidr(value, "2002::", 16)) {
    return isPublicIpv4(ipv4FromNumber(Number((value >> 80n) & 0xffff_ffffn)));
  }
  if (!isIpv6InCidr(value, "2000::", 3)) return false;
  if (isIpv6InCidr(value, "2001::", 23)) return false;
  if (isIpv6InCidr(value, "2001:db8::", 32)) return false;
  if (isIpv6InCidr(value, "3fff::", 20)) return false;
  return true;
}

export function createSystemHostResolver(
  createResolver: () => ResolverLike = () => new Resolver()
): NowCoderHostResolver {
  return async (hostname, signal) => {
    if (signal.aborted) throw signal.reason ?? new DOMException("Request aborted.", "AbortError");
    const resolver = createResolver();
    const onAbort = () => resolver.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await abortable(Promise.allSettled([
        resolver.resolve4(hostname),
        resolver.resolve6(hostname)
      ]), signal);
      const addresses: NowCoderResolvedAddress[] = [];
      if (result[0].status === "fulfilled") {
        addresses.push(...result[0].value.map((address) => ({ address, family: 4 as const })));
      }
      if (result[1].status === "fulfilled") {
        addresses.push(...result[1].value.map((address) => ({ address, family: 6 as const })));
      }
      if (addresses.length === 0) {
        const failure = result.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
        throw failure?.reason ?? new Error("NowCoder hostname did not resolve.");
      }
      return addresses;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };
}

export function createPinnedHttpsRequester(options: {
  resolver?: NowCoderHostResolver;
  openSocket?: NowCoderPinnedSocketOpener;
} = {}): NowCoderHttpRequester {
  const resolver = options.resolver ?? createSystemHostResolver();
  const openSocket = options.openSocket ?? createNodeHttpsSocketOpener();
  return async (url, context) => {
    const resolved = await abortable(resolver(url.hostname, context.signal), context.signal);
    const addresses = deduplicateAddresses(resolved);
    if (addresses.length === 0) {
      throw new NowCoderAdapterError("upstream.unavailable", "NowCoder hostname did not resolve.");
    }
    if (addresses.some((entry) => isIP(entry.address) !== entry.family || !isPublicIpAddress(entry.address))) {
      throw new NowCoderAdapterError("policy.blocked", "NowCoder hostname resolved to a non-public address.");
    }

    return requestValidatedPinnedHttps(url, context, addresses, openSocket);
  };
}

/**
 * Lower transport boundary for validated URL/address tuples.
 * Production callers enter through createPinnedHttpsRequester, which enforces SSRF policy first.
 */
export async function requestValidatedPinnedHttps(
  url: URL,
  context: NowCoderRequestContext,
  addresses: NowCoderResolvedAddress[],
  openSocket: NowCoderPinnedSocketOpener = createNodeHttpsSocketOpener()
): Promise<NowCoderHttpResponse> {
  const socket = await abortable(openSocket({
    url,
    serverName: url.hostname,
    addresses,
    signal: context.signal,
    ...(context.sessionCookie === undefined ? {} : { sessionCookie: context.sessionCookie }),
    ...(context.method === undefined ? {} : { method: context.method }),
    ...(context.body === undefined ? {} : { body: context.body }),
    ...(context.headers === undefined ? {} : { headers: context.headers })
  }), context.signal);
  const iterator = socket.body[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const next = await abortable(iterator.next(), context.signal);
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      receivedBytes += chunk.byteLength;
      if (receivedBytes > context.maxBytes) {
        throw new NowCoderAdapterError(
          "upstream.unavailable",
          "NowCoder response exceeded the adapter's safe size limit."
        );
      }
      chunks.push(chunk);
    }
    return {
      status: socket.status,
      headers: socket.headers,
      body: Buffer.concat(chunks, receivedBytes).toString("utf8")
    };
  } finally {
    try {
      await iterator.return?.();
    } finally {
      socket.close();
    }
  }
}

export function createNodeHttpsSocketOpener(
  options: NowCoderNodeHttpsSocketOptions = {}
): NowCoderPinnedSocketOpener {
  const requestImpl = options.requestImpl ?? (httpsRequest as NodeHttpsRequest);
  return (socketRequest) => new Promise<NowCoderPinnedSocketResponse>((resolve, reject) => {
    const pinnedLookup = createPinnedLookup(socketRequest.addresses);
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      operation();
    };
    const request = requestImpl({
      protocol: "https:",
      hostname: socketRequest.url.hostname,
      port: options.port ?? 443,
      path: `${socketRequest.url.pathname}${socketRequest.url.search}`,
      method: socketRequest.method ?? "GET",
      servername: socketRequest.serverName,
      rejectUnauthorized: true,
      lookup: pinnedLookup,
      autoSelectFamily: socketRequest.addresses.length > 1,
      ...(options.autoSelectFamilyAttemptTimeoutMs === undefined
        ? {}
        : { autoSelectFamilyAttemptTimeout: options.autoSelectFamilyAttemptTimeoutMs }),
      ...(options.ca === undefined ? {} : { ca: options.ca }),
      signal: socketRequest.signal,
      agent: false,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Encoding": "identity",
        "Accept-Language": "zh-CN,zh;q=0.9",
        Connection: "close",
        "User-Agent": "oj-mcp-nowcoder/0.2.0 (+local-page-adapter)",
        ...(socketRequest.headers ?? {}),
        ...(socketRequest.body === undefined ? {} : { "Content-Length": String(Buffer.byteLength(socketRequest.body, "utf8")) }),
        ...(socketRequest.sessionCookie === undefined ? {} : { Cookie: socketRequest.sessionCookie })
      }
    }, (response) => finish(() => {
      let closed = false;
      resolve({
        status: response.statusCode ?? 0,
        headers: normalizeHeaders(response.headers),
        body: response,
        close: () => {
          if (closed) return;
          closed = true;
          response.destroy();
          request.destroy();
        }
      });
    }));
    request.on("error", (error) => finish(() => reject(error)));
    if (socketRequest.body !== undefined) request.write(socketRequest.body);
    request.end();
  });
}

function createPinnedLookup(addresses: NowCoderResolvedAddress[]): LookupFunction {
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options.all) callback(null, addresses.map((entry) => ({ ...entry })));
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  }) as LookupFunction;
}

function deduplicateAddresses(addresses: NowCoderResolvedAddress[]): NowCoderResolvedAddress[] {
  const seen = new Set<string>();
  return addresses.filter((entry) => {
    const key = `${entry.family}:${entry.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const value = (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
  const blocked: Array<[number, number]> = [
    [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],
    [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24], [0xc01fc400, 24], [0xc034c100, 24],
    [0xc0586300, 24], [0xc0a80000, 16], [0xc0af3000, 24], [0xc6120000, 15], [0xc6336400, 24],
    [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4]
  ];
  return !blocked.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (network & mask);
  });
}

function ipv6ToBigInt(address: string): bigint | undefined {
  const withoutZone = address.toLowerCase().split("%", 1)[0];
  let normalized: string;
  try {
    const hostname = new URL(`http://[${withoutZone}]/`).hostname;
    normalized = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  } catch {
    return undefined;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  const words = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return undefined;
  return words.reduce((value, word) => (value << 16n) | BigInt(Number.parseInt(word, 16)), 0n);
}

function isIpv6InCidr(value: bigint, network: string, prefix: number): boolean {
  const networkValue = ipv6ToBigInt(network);
  if (networkValue === undefined) return false;
  const shift = BigInt(128 - prefix);
  return value >> shift === networkValue >> shift;
}

function ipv4FromNumber(value: number): string {
  return [24, 16, 8, 0].map((shift) => String((value >>> shift) & 0xff)).join(".");
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) normalized[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return normalized;
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return entry?.[1];
}

function retryAfterMilliseconds(headers: Record<string, string>): number | undefined {
  const value = header(headers, "retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, timestamp - Date.now())) : undefined;
}

function validHttpStatus(status: number): number | undefined {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function validateSessionCookie(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || Buffer.byteLength(normalized, "utf8") > MAX_SESSION_COOKIE_BYTES
    || /[^\x20-\x7e]/.test(normalized)
  ) {
    throw new TypeError("NowCoder session cookie is invalid.");
  }
  return normalized;
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } };
  return candidate.name === "AbortError" || candidate.name === "TimeoutError" || candidate.code === "ETIMEDOUT"
    || candidate.code === "UND_ERR_CONNECT_TIMEOUT" || candidate.cause?.code === "ETIMEDOUT";
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Request aborted.", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason ?? new DOMException("Request aborted.", "AbortError")));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}
