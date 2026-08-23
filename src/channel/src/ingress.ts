import { type AgentMailLog, errorText } from "./log.js";
import type { createAgentMailDurableInboundReceiveJournal } from "./durable-receive.js";
import { AgentMailIngressCapacityError, createAgentMailDurableInboundId } from "./durable-receive.js";
import { HYDRATION_NOT_FOUND_RETRY_WINDOW_MS } from "./inbound.js";
import {
  capAgentMailProviderTimestampForRetention,
  isValidAgentMailTimestampMs,
} from "./received-message.js";
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
  lifecycle: {
    onTurnAdopted: () => Promise<void>;
    onTurnDeferred: () => void;
    onTurnAbandoned: () => Promise<void>;
    abortSignal?: AbortSignal;
  },
) => Promise<void>;

// Ceiling on pre-adoption dispatch attempts for a single message. A deterministically failing
// (poison) message would otherwise retry until its ~30-day TTL, and ~450 such rows would fill the
// pending queue and reject all new mail. On exhaustion the row receives a terminal marker so it
// stops occupying an admission slot. Comfortably above the legitimate transient-retry budget the
// tests exercise.
const AGENTMAIL_MAX_DISPATCH_ATTEMPTS = 50;
const AGENTMAIL_MAX_COMPLETION_ATTEMPTS = 50;
const AGENTMAIL_MAX_RELEASE_ATTEMPTS = 50;

type DeferredOutcome = "adopted" | "abandoned" | "completion-failed" | "aborted";

async function waitForDeferredOutcome(
  outcome: Promise<Exclude<DeferredOutcome, "aborted">>,
  abortSignal?: AbortSignal,
): Promise<DeferredOutcome> {
  if (!abortSignal) {
    return await outcome;
  }
  if (abortSignal.aborted) {
    return "aborted";
  }
  return await new Promise<DeferredOutcome>((resolve) => {
    const onAbort = () => resolve("aborted");
    abortSignal.addEventListener("abort", onAbort, { once: true });
    void outcome.then((value) => {
      abortSignal.removeEventListener("abort", onAbort);
      resolve(value);
    });
  });
}

type ActiveDispatch = {
  task: Promise<boolean>;
  successor?: DispatchParams;
};

// Durable ids include account + inbox + message, so this also coordinates overlapping account
// restarts that open separate journal facades over the same shared queue.
const activeDispatches = new Map<string, ActiveDispatch>();

const retryDelayMs = createBackoff(30 * 60_000);

async function completeAgentMailIngress(params: {
  journal: AgentMailJournal;
  id: string;
}): Promise<void> {
  // Terminal timestamps describe local state transitions. Retention includes the supported
  // provider-skew allowance, so sender-authored dates never distort tombstone ordering or expiry.
  await params.journal.complete(params.id, {
    completedAt: Date.now(),
  });
}

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

async function releaseAgentMailIngressWithRetry(params: {
  journal: AgentMailJournal;
  id: string;
  record: AgentMailIngressRecord;
  lastError: string;
  abortSignal?: AbortSignal;
  retryDelay: (attempt: number) => number;
  log?: AgentMailLog;
}): Promise<"released" | "gone" | "aborted" | "exhausted"> {
  let attempts = 0;
  while (!params.abortSignal?.aborted) {
    try {
      return (await params.journal.release(params.id, { lastError: params.lastError }))
        ? "released"
        : "gone";
    } catch (error) {
      attempts += 1;
      if (attempts >= AGENTMAIL_MAX_RELEASE_ATTEMPTS) {
        params.log?.error?.(
          `AgentMail could not release message ${params.record.messageId} after ${attempts} attempts: ${errorText(error)}`,
        );
        return "exhausted";
      }
      if (!(await waitForRetry(params.abortSignal, params.retryDelay(attempts)))) {
        return "aborted";
      }
    }
  }
  return "aborted";
}

