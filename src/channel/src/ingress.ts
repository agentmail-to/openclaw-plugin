import { type AgentMailLog, errorText } from "./log.js";
import type { createAgentMailDurableInboundReceiveJournal } from "./durable-receive.js";
import { AgentMailIngressCapacityError, createAgentMailDurableInboundId } from "./durable-receive.js";
import { HYDRATION_NOT_FOUND_RETRY_WINDOW_MS } from "./inbound.js";
import { createBackoff, waitForRetry } from "./retry.js";
import type { AgentMailIngressRecord } from "./types.js";

// Re-exported for transports (websocket) that catch capacity backpressure by class.
export { AgentMailIngressCapacityError };

type AgentMailJournal = ReturnType<typeof createAgentMailDurableInboundReceiveJournal>;

type DispatchParams = {
  journal: AgentMailJournal;
  id: string;
  record: AgentMailIngressRecord;
  dispatch: AgentMailIngressDispatch;
  abortSignal?: AbortSignal;
  retryDelay?: (attempt: number) => number;
  initialAttempts: number;
  dispatchCompleted?: boolean;
  log?: AgentMailLog;
};

export type AgentMailIngressDispatch = (
  record: AgentMailIngressRecord,
  lifecycle: { onTurnAdopted: () => Promise<void>; abortSignal?: AbortSignal },
) => Promise<void>;

// Ceiling on pre-adoption dispatch attempts for a single message. A deterministically failing
// (poison) message would otherwise retry until its ~30-day TTL, and ~450 such rows would fill the
// pending queue and reject all new mail. On exhaustion the row is dropped (completed) so it stops
// occupying an admission slot. The journal exposes no distinct `fail` op, so completion is the
// terminal marker. Comfortably above the legitimate transient-retry budget the tests exercise.
const AGENTMAIL_MAX_DISPATCH_ATTEMPTS = 50;

type ActiveDispatch = {
  task: Promise<boolean>;
  successor?: DispatchParams;
};

// Durable ids include account + inbox + message, so this also coordinates overlapping account
// restarts that open separate journal facades over the same shared queue.
const activeDispatches = new Map<string, ActiveDispatch>();

const retryDelayMs = createBackoff(30 * 60_000);

// True when a dispatch failure is a provider-projection race: either a 404 (message not yet
// REST-visible) or a not-yet-projected `received` label. Both resolve on their own within seconds.
function isHydrationRetryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return (
    (error as { statusCode?: unknown }).statusCode === 404 ||
    (error as { hydrationPending?: unknown }).hydrationPending === true
  );
}

// A projection-race dispatch failure keeps its retries inside the bounded hydration window (measured
// from local arrival) so exponential backoff never schedules the next attempt past the deadline and
// silently drops recoverable mail. Other failures keep the full backoff for genuine outages.
function nextDispatchDelayMs(params: {
  error: unknown;
  record: AgentMailIngressRecord;
  attempts: number;
  retryDelay: (attempt: number) => number;
  now?: () => number;
}): number {
  const base = params.retryDelay(params.attempts);
  if (!isHydrationRetryable(params.error)) {
    return base;
  }
  const deadline =
    (params.record.arrivedAt ?? params.record.receivedAt) + HYDRATION_NOT_FOUND_RETRY_WINDOW_MS;
  const remaining = deadline - (params.now?.() ?? Date.now());
  if (remaining <= 0) {
    // Past the hydration deadline the 404 is no longer a projection race (e.g. a persistently
    // missing attachment). Fall back to the full backoff instead of collapsing to a zero-delay loop
    // that would hammer the provider until the poison-drop ceiling.
    return base;
  }
  return Math.min(base, remaining);
}

export async function processAgentMailIngress(params: {
  journal: AgentMailJournal;
  record: AgentMailIngressRecord;
  dispatch: AgentMailIngressDispatch;
  abortSignal?: AbortSignal;
  retryDelayMs?: (attempt: number) => number;
  log?: AgentMailLog;
}): Promise<"accepted" | "duplicate"> {
  const id = createAgentMailDurableInboundId(params.record);
  // accept() throws AgentMailIngressCapacityError directly when durable ingress is full, so
  // transports can apply plugin-owned backpressure (reject new mail, keep accepted pending mail).
  const accepted = await params.journal.accept(id, params.record, {
    receivedAt: params.record.receivedAt,
  });
  // "completed" is a durable dedupe hit. "failed" is a terminal tombstone in SDK releases that
  // expose one; compare as a string so the defensive branch also compiles where the accept-result
  // union omits it. Either way the message is already settled and must not dispatch again.
  const acceptedKind: string = accepted.kind;
  if (acceptedKind === "completed" || acceptedKind === "failed") {
    return "duplicate";
  }
  const record = accepted.kind === "pending" ? accepted.record.payload : params.record;
  // Pending duplicates also register as successors. This closes the account-reload race where a
  // replacement replay ran just before the old account admitted its final live event.
  scheduleAgentMailIngressDispatch({
    journal: params.journal,
    id,
    record,
    dispatch: params.dispatch,
    abortSignal: params.abortSignal,
    retryDelay: params.retryDelayMs,
    initialAttempts: accepted.kind === "pending" ? accepted.record.attempts : 0,
    log: params.log,
  });
  return "accepted";
}

