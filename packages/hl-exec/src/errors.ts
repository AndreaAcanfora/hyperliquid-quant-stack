/**
 * Thrown by `closePosition` when the venue did not flatten the caller's
 * share: every IOC was rejected, returned nothing, or only partially
 * filled. Distinct from the `null` return, which means "nothing to
 * close" (stale local state) and is safe to clear. On this error the
 * position is STILL OPEN: keep tracking it (and its TP/SL) and retry.
 */
export class CloseFailedError extends Error {
  readonly filledSize: number;
  readonly remainingSize: number;
  constructor(message: string, filledSize: number, remainingSize: number) {
    super(message);
    this.name = 'CloseFailedError';
    this.filledSize = filledSize;
    this.remainingSize = remainingSize;
  }
}
