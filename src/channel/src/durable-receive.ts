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
>;

/**
 * Wraps the store-backed journal with an admission cap. The published SDK's queue journal only
 * evicts on capacity; durable email must instead reject NEW mail while keeping already-accepted
 * pending mail intact. Existing (duplicate) ids are always re-admitted so retries never bounce.
 */
export function withAgentMailIngressCapacity(
  journal: AgentMailJournal,
  maxPendingEntries: number,
): AgentMailJournal {
  // Serialize check-and-enqueue. The published queue journal has no atomic admission cap, so two
  // concurrent transports (live WebSocket + REST catch-up) could otherwise both observe free space
  // and push past the bound. Chaining admissions makes the count-then-accept step atomic per
  // journal; the chain never rejects so one failed admission cannot poison later ones.
  let admissionChain: Promise<unknown> = Promise.resolve();
  return {
    ...journal,
    accept: (id, payload, options) => {
      const admission = admissionChain.then(async () => {
        const pending = await journal.pending();
        if (pending.length >= maxPendingEntries && !pending.some((entry) => entry.id === id)) {
          throw new AgentMailIngressCapacityError();
        }
        return journal.accept(id, payload, options);
      });
      admissionChain = admission.then(
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
  const queue = runtime.state.openChannelIngressQueue<AgentMailIngressRecord, undefined, undefined>(
    {
      accountId: sha256Hex(`${params.accountId}\n${params.inboxId}`).slice(0, 24),
      stateDir: runtime.state.resolveStateDir(),
    },
  );
  const journal = createDurableInboundReceiveJournalFromQueue({
    queue,
    retention: {
      pendingTtlMs: AGENTMAIL_DURABLE_PENDING_TTL_MS,
      completedTtlMs: AGENTMAIL_DURABLE_COMPLETED_TTL_MS,
      failedTtlMs: AGENTMAIL_DURABLE_PENDING_TTL_MS,
      failedMaxEntries: AGENTMAIL_DURABLE_PENDING_MAX_ENTRIES,
    },
  });
  return withAgentMailIngressCapacity(journal, AGENTMAIL_DURABLE_PENDING_MAX_ENTRIES);
}
