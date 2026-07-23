import { createDurableInboundReceiveJournalFromQueue } from "openclaw/plugin-sdk/channel-outbound";
import { sha256Hex } from "./digest.js";
import { getAgentMailRuntime } from "./runtime.js";
import type { AgentMailIngressRecord } from "./types.js";

export const AGENTMAIL_DURABLE_PENDING_MAX_ENTRIES = 450;
export const AGENTMAIL_DURABLE_PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const AGENTMAIL_DURABLE_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Raised when durable ingress is already holding the maximum number of pending rows. Transports
 * translate this into plugin-owned backpressure (reject new mail) instead of evicting accepted,
 * not-yet-processed mail.
 */
export class AgentMailIngressCapacityError extends Error {
  constructor() {
    super("AgentMail durable ingress capacity is full");
    this.name = "AgentMailIngressCapacityError";
  }
}

export function createAgentMailDurableInboundId(params: {
  accountId: string;
  inboxId: string;
  messageId: string;
}): string {
  return sha256Hex(`${params.accountId}\n${params.inboxId}\n${params.messageId}`);
}

// Derive the journal type from the factory rather than a named SDK export (which is internal in
// some published releases), so the wrapper stays portable across SDK versions.
type AgentMailJournal = ReturnType<
  typeof createDurableInboundReceiveJournalFromQueue<AgentMailIngressRecord, undefined, undefined>
> & {
  fail?: (
    id: string,
    options: { reason: string; message?: string; failedAt?: number },
  ) => Promise<boolean>;
};

type AgentMailCapacityAdmissionState = {
  admissionChain: Promise<unknown>;
  pendingEstimate: number | null;
};

// Account reloads can briefly leave old and replacement journal facades open over the same
// persisted queue. Keep their count-and-accept sequence on one chain, keyed by that queue's stable
// storage identity, rather than coordinating only calls made through one facade.
const capacityAdmissionStates = new Map<string, AgentMailCapacityAdmissionState>();

function resolveCapacityAdmissionState(
  coordinationKey: string | undefined,
): AgentMailCapacityAdmissionState {
  if (!coordinationKey) {
    return { admissionChain: Promise.resolve(), pendingEstimate: null };
  }
  const existing = capacityAdmissionStates.get(coordinationKey);
  if (existing) {
    return existing;
  }
  const created = { admissionChain: Promise.resolve(), pendingEstimate: null };
  capacityAdmissionStates.set(coordinationKey, created);
  return created;
}

/**
 * Wraps the store-backed journal with an admission cap. The published SDK's queue journal only
 * evicts on capacity; durable email must instead reject NEW mail while keeping already-accepted
 * pending mail intact. Existing (duplicate) ids are always re-admitted so retries never bounce.
 */
export function withAgentMailIngressCapacity(
  journal: AgentMailJournal,
  maxPendingEntries: number,
  coordinationKey?: string,
): AgentMailJournal {
  // Serialize check-and-enqueue. The published queue journal has no atomic admission cap, so two
  // concurrent transports (live WebSocket + REST catch-up) could otherwise both observe free space
  // and push past the bound. Chaining admissions makes the count-then-accept step atomic across
  // every facade for the queue; the chain never rejects so one failed admission cannot poison
  // later ones. This intentionally introduces brief head-of-line coupling for facades sharing one
  // queue; each critical section contains only the queue admission and occasional capacity scan.
  const state = resolveCapacityAdmissionState(coordinationKey);
  // Upper-bound estimate of the pending count. It only increases on new admissions (never on
  // completion/retention pruning), so the O(pending) scan is skipped on the common below-cap path
  // and only runs to re-sync from the source of truth when the estimate first reaches the cap.
  return {
    ...journal,
    accept: (id, payload, options) => {
      const admission = state.admissionChain.then(async () => {
        try {
          const accepted = await journal.accept(id, payload, options);
          // Let the queue perform its atomic id lookup first. Completed tombstones and pending
          // duplicates consume no new capacity and must remain harmless even while the queue is
          // full.
          if (accepted.kind !== "accepted") {
            return accepted;
          }
          if (
            state.pendingEstimate === null ||
            state.pendingEstimate >= maxPendingEntries
          ) {
            const pending = await journal.pending();
            state.pendingEstimate = pending.length;
            if (state.pendingEstimate > maxPendingEntries) {
              try {
                if (await journal.deletePending(id)) {
                  state.pendingEstimate -= 1;
                }
              } catch {
                // Never turn a capacity rejection into a terminal tombstone. If rollback deletion
                // is temporarily unavailable, preserve the accepted pending row: provider
                // redelivery or REST catch-up re-admits that duplicate and dispatches it once
                // capacity recovers.
              }
              throw new AgentMailIngressCapacityError();
            }
          } else {
            state.pendingEstimate += 1;
          }
          return accepted;
        } catch (error) {
          // accept() may persist the row and then fail during its post-enqueue retention prune.
          // Any failure after entering the critical section makes the cached count uncertain; force
          // the next new admission to resynchronize from durable storage.
          state.pendingEstimate = null;
          throw error;
        }
      });
      state.admissionChain = admission.then(
        () => undefined,
        () => undefined,
      );
      return admission;
    },
  };
}

