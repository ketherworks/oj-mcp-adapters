export class CodeforcesQueueFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeforcesQueueFullError";
  }
}

interface Waiter {
  signal?: AbortSignal;
  resolve: () => void;
  reject: (reason: unknown) => void;
  onAbort?: () => void;
}

export class BoundedAdmission {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly limit: number,
    private readonly maxQueued: number,
    private readonly queueName: string
  ) {
    assertPositiveInteger(limit, "concurrency limit");
    assertNonNegativeInteger(maxQueued, "queue limit");
  }

  async run<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try {
      throwIfAborted(signal);
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> | void {
    throwIfAborted(signal);
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    if (this.waiters.length >= this.maxQueued) {
      throw new CodeforcesQueueFullError(`${this.queueName} queue is full.`);
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { signal, resolve, reject };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
      next.resolve();
      return;
    }
    this.active -= 1;
  }
}

export function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer.`);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer.`);
}
