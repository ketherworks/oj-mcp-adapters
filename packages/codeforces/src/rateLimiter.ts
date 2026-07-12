import { abortable, BoundedAdmission } from "./admission.js";

export interface CodeforcesRateLimiterOptions {
  intervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  maxQueued?: number;
}

export class CodeforcesRateLimiter {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly admission: BoundedAdmission;
  private lastStartedAt?: number;

  constructor(options: CodeforcesRateLimiterOptions = {}) {
    this.intervalMs = options.intervalMs ?? 2_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.admission = new BoundedAdmission(1, options.maxQueued ?? 32, "Codeforces client rate limiter");
  }

  schedule<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.admission.run(signal, async () => {
      if (this.lastStartedAt !== undefined) {
        const remaining = this.intervalMs - (this.now() - this.lastStartedAt);
        if (remaining > 0) await abortable(this.sleep(remaining), signal);
      }
      this.lastStartedAt = this.now();
      return operation();
    });
  }
}