export function createAgentMailDurableInboundReceiveJournal(params: {
  accountId: string;
  inboxId: string;
}): AgentMailJournal {
  const runtime = getAgentMailRuntime();
  const stateDir = runtime.state.resolveStateDir();
  const queueAccountId = sha256Hex(`${params.accountId}\n${params.inboxId}`).slice(0, 24);
  const queue = runtime.state.openChannelIngressQueue<AgentMailIngressRecord, undefined, undefined>(
    {
      accountId: queueAccountId,
      stateDir,
    },
  );
  const retention = {
    pendingTtlMs: AGENTMAIL_DURABLE_PENDING_TTL_MS,
    completedTtlMs: AGENTMAIL_DURABLE_COMPLETED_TTL_MS,
    failedTtlMs: AGENTMAIL_DURABLE_PENDING_TTL_MS,
    failedMaxEntries: AGENTMAIL_DURABLE_PENDING_MAX_ENTRIES,
  };
  const prune = async (protectId?: string) => {
    await queue.prune({
      ...retention,
      ...(protectId ? { protectIds: [protectId] } : {}),
    });
  };
  // Keep failed tombstones terminal. The SDK facade currently projects queue `failed` results as
  // pending records for compatibility, which would redispatch an already-produced turn after a
  // completion-marker failure. This small facade maps them to the existing terminal `completed`
  // journal result while retaining the failed record in the underlying queue for diagnostics.
  const extendedJournal: AgentMailJournal = {
    accept: async (id, payload, options) => {
      await prune();
      const result = await queue.enqueue(id, payload, options);
      await prune(id);
      if (result.kind === "accepted") {
        return { kind: "accepted", duplicate: false, record: result.record };
      }
      if (result.kind === "pending" || result.kind === "claimed") {
        return { kind: "pending", duplicate: true, record: result.record };
      }
      if (result.kind === "completed") {
        return { kind: "completed", duplicate: true, record: result.record };
      }
      return {
        kind: "completed",
        duplicate: true,
        record: {
          id: result.record.id,
          channelId: result.record.channelId,
          accountId: result.record.accountId,
          queueName: result.record.queueName,
          completedAt: result.record.failedAt,
        },
      };
    },
    pending: async () => {
      await prune();
      return await queue.listPending({ limit: "all" });
    },
    complete: async (id, options) => {
      await queue.complete(id, options);
      await prune(id);
    },
    release: async (id, options) => {
      const released = await queue.release(id, options);
      await prune(id);
      return released;
    },
    deletePending: async (id) => await queue.delete(id),
    fail: async (id, options) => {
      const failed = await queue.fail(id, options);
      await prune(id);
      return failed;
    },
  };
  return withAgentMailIngressCapacity(
    extendedJournal,
    AGENTMAIL_DURABLE_PENDING_MAX_ENTRIES,
    `${stateDir}\nagentmail\n${queueAccountId}`,
  );
}
