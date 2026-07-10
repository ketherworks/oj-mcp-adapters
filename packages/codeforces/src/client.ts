import type { OjErrorCode } from "@kaiserunix/oj-mcp-contracts";
import { z } from "zod";
import { CodeforcesRateLimiter } from "./rateLimiter.js";

const codeforcesProblemSchema = z
  .object({
    contestId: z.number().int(),
    index: z.string().min(1),
    name: z.string().min(1),
    type: z.string().min(1),
    points: z.number().optional(),
    rating: z.number().int().optional(),
    tags: z.array(z.string())
  })
  .passthrough();

const codeforcesProblemStatisticsSchema = z
  .object({
    contestId: z.number().int(),
    index: z.string().min(1),
    solvedCount: z.number().int().nonnegative()
  })
  .passthrough();

const problemsetResponseSchema = z
  .object({
    status: z.literal("OK"),
    result: z
      .object({
        problems: z.array(codeforcesProblemSchema),
        problemStatistics: z.array(codeforcesProblemStatisticsSchema)
      })
      .passthrough()
  })
  .passthrough();

export type CodeforcesProblemsetResponse = z.infer<typeof problemsetResponseSchema>;

export interface CodeforcesApiClientOptions {
  fetchImpl?: typeof fetch;
  limiter?: CodeforcesRateLimiter;
  baseUrl?: string;
}

export class CodeforcesApiError extends Error {
  constructor(
    readonly code: OjErrorCode,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "CodeforcesApiError";
  }
}

export class CodeforcesApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: CodeforcesRateLimiter;
  private readonly baseUrl: string;

  constructor(options: CodeforcesApiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.limiter = options.limiter ?? new CodeforcesRateLimiter();
    this.baseUrl = options.baseUrl ?? "https://codeforces.com/api";
  }

  getProblemset(): Promise<CodeforcesProblemsetResponse> {
    return this.limiter.schedule(async () => {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/problemset.problems`, {
          headers: { Accept: "application/json", "User-Agent": "oj-mcp-codeforces/0.1.0" }
        });
      } catch (error) {
        throw new CodeforcesApiError("network.timeout", error instanceof Error ? error.message : String(error));
      }

      if (response.status === 429) {
        throw new CodeforcesApiError("rate_limited", "Codeforces API rate limit exceeded.", retryAfterMilliseconds(response));
      }
      if (!response.ok) {
        throw new CodeforcesApiError("upstream.unavailable", `Codeforces API returned HTTP ${response.status}.`);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new CodeforcesApiError("upstream.schema_changed", "Codeforces API returned invalid JSON.");
      }
      if (isFailedResponse(payload)) {
        const rateLimited = /call limit exceeded/i.test(payload.comment ?? "");
        throw new CodeforcesApiError(
          rateLimited ? "rate_limited" : "upstream.unavailable",
          payload.comment || "Codeforces API returned status FAILED.",
          rateLimited ? 2_000 : undefined
        );
      }

      const parsed = problemsetResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new CodeforcesApiError("upstream.schema_changed", "Codeforces problemset response no longer matches the audited schema.");
      }
      return parsed.data;
    });
  }
}

function isFailedResponse(value: unknown): value is { status: "FAILED"; comment?: string } {
  return Boolean(value && typeof value === "object" && "status" in value && value.status === "FAILED");
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}
