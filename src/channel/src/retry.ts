import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";

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
