import { describe, expect, test } from "vitest";
import { CodeforcesProvider } from "../src/provider.js";
import type { CodeforcesApiClient, CodeforcesProblemsetResponse } from "../src/client.js";

describe("CodeforcesProvider health", () => {
  test("reports the capability transport supplied by the hosting entrypoint", async () => {
    const provider = new CodeforcesProvider({ nowIso: () => "2026-07-10T12:00:00.000Z" });

    for (const transport of ["local_stdio", "remote_http"] as const) {
      const capabilities = await provider.getCapabilities(transport);
      expect(Object.values(capabilities.operations).every((operation) => operation.transport === transport)).toBe(true);
    }
  });

  test("maps persisted timeout, rate-limit, drift, and recovery observations", async () => {
    const cases = [
      {
        observation: { checkedAt: "2026-07-10T12:00:00.000Z", code: "network.timeout" as const },
        expected: { overall: "unavailable", layers: { transport: "fail", schema: "unknown", upstream: "timeout" } }
      },
      {
        observation: { checkedAt: "2026-07-10T12:00:00.000Z", code: "rate_limited" as const, retryAfterMs: 2000 },
        expected: { overall: "degraded", layers: { transport: "pass", schema: "unknown", upstream: "rate_limited" } }
      },
      {
        observation: { checkedAt: "2026-07-10T12:00:00.000Z", code: "upstream.schema_changed" as const },
        expected: { overall: "degraded", layers: { transport: "pass", schema: "drift", upstream: "fail" } }
      },
      {
        observation: { checkedAt: "2026-07-10T12:00:00.000Z" },
        expected: { overall: "healthy", layers: { transport: "pass", schema: "pass", upstream: "pass" } }
      }
    ];

    for (const testCase of cases) {
      const provider = new CodeforcesProvider({
        healthReader: async () => testCase.observation,
        nowIso: () => "2026-07-10T12:01:00.000Z"
      });
      await expect(provider.getHealth()).resolves.toMatchObject(testCase.expected);
    }
  });

  test("keeps the shared load alive when its first caller cancels", async () => {
    let resolveLoad!: (payload: CodeforcesProblemsetResponse) => void;
    let receivedSignal: AbortSignal | undefined;
    const load = new Promise<CodeforcesProblemsetResponse>((resolve) => {
      resolveLoad = resolve;
    });
    const client = {
      getProblemset: (options: { signal?: AbortSignal } = {}) => {
        receivedSignal = options.signal;
        return load;
      }
    } as CodeforcesApiClient;
    const provider = new CodeforcesProvider({ client, maxConcurrentWaiters: 2, maxQueuedWaiters: 2 });
    const ownerController = new AbortController();
    const owner = provider.search(searchRequest("owner"), { signal: ownerController.signal });
    const joiner = provider.search(searchRequest("joiner"));
    await Promise.resolve();

    ownerController.abort();
    await expect(owner).rejects.toMatchObject({ name: "CodeforcesRequestCancelledError" });
    expect(receivedSignal).toBeUndefined();
    resolveLoad(problemsetPayload());
    await expect(joiner).resolves.toMatchObject({ requestId: "joiner" });
  });

  test("cancels one queued joiner without affecting the owner and bounds all other joiners", async () => {
    let resolveLoad!: (payload: CodeforcesProblemsetResponse) => void;
    const load = new Promise<CodeforcesProblemsetResponse>((resolve) => {
      resolveLoad = resolve;
    });
    let calls = 0;
    const client = {
      getProblemset: () => {
        calls += 1;
        return load;
      }
    } as unknown as CodeforcesApiClient;
    const provider = new CodeforcesProvider({ client, maxConcurrentWaiters: 1, maxQueuedWaiters: 1 });
    const owner = provider.search(searchRequest("owner"));
    const joinerController = new AbortController();
    const joiner = provider.search(searchRequest("cancelled-joiner"), { signal: joinerController.signal });

    await expect(provider.search(searchRequest("overflow"))).rejects.toMatchObject({ code: "rate_limited" });
    joinerController.abort();
    await expect(joiner).rejects.toMatchObject({ name: "CodeforcesRequestCancelledError" });
    resolveLoad(problemsetPayload());
    await expect(owner).resolves.toMatchObject({ requestId: "owner" });
    expect(calls).toBe(1);
  });
});

function searchRequest(requestId: string) {
  return {
    schemaVersion: "oj.search-request/v1" as const,
    requestId,
    platform: "codeforces" as const,
    query: "watermelon",
    limit: 10
  };
}

function problemsetPayload(): CodeforcesProblemsetResponse {
  return {
    status: "OK",
    result: {
      problems: [{ contestId: 4, index: "A", name: "Watermelon", type: "PROGRAMMING", tags: [] }],
      problemStatistics: [{ contestId: 4, index: "A", solvedCount: 1 }]
    }
  };
}
