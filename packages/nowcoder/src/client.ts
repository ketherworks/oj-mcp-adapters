import { Resolver } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { SecureContextOptions } from "node:tls";
import { MAX_RETRY_AFTER_MS, NowCoderAdapterError } from "./errors.js";
import { isChallengeHtml } from "./parser.js";
import { parseNowCoderProblemUrl } from "./url.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 2;
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
}

export interface NowCoderProblemPageResponse {
  html: string;
  url: string;
  etag?: string;
}

export class NowCoderPageClient {
  private readonly requester: NowCoderHttpRequester;
  private readonly limits: NowCoderRequestLimits;
  private readonly maxRedirects: number;

  constructor(options: NowCoderPageClientOptions = {}) {
    this.requester = options.requester ?? createPinnedHttpsRequester();
    this.limits = {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES
    };
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
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
            "NowCoder returned an anti-bot challenge. This adapter does not use cookies or a browser to bypass it.",
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

  private async request(url: URL, signal: AbortSignal, callerSignal?: AbortSignal): Promise<NowCoderHttpResponse> {
    try {
      return await abortable(this.requester(url, { ...this.limits, signal }), signal);
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
      throw new NowCoderAdapterError("auth.forbidden", "NowCoder refused this anonymous public page request.", { httpStatus: 403 });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new NowCoderAdapterError("upstream.unavailable", `NowCoder returned HTTP ${response.status}.`, {
        httpStatus: response.status
      });
    }
  }
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
    signal: context.signal
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
      method: "GET",
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
        "User-Agent": "oj-mcp-nowcoder/0.1.0 (+anonymous-public-page-adapter)"
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
