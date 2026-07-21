import { createHash } from "node:crypto";
import { createDurableInboundReceiveJournalFromQueue } from "openclaw/plugin-sdk/channel-outbound";
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

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createAgentMailDurableInboundId(params: {
  accountId: string;
  inboxId: string;
  messageId: string;
}): string {
  return digest(`${params.accountId}\n${params.inboxId}\n${params.messageId}`);
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
  return {
    ...journal,
    accept: async (id, payload, options) => {
      const pending = await journal.pending();
      if (pending.length >= maxPendingEntries && !pending.some((entry) => entry.id === id)) {
        throw new AgentMailIngressCapacityError();
      }
      return journal.accept(id, payload, options);
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
      accountId: digest(`${params.accountId}\n${params.inboxId}`).slice(0, 24),
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