function scheduleAgentMailIngressDispatch(params: DispatchParams): void {
  const existing = activeDispatches.get(params.id);
  if (existing) {
    // If the current owner shuts down before settling the row, its replacement resumes it.
    existing.successor = params;
    return;
  }
  const active: ActiveDispatch = {
    task: dispatchAgentMailIngressUntilSettled(params),
  };
  activeDispatches.set(params.id, active);
  const finish = (completed: boolean) => {
    if (activeDispatches.get(params.id) !== active) {
      return;
    }
    activeDispatches.delete(params.id);
    if (!completed && active.successor && !active.successor.abortSignal?.aborted) {
      // Completion-marker retries must never repeat an agent turn that already finished.
      active.successor.dispatchCompleted ||= params.dispatchCompleted;
      scheduleAgentMailIngressDispatch(active.successor);
    }
  };
  void active.task.then(finish, () => finish(false));
}

async function dispatchAgentMailIngressUntilSettled(params: DispatchParams): Promise<boolean> {
  let attempts = params.initialAttempts;
  while (!params.abortSignal?.aborted) {
    if (!params.dispatchCompleted) {
      let turnAdopted = false;
      const onTurnAdopted = async () => {
        if (turnAdopted) {
          return;
        }
        // Core persists restart-recovery delivery state before this callback. A fresh turn does
        // not begin if it rejects; an already-committed active steer falls through to the
        // marker-only retry below. Completing here closes the normal crash window before tools.
        await params.journal.complete(params.id);
        turnAdopted = true;
        params.dispatchCompleted = true;
      };
      try {
        await params.dispatch(params.record, { onTurnAdopted, abortSignal: params.abortSignal });
        if (turnAdopted) {
          return true;
        }
        params.dispatchCompleted = true;
      } catch (error) {
        if (turnAdopted) {
          // The adopted turn is now owned by core's restart-recovery machinery. Releasing the
          // ingress row would replay agent tools even if the later turn failed.
          return true;
        }
        attempts += 1;
        if (attempts >= AGENTMAIL_MAX_DISPATCH_ATTEMPTS) {
          // Poison message: it has failed deterministically past the retry ceiling. Drop it
          // (complete removes it from the pending set) so it stops occupying an admission slot and
          // blocking new mail. Surface it so an operator can investigate the underlying failure.
          params.log?.error?.(
            `AgentMail dropping message ${params.record.messageId} after ${attempts} failed dispatch attempts: ${errorText(error)}`,
          );
          try {
            await params.journal.complete(params.id);
          } catch {
            // Best effort: TTL pruning still reclaims the row if the terminal marker cannot persist.
          }
          return true;
        }
        const lastError = errorText(error);
        while (!params.abortSignal?.aborted) {
          try {
            const released = await params.journal.release(params.id, { lastError });
            if (!released) {
              // A concurrent completion or retention prune means this worker no longer owns a
              // pending row. Redispatching without ownership could duplicate an adopted turn.
              return true;
            }
            break;
          } catch {
            if (
              !(await waitForRetry(
                params.abortSignal,
                (params.retryDelay ?? retryDelayMs)(attempts),
              ))
            ) {
              return false;
            }
          }
        }
        if (params.abortSignal?.aborted) {
          return false;
        }
        const shouldRetry = await waitForRetry(
          params.abortSignal,
          nextDispatchDelayMs({
            error,
            record: params.record,
            attempts,
            retryDelay: params.retryDelay ?? retryDelayMs,
          }),
        );
        if (!shouldRetry) {
          return false;
        }
        continue;
      }
    }
    try {
      await params.journal.complete(params.id);
      return true;
    } catch {
      attempts += 1;
      // Dispatch already produced the agent turn. Keep the row pending and retry only the
      // idempotent completion marker; releasing and redispatching would duplicate the reply.
      const shouldRetry = await waitForRetry(
        params.abortSignal,
        (params.retryDelay ?? retryDelayMs)(attempts),
      );
      if (!shouldRetry) {
        return false;
      }
    }
  }
  return false;
}

export async function replayPendingAgentMailIngress(params: {
  journal: AgentMailJournal;
  dispatch: AgentMailIngressDispatch;
  abortSignal?: AbortSignal;
  retryDelayMs?: (attempt: number) => number;
  log?: AgentMailLog;
}): Promise<void> {
  for (const pending of await params.journal.pending()) {
    if (params.abortSignal?.aborted) {
      return;
    }
    // Revalidate through accept() before scheduling. During overlapping restarts a row can be
    // completed (or terminally failed) by another worker after this pending() snapshot was taken;
    // scheduling it blindly would run a second agent turn and send a duplicate reply.
    let accepted: Awaited<ReturnType<AgentMailJournal["accept"]>>;
    try {
      accepted = await params.journal.accept(pending.id, pending.payload, {
        receivedAt: pending.payload.receivedAt,
      });
    } catch (error) {
      if (error instanceof AgentMailIngressCapacityError) {
        // The queue is already at capacity with other pending rows; nothing new to replay here.
        continue;
      }
      throw error;
    }
    const acceptedKind: string = accepted.kind;
    if (acceptedKind === "completed" || acceptedKind === "failed") {
      continue;
    }
    scheduleAgentMailIngressDispatch({
      journal: params.journal,
      id: pending.id,
      record: accepted.kind === "pending" ? accepted.record.payload : pending.payload,
      dispatch: params.dispatch,
      abortSignal: params.abortSignal,
      retryDelay: params.retryDelayMs,
      initialAttempts: accepted.kind === "pending" ? accepted.record.attempts : pending.attempts,
      log: params.log,
    });
  }
}