export async function processAgentMailIngress(params: {
  journal: AgentMailJournal;
  record: AgentMailIngressRecord;
  dispatch: AgentMailIngressDispatch;
  abortSignal?: AbortSignal;
  retryDelayMs?: (attempt: number) => number;
  log?: AgentMailLog;
}): Promise<"accepted" | "duplicate"> {
  // Enforce the retention invariant at the shared durable boundary as well as transport parsing.
  // This protects future transports and direct callers from persisting an unbounded timestamp.
  const arrivedAt = isValidAgentMailTimestampMs(params.record.arrivedAt)
    ? params.record.arrivedAt
    : Date.now();
  const record = {
    ...params.record,
    arrivedAt,
    receivedAt: capAgentMailProviderTimestampForRetention(
      isValidAgentMailTimestampMs(params.record.receivedAt)
        ? params.record.receivedAt
        : arrivedAt,
      arrivedAt,
    ),
  };
  const id = createAgentMailDurableInboundId(record);
  // accept() throws AgentMailIngressCapacityError directly when durable ingress is full, so
  // transports can apply plugin-owned backpressure (reject new mail, keep accepted pending mail).
  const accepted = await params.journal.accept(id, record, {
    receivedAt: record.receivedAt,
  });
  // "completed" is a durable dedupe hit. "failed" is a terminal tombstone in SDK releases that
  // expose one; compare as a string so the defensive branch also compiles where the accept-result
  // union omits it. Either way the message is already settled and must not dispatch again.
  const acceptedKind: string = accepted.kind;
  if (acceptedKind === "completed" || acceptedKind === "failed") {
    return "duplicate";
  }
  const dispatchRecord = accepted.kind === "pending" ? accepted.record.payload : record;
  // Pending duplicates also register as successors. This closes the account-reload race where a
  // replacement replay ran just before the old account admitted its final live event.
  scheduleAgentMailIngressDispatch({
    journal: params.journal,
    id,
    record: dispatchRecord,
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
  let dispatchAttempts = params.initialAttempts;
  let completionAttempts = 0;
  while (!params.abortSignal?.aborted) {
    if (!params.dispatchCompleted) {
      let turnAdopted = false;
      let turnDeferred = false;
      let turnAbandoned = false;
      let turnAdoptionObserved = false;
      let adoptionTask: Promise<void> | undefined;
      let settleDeferred!: (outcome: Exclude<DeferredOutcome, "aborted">) => void;
      const deferredOutcome = new Promise<Exclude<DeferredOutcome, "aborted">>((resolve) => {
        settleDeferred = resolve;
      });
      const onTurnAdopted = async () => {
        if (adoptionTask) {
          return await adoptionTask;
        }
        // Core waits for this observer before starting a fresh turn. Retry the marker inside the
        // observer so a transient store failure neither wedges a deferred callback nor causes the
        // outer dispatcher to enqueue a second turn.
        turnAdoptionObserved = true;
        adoptionTask = (async () => {
          while (!params.abortSignal?.aborted) {
            try {
              await completeAgentMailIngress(params);
              params.dispatchCompleted = true;
              turnAdopted = true;
              settleDeferred("adopted");
              return;
            } catch (error) {
              completionAttempts += 1;
              if (completionAttempts >= AGENTMAIL_MAX_COMPLETION_ATTEMPTS) {
                params.log?.error?.(
                  `AgentMail failed to persist adoption for message ${params.record.messageId} after ${completionAttempts} attempts`,
                );
                try {
                  if (
                    params.journal.fail &&
                    (await params.journal.fail(params.id, {
                      reason: "completion-marker-failed",
                      message: "AgentMail could not persist the adoption completion marker",
                      failedAt: Date.now(),
                    }))
                  ) {
                    params.dispatchCompleted = true;
                    turnAdopted = true;
                    settleDeferred("adopted");
                    return;
                  }
                } catch {
                  // Leave the row pending for restart recovery when neither terminal marker can
                  // persist.
                }
                settleDeferred("completion-failed");
                throw error;
              }
              if (
                !(await waitForRetry(
                  params.abortSignal,
                  (params.retryDelay ?? retryDelayMs)(completionAttempts),
                ))
              ) {
                settleDeferred("completion-failed");
                throw error;
              }
            }
          }
          settleDeferred("completion-failed");
          throw new Error("AgentMail adoption completion was aborted");
        })();
        return await adoptionTask;
      };
      const onTurnDeferred = () => {
        turnDeferred = true;
      };
      const onTurnAbandoned = async () => {
        // Abandonment can precede the deferred notification on rejection paths. Record it
        // independently so a dispatch return cannot accidentally complete and drop the row.
        if (!turnAdoptionObserved) {
          turnAbandoned = true;
          settleDeferred("abandoned");
        }
      };
      let dispatchFailed = false;
      let dispatchError: unknown;
      try {
        await params.dispatch(params.record, {
          onTurnAdopted,
          onTurnDeferred,
          onTurnAbandoned,
          abortSignal: params.abortSignal,
        });
      } catch (error) {
        dispatchFailed = true;
        dispatchError = error;
      }

      if (turnAdopted) {
        return true;
      }
      if (turnDeferred || turnAdoptionObserved) {
        // Once queued, a later dispatch rejection says nothing about ownership of that queued turn.
        // Wait for core to adopt or abandon it instead of releasing the row and double-dispatching.
        const outcome = await waitForDeferredOutcome(deferredOutcome, params.abortSignal);
        if (outcome === "adopted") {
          return true;
        }
        if (outcome === "aborted") {
          return false;
        }
        if (outcome === "completion-failed") {
          // Core may already have adopted the turn, but neither the completion marker nor the
          // terminal failure marker could be written. Leaving the row pending preserves recovery;
          // without any durable marker, a restart cannot distinguish adoption from non-adoption
          // and may replay the turn. That duplicate window is unavoidable during a total marker
          // store outage.
          return false;
        }
        turnAbandoned = true;
      }

      if (turnAbandoned) {
        dispatchAttempts += 1;
        const lastError = "deferred turn abandoned before adoption";
        if (dispatchAttempts >= AGENTMAIL_MAX_DISPATCH_ATTEMPTS) {
          params.log?.error?.(
            `AgentMail dropping message ${params.record.messageId} after ${dispatchAttempts} abandoned deferred turns`,
          );
          try {
            if (params.journal.fail) {
              await params.journal.fail(params.id, {
                reason: "dispatch-attempts-exhausted",
                message: lastError,
                failedAt: Date.now(),
              });
            } else {
              await completeAgentMailIngress(params);
            }
          } catch {
            // Best effort: TTL pruning still reclaims the row if the terminal marker cannot
            // persist.
          }
          return true;
        }
        const releaseOutcome = await releaseAgentMailIngressWithRetry({
          journal: params.journal,
          id: params.id,
          record: params.record,
          lastError,
          abortSignal: params.abortSignal,
          retryDelay: params.retryDelay ?? retryDelayMs,
          log: params.log,
        });
        if (releaseOutcome === "gone") {
          return true;
        }
        if (releaseOutcome !== "released") {
          return false;
        }
        if (
          !(await waitForRetry(
            params.abortSignal,
            (params.retryDelay ?? retryDelayMs)(dispatchAttempts),
          ))
        ) {
          return false;
        }
        continue;
      }

      if (dispatchFailed) {
        dispatchAttempts += 1;
        if (dispatchAttempts >= AGENTMAIL_MAX_DISPATCH_ATTEMPTS) {
          // Poison message: it has failed deterministically past the retry ceiling. Mark it
          // terminal so it stops occupying an admission slot and blocking new mail.
          params.log?.error?.(
            `AgentMail dropping message ${params.record.messageId} after ${dispatchAttempts} failed dispatch attempts: ${errorText(dispatchError)}`,
          );
          try {
            if (params.journal.fail) {
              await params.journal.fail(params.id, {
                reason: "dispatch-attempts-exhausted",
                message: errorText(dispatchError),
                failedAt: Date.now(),
              });
            } else {
              await completeAgentMailIngress(params);
            }
          } catch {
            // Best effort: TTL pruning still reclaims the row if the terminal marker cannot persist.
          }
          return true;
        }
        const lastError = errorText(dispatchError);
        const releaseOutcome = await releaseAgentMailIngressWithRetry({
          journal: params.journal,
          id: params.id,
          record: params.record,
          lastError,
          abortSignal: params.abortSignal,
          retryDelay: params.retryDelay ?? retryDelayMs,
          log: params.log,
        });
        if (releaseOutcome === "gone") {
          // A concurrent completion or retention prune means this worker no longer owns a pending
          // row. Redispatching without ownership could duplicate an adopted turn.
          return true;
        }
        if (releaseOutcome !== "released") {
          return false;
        }
        const shouldRetry = await waitForRetry(
          params.abortSignal,
          nextDispatchDelayMs({
            error: dispatchError,
            record: params.record,
            attempts: dispatchAttempts,
            retryDelay: params.retryDelay ?? retryDelayMs,
          }),
        );
        if (!shouldRetry) {
          return false;
        }
        continue;
      }
      params.dispatchCompleted = true;
    }
    try {
      await completeAgentMailIngress(params);
      return true;
    } catch {
      completionAttempts += 1;
      if (completionAttempts >= AGENTMAIL_MAX_COMPLETION_ATTEMPTS) {
        params.log?.error?.(
          `AgentMail failed to persist completion for message ${params.record.messageId} after ${completionAttempts} attempts; marking the ingress row failed`,
        );
        if (params.journal.fail) {
          return await params.journal.fail(params.id, {
            reason: "completion-marker-failed",
            message: "AgentMail could not persist the completion marker",
            failedAt: Date.now(),
          });
        }
        return false;
      }
      // Dispatch already produced the agent turn. Keep the row pending and retry only the
      // idempotent completion marker; releasing and redispatching would duplicate the reply.
      const shouldRetry = await waitForRetry(
        params.abortSignal,
        (params.retryDelay ?? retryDelayMs)(completionAttempts),
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
