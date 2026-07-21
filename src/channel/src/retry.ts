import { computeBackoff, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";

/**
 * Exponential backoff with jitter, bounded by `maxMs`. The three transports share the same shape
 * (1s initial, ×2, 20% jitter) and differ only in the ceiling.
 */
export function createBackoff(maxMs: number): (attempt: number) => number {
  return (attempt) => computeBackoff({ initialMs: 1_000, maxMs, factor: 2, jitter: 0.2 }, attempt);
}

/**
 * Sleeps for `delayMs`, resolving to `true` if the wait completed and `false` if the signal was
 * (or became) aborted. Shared by the durable ingress, WebSocket, and REST catch-up retry loops.
 */
export async function waitForRetry(
  signal: AbortSignal | undefined,
  delayMs: number,
): Promise<boolean> {
  try {
    await sleepWithAbort(delayMs, signal);
    return !signal?.aborted;
  } catch {
    return false;
  }
}
