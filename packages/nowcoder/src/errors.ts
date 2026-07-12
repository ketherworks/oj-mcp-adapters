import type { OjErrorCode } from "@kaiserunix/oj-mcp-contracts";

export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

export interface NowCoderErrorMetadata {
  httpStatus?: number;
  retryAfterMs?: number;
}

export class NowCoderAdapterError extends Error {
  readonly options: NowCoderErrorMetadata;

  constructor(
    readonly code: OjErrorCode,
    message: string,
    options: NowCoderErrorMetadata = {}
  ) {
    super(message);
    this.name = "NowCoderAdapterError";
    this.options = Object.freeze({
      ...(Number.isInteger(options.httpStatus) && options.httpStatus! >= 100 && options.httpStatus! <= 599
        ? { httpStatus: options.httpStatus }
        : {}),
      ...(Number.isFinite(options.retryAfterMs) && options.retryAfterMs! >= 0
        ? { retryAfterMs: Math.min(options.retryAfterMs!, MAX_RETRY_AFTER_MS) }
        : {})
    });
  }
}
