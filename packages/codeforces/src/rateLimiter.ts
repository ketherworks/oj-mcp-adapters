export interface CodeforcesRateLimiterOptions {
  intervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class CodeforcesRateLimiter {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private tail: Promise<void> = Promise.resolve();
  private lastStartedAt?: number;

  constructor(options: CodeforcesRateLimiterOptions = {}) {
    this.intervalMs = options.intervalMs ?? 2_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  schedule<T>(operation: () => Promise<T>): Promise<T> {
    const scheduled = this.tail.then(async () => {
      if (this.lastStartedAt !== undefined) {
        const remaining = this.intervalMs - (this.now() - this.lastStartedAt);
        if (remaining > 0) {
          await this.sleep(remaining);
        }
      }
      this.lastStartedAt = this.now();
      return operation();
    });
    this.tail = scheduled.then(
      () => undefined,
      () => undefined
    );
    return scheduled;
  }
}
