import type { AgentMailClient } from "agentmail";
import { randomUUID } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { type AgentMailLog, errorText } from "./log.js";
import { createAgentMailClient } from "./client.js";
import { sha256Hex } from "./digest.js";
import {
  AGENTMAIL_DURABLE_PENDING_TTL_MS,
  AgentMailIngressCapacityError,
} from "./durable-receive.js";
import {
  AGENTMAIL_PROVIDER_FUTURE_SKEW_MAX_MS,
  AGENTMAIL_RECEIVED_LABEL,
  capAgentMailProviderTimestampForRetention,
  isValidAgentMailTimestampMs,
  isReceivedAgentMailMessage,
  resolveAgentMailTimestampMs,
  resolveReceivedAgentMailMessageTimestampMs,
} from "./received-message.js";
import { createBackoff, waitForRetry } from "./retry.js";
import { getAgentMailRuntime } from "./runtime.js";
import type { AgentMailIngressRecord, ResolvedAgentMailAccount } from "./types.js";

const CURSOR_VERSION = 1;
const PAGE_LIMIT = 100;

export const AGENTMAIL_REST_CATCH_UP_NAMESPACE = "agentmail.rest-catch-up";
export const AGENTMAIL_REST_CATCH_UP_LEGACY_MAX_ACCOUNTS = 1_000;
export const AGENTMAIL_REST_CATCH_UP_MAX_ENTRIES_PER_ACCOUNT = 1;
// Two full pages of future-dated ids. This bounds cursor size rather than correctness: ids past the
// cap are forgotten, so their rows re-admit (deduplicated, never re-dispatched) on each sweep until
// the clock covers them — the same churn the memo removes, for the overflow only.
export const AGENTMAIL_REST_CATCH_UP_MAX_FUTURE_ADMISSIONS = 2 * PAGE_LIMIT;
// Provider message ids are unbounded strings, so an entry count alone does not bound the persisted
// value. The keyed store rejects a value over 64KB and persistCursor does not catch that, which
// would strand catch-up in its retry loop instead of degrading to re-admission. Budget the memo at
// half the limit so the baseline/high-water fields and both checkpoints — whose page tokens are
// also provider-sized — always fit alongside it.
const FUTURE_ADMISSION_BUDGET_BYTES = 32 * 1024;
// `{"messageId":"","atMs":1700000000000},` plus room for JSON escaping.
const FUTURE_ADMISSION_OVERHEAD_BYTES = 48;
export const AGENTMAIL_REST_CATCH_UP_CURSOR_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const AGENTMAIL_REST_CATCH_UP_OVERLAP_MS = 5 * 60_000;
// Periodic overlap covers half-open sockets and provider webhook gaps; the less frequent deep sweep
// lists from the baseline so back-dated mail below the overlap window is still recovered. Both run
// for WebSocket and webhook ingress so recovery never stalls after a capacity pause.
export const AGENTMAIL_CATCH_UP_INTERVAL_MS = 60_000;
export const AGENTMAIL_DEEP_SWEEP_INTERVAL_MS = 15 * 60_000;

export type AgentMailCatchUpCheckpoint = {
  afterAtMs: number;
  beforeAtMs: number;
  pageToken: string;
  highWaterAtMs: number;
  sinceBaseline: boolean;
};

export type AgentMailCatchUpCheckpoints = {
  normal?: AgentMailCatchUpCheckpoint;
  deep?: AgentMailCatchUpCheckpoint;
};

/** A row admitted ahead of the sweep clock, remembered by id because the cursor cannot pass it. */
export type AgentMailCatchUpFutureAdmission = {
  messageId: string;
  atMs: number;
};

export type AgentMailCatchUpCursor = {
  version: typeof CURSOR_VERSION;
  baselineAtMs: number;
  highWaterAtMs: number;
  established: boolean;
  generation?: string;
  checkpoints?: AgentMailCatchUpCheckpoints;
  futureAdmissions?: AgentMailCatchUpFutureAdmission[];
  /** Legacy single-slot checkpoint, migrated by normalizeCursor. */
  checkpoint?: AgentMailCatchUpCheckpoint;
};

export type AgentMailCatchUpSession = {
  run(params: {
    receive: (record: AgentMailIngressRecord) => Promise<void>;
    abortSignal: AbortSignal;
    // A deep sweep lists from the monitoring baseline instead of the recent high-water overlap, so
    // back-dated or long-delayed mail that fell below the overlap window is still recovered.
    sinceBaseline?: boolean;
  }): Promise<void>;
};

export type AgentMailCatchUpSupervisor = {
  request(): void;
  requestDeep(): void;
  settle(): Promise<void>;
};

const catchUpRetryDelayMs = createBackoff(30_000);

export function createAgentMailCatchUpSupervisor(params: {
  session: AgentMailCatchUpSession;
  receive: (record: AgentMailIngressRecord) => Promise<void>;
  abortSignal: AbortSignal;
  retryDelayMs?: (attempt: number) => number;
  log?: AgentMailLog;
}): AgentMailCatchUpSupervisor {
  let requested = false;
  let deepRequested = false;
  let worker: Promise<void> | undefined;
  const retryDelay = params.retryDelayMs ?? catchUpRetryDelayMs;

  const request = (): void => {
    requested = true;
    if (worker) {
      return;
    }
    worker = (async () => {
      let attempts = 0;
      while (!params.abortSignal.aborted && requested) {
        requested = false;
        // Consume the deep flag for this pass so a single serialized worker handles both modes
        // without concurrent runs racing the shared cursor.
        const sinceBaseline = deepRequested;
        deepRequested = false;
        try {
          await params.session.run({
            receive: params.receive,
            abortSignal: params.abortSignal,
            sinceBaseline,
          });
          attempts = 0;
        } catch (error) {
          attempts += 1;
          requested = true;
          deepRequested ||= sinceBaseline;
          params.log?.error?.(
            `AgentMail REST catch-up failed; retrying: ${errorText(error)}`,
          );
          if (!(await waitForRetry(params.abortSignal, retryDelay(attempts)))) {
            return;
          }
        }
      }
    })().finally(() => {
      worker = undefined;
      if (requested && !params.abortSignal.aborted) {
        request();
      }
    });
  };

  return {
    request,
    requestDeep: () => {
      deepRequested = true;
      request();
    },
    settle: async () => {
      await worker;
    },
  };
}

/**
 * Starts the periodic overlap and deep-sweep timers that keep REST recovery running for the life of
 * an account, independent of live socket/webhook events. Returns the worker promises so the caller
 * can await them on shutdown. Shared by both WebSocket and webhook ingress so a capacity pause is
 * always followed by a later retry.
 */
export function startAgentMailPeriodicCatchUp(params: {
  supervisor: AgentMailCatchUpSupervisor;
  abortSignal: AbortSignal;
  catchUpIntervalMs?: number;
  deepSweepIntervalMs?: number;
}): Promise<void>[] {
  const catchUpIntervalMs = params.catchUpIntervalMs ?? AGENTMAIL_CATCH_UP_INTERVAL_MS;
  const deepSweepIntervalMs = params.deepSweepIntervalMs ?? AGENTMAIL_DEEP_SWEEP_INTERVAL_MS;
  const periodic = (async () => {
    while (!params.abortSignal.aborted) {
      if (!(await waitForRetry(params.abortSignal, catchUpIntervalMs))) {
        return;
      }
      params.supervisor.request();
    }
  })();
  const deep = (async () => {
    while (!params.abortSignal.aborted) {
      if (!(await waitForRetry(params.abortSignal, deepSweepIntervalMs))) {
        return;
      }
      params.supervisor.requestDeep();
    }
  })();
  return [periodic, deep];
}

function cursorKey(account: ResolvedAgentMailAccount): string {
  return sha256Hex(`${account.accountId}\n${account.inboxId}`);
}

function cursorNamespace(account: ResolvedAgentMailAccount): string {
  // Reuse one bounded namespace per account across inbox rotations. persistCursor fences every
  // write by key and claimed generation, so an evicted old inbox key can never be reinserted.
  return `${AGENTMAIL_REST_CATCH_UP_NAMESPACE}.${sha256Hex(account.accountId)}`;
}

function normalizeCheckpoint(value: unknown): AgentMailCatchUpCheckpoint | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const checkpoint = value as Partial<AgentMailCatchUpCheckpoint>;
  if (
    !isValidAgentMailTimestampMs(checkpoint.afterAtMs) ||
    !isValidAgentMailTimestampMs(checkpoint.beforeAtMs) ||
    checkpoint.beforeAtMs < checkpoint.afterAtMs ||
    typeof checkpoint.pageToken !== "string" ||
    checkpoint.pageToken.length === 0 ||
    !isValidAgentMailTimestampMs(checkpoint.highWaterAtMs) ||
    typeof checkpoint.sinceBaseline !== "boolean"
  ) {
    return undefined;
  }
  return {
    afterAtMs: checkpoint.afterAtMs,
    beforeAtMs: checkpoint.beforeAtMs,
    pageToken: checkpoint.pageToken,
    highWaterAtMs: checkpoint.highWaterAtMs,
    sinceBaseline: checkpoint.sinceBaseline,
  };
}

function capFutureAdmissions(
  entries: AgentMailCatchUpFutureAdmission[],
): AgentMailCatchUpFutureAdmission[] {
  if (entries.length === 0) {
    return entries;
  }
  // Keep the furthest-future ids: those are the ones the sweep clock takes longest to cover, so
  // forgetting them would churn the longest. Both caps are re-applied on every persist, so a
  // dropped id keeps re-admitting once per sweep — bounded by how soon the clock reaches its
  // nearer date, and always deduplicated by durable ingress rather than re-dispatched.
  const ordered = [...entries].sort((left, right) => right.atMs - left.atMs);
  const kept: AgentMailCatchUpFutureAdmission[] = [];
  let budgetBytes = 0;
  for (const entry of ordered) {
    if (kept.length >= AGENTMAIL_REST_CATCH_UP_MAX_FUTURE_ADMISSIONS) {
      break;
    }
    budgetBytes += FUTURE_ADMISSION_OVERHEAD_BYTES + Buffer.byteLength(entry.messageId, "utf8");
    if (budgetBytes > FUTURE_ADMISSION_BUDGET_BYTES) {
      break;
    }
    kept.push(entry);
  }
  return kept;
}

function serializeFutureAdmissions(
  entries: ReadonlyMap<string, number>,
): AgentMailCatchUpFutureAdmission[] {
  return [...entries].map(([messageId, atMs]) => ({ messageId, atMs }));
}

function normalizeFutureAdmissions(value: unknown): AgentMailCatchUpFutureAdmission[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const entries: AgentMailCatchUpFutureAdmission[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const entry = raw as Partial<AgentMailCatchUpFutureAdmission>;
    if (
      typeof entry.messageId !== "string" ||
      entry.messageId.length === 0 ||
      !isValidAgentMailTimestampMs(entry.atMs) ||
      seen.has(entry.messageId)
    ) {
      continue;
    }
    seen.add(entry.messageId);
    entries.push({ messageId: entry.messageId, atMs: entry.atMs });
  }
  return capFutureAdmissions(entries);
}

function normalizeCursor(value: unknown): AgentMailCatchUpCursor | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const cursor = value as Partial<AgentMailCatchUpCursor>;
  if (
    cursor.version !== CURSOR_VERSION ||
    !isValidAgentMailTimestampMs(cursor.baselineAtMs) ||
    !isValidAgentMailTimestampMs(cursor.highWaterAtMs) ||
    typeof cursor.established !== "boolean"
  ) {
    return null;
  }
  const rawCheckpoints = cursor.checkpoints;
  const normalCheckpoint = normalizeCheckpoint(rawCheckpoints?.normal);
  const deepCheckpoint = normalizeCheckpoint(rawCheckpoints?.deep);
  const legacyCheckpoint = normalizeCheckpoint(cursor.checkpoint);
  const checkpoints: AgentMailCatchUpCheckpoints = {
    ...(normalCheckpoint ? { normal: normalCheckpoint } : {}),
    ...(deepCheckpoint ? { deep: deepCheckpoint } : {}),
  };
  if (legacyCheckpoint) {
    const mode = legacyCheckpoint.sinceBaseline ? "deep" : "normal";
    checkpoints[mode] ??= legacyCheckpoint;
  }
  const futureAdmissions = normalizeFutureAdmissions(cursor.futureAdmissions);
  return {
    version: CURSOR_VERSION,
    baselineAtMs: cursor.baselineAtMs,
    highWaterAtMs: Math.max(cursor.baselineAtMs, cursor.highWaterAtMs),
    established: cursor.established,
    ...(typeof cursor.generation === "string" && cursor.generation
      ? { generation: cursor.generation }
      : {}),
    ...(checkpoints.normal || checkpoints.deep ? { checkpoints } : {}),
    ...(futureAdmissions.length > 0 ? { futureAdmissions } : {}),
  };
}

function mergeCursor(
  currentValue: unknown,
  next: Pick<
    AgentMailCatchUpCursor,
    "baselineAtMs" | "highWaterAtMs" | "established" | "futureAdmissions"
  >,
  upperBoundAtMs: number,
  generation: string,
  checkpointMode: "normal" | "deep",
  checkpoint: AgentMailCatchUpCheckpoint | null,
): AgentMailCatchUpCursor {
  const current = normalizeCursor(currentValue);
  const checkpoints = { ...current?.checkpoints };
  const futureAdmissions = capFutureAdmissions(next.futureAdmissions ?? []);
  if (checkpoint) {
    checkpoints[checkpointMode] = checkpoint;
  } else {
    delete checkpoints[checkpointMode];
  }
  const baselineAtMs = Math.min(
    upperBoundAtMs,
    current?.baselineAtMs ?? next.baselineAtMs,
    next.baselineAtMs,
  );
  return {
    version: CURSOR_VERSION,
    baselineAtMs,
    // Repair committed values that are now beyond the wall-clock horizon while merging both
    // in-range contributions monotonically. Without the committed-value clamp, frequent restarts
    // can keep deep recovery from ever repairing a cursor left in the future by clock rollback.
    highWaterAtMs: Math.max(
      baselineAtMs,
      Math.min(upperBoundAtMs, current?.highWaterAtMs ?? 0),
      Math.min(upperBoundAtMs, next.highWaterAtMs),
    ),
    established: current?.established === true || next.established,
    generation,
    ...(checkpoints.normal || checkpoints.deep ? { checkpoints } : {}),
    // Generation-fenced writes serialize every sweep for this cursor, so the running sweep's set —
    // already pruned against its own clock — replaces the stored one rather than merging with it.
    ...(futureAdmissions.length > 0 ? { futureAdmissions } : {}),
  };
}

async function persistCursor(params: {
  store: PluginStateKeyedStore<AgentMailCatchUpCursor>;
  key: string;
  baselineAtMs: number;
  highWaterAtMs: number;
  established: boolean;
  upperBoundAtMs: number;
  generation: string;
  checkpointMode: "normal" | "deep";
  checkpoint: AgentMailCatchUpCheckpoint | null;
  futureAdmissions: AgentMailCatchUpFutureAdmission[];
}): Promise<boolean> {
  const update = params.store.update;
  if (!update) {
    throw new Error("AgentMail catch-up requires atomic keyed-store updates");
  }
  return await update(
    params.key,
    (currentValue) => {
      const current = normalizeCursor(currentValue);
      if (!current || current.generation !== params.generation) {
        return undefined;
      }
      return mergeCursor(
        current,
        params,
        params.upperBoundAtMs,
        params.generation,
        params.checkpointMode,
        params.checkpoint,
      );
    },
    { ttlMs: AGENTMAIL_REST_CATCH_UP_CURSOR_TTL_MS },
  );
}

async function claimCursorGeneration(params: {
  store: PluginStateKeyedStore<AgentMailCatchUpCursor>;
  key: string;
  generation: string;
}): Promise<void> {
  const update = params.store.update;
  if (!update) {
    throw new Error("AgentMail catch-up requires atomic keyed-store updates");
  }
  const claimed = await update(
    params.key,
    (currentValue) => {
      const current = normalizeCursor(currentValue);
      return current ? { ...current, generation: params.generation } : undefined;
    },
    { ttlMs: AGENTMAIL_REST_CATCH_UP_CURSOR_TTL_MS },
  );
  if (!claimed) {
    throw new Error("AgentMail catch-up cursor disappeared while claiming its generation");
  }
}

export async function createAgentMailCatchUpSession(params: {
  account: ResolvedAgentMailAccount;
  client?: AgentMailClient;
  store?: PluginStateKeyedStore<AgentMailCatchUpCursor>;
  now?: () => number;
  log?: AgentMailLog;
}): Promise<AgentMailCatchUpSession> {
  const now = params.now ?? Date.now;
  const key = cursorKey(params.account);
  let store = params.store;
  if (!store) {
    const state = getAgentMailRuntime().state;
    const accountStore = state.openKeyedStore<AgentMailCatchUpCursor>({
      // One entry per account bounds inbox-rotation state. Generation-fenced updates cannot upsert
      // an evicted key, so overlapping old sessions cannot displace the replacement cursor.
      namespace: cursorNamespace(params.account),
      maxEntries: AGENTMAIL_REST_CATCH_UP_MAX_ENTRIES_PER_ACCOUNT,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: AGENTMAIL_REST_CATCH_UP_CURSOR_TTL_MS,
    });
    store = accountStore;
    // Upgrade migration probes the older shared namespace. Probe it even when the replacement
    // cursor exists so transient cleanup failures remain retryable on later startups.
    const legacyStore = state.openKeyedStore<AgentMailCatchUpCursor>({
      namespace: AGENTMAIL_REST_CATCH_UP_NAMESPACE,
      maxEntries: AGENTMAIL_REST_CATCH_UP_LEGACY_MAX_ACCOUNTS,
      overflowPolicy: "reject-new",
    });
    const legacyCursor = normalizeCursor(await legacyStore.lookup(key));
    if (!normalizeCursor(await accountStore.lookup(key)) && legacyCursor) {
      // Copy before creating a fresh baseline so mail received between shutdown and upgraded
      // startup remains inside the recovery window.
      await accountStore.registerIfAbsent(key, legacyCursor, {
        ttlMs: AGENTMAIL_REST_CATCH_UP_CURSOR_TTL_MS,
      });
    }
    if (legacyCursor && normalizeCursor(await accountStore.lookup(key))) {
      try {
        await legacyStore.delete(key);
      } catch (error) {
        params.log?.warn?.(
          `AgentMail could not remove a migrated catch-up cursor: ${errorText(error)}`,
        );
      }
    }
  }
  const initialAtMs = now();
  const initialCursor: AgentMailCatchUpCursor = {
    version: CURSOR_VERSION,
    baselineAtMs: initialAtMs,
    highWaterAtMs: initialAtMs,
    established: false,
  };
  await store.registerIfAbsent(key, initialCursor, {
    ttlMs: AGENTMAIL_REST_CATCH_UP_CURSOR_TTL_MS,
  });
  const generation = randomUUID();
  await claimCursorGeneration({ store, key, generation });
  const client = params.client ?? createAgentMailClient(params.account);

  return {
    run: async ({ receive, abortSignal, sinceBaseline }) => {
      const storedCursor = normalizeCursor(await store.lookup(key));
      if (!storedCursor) {
        throw new Error("AgentMail WebSocket catch-up cursor is unavailable");
      }
      if (storedCursor.generation !== generation) {
        // A replacement session now owns this inbox generation. The old worker must stop before it
        // can overwrite the replacement's cursor or continuation checkpoint.
        return;
      }
      // Never scan below the durable recovery horizon on any sweep. Pending work and completed
      // tombstones share this retention period, so catch-up can recover mail throughout the entire
      // time the durable queue promises to retain it without re-admitting expired tombstones.
      // Using the shorter historical completed-only horizon could skip never-admitted mail while
      // ingress remained backpressured.
      //
      // The deep sweep lists from max(baseline, recoveryFloor): it recovers back-dated mail within
      // the durable retention window and since monitoring began, but deliberately does not scan
      // before the baseline, which would re-inject pre-monitoring history.
      const runAtMs = now();
      const recoveryFloorMs = Math.max(0, runAtMs - AGENTMAIL_DURABLE_PENDING_TTL_MS);
      const requestedSinceBaseline = sinceBaseline === true;
      const checkpointMode = requestedSinceBaseline ? "deep" : "normal";
      const storedCheckpoint = storedCursor.checkpoints?.[checkpointMode];
      const eligibleCheckpoint =
        storedCheckpoint &&
        storedCheckpoint.beforeAtMs <= runAtMs + 1 &&
        storedCheckpoint.beforeAtMs > recoveryFloorMs
          ? storedCheckpoint
          : undefined;
      const resumableCheckpoint = eligibleCheckpoint;
      const sweepAtMs = resumableCheckpoint
        ? resumableCheckpoint.beforeAtMs - 1
        : runAtMs;
      // If the host clock moved backwards, both stored bounds can be in the future. Clamp the
      // effective cursor for this run and persist the repaired value after a successful sweep.
      const effectiveBaselineAtMs = Math.min(storedCursor.baselineAtMs, sweepAtMs);
      const effectiveHighWaterAtMs = Math.max(
        effectiveBaselineAtMs,
        Math.min(storedCursor.highWaterAtMs, sweepAtMs),
      );
      // Scan the same bounded future-skew horizon accepted by live ingress. This lets REST recover
      // a missed live event promptly without allowing an arbitrary sender date to move the cursor
      // beyond the local clock or retain its tombstone indefinitely.
      const beforeMs = sweepAtMs + 1;
      const providerBeforeMs = beforeMs + AGENTMAIL_PROVIDER_FUTURE_SKEW_MAX_MS;
      // High-water advancement is clamped to this sweep, so a future-dated row stays inside the
      // listed window on every later sweep — up to the full skew horizon. Remember the ids already
      // admitted ahead of the clock so those repeats are skipped instead of re-entering the
      // admission chain (and inflating the admitted count) once a minute for a day. Entries the
      // clock has now covered are dropped: the normal high-water path takes over from there.
      //
      // The upper bound only discards implausible dates that the furthest-first cap would otherwise
      // pin forever, and is measured from the CURRENT run, never from this sweep's bound: a resumed
      // continuation rewinds sweepAtMs to its original window, and pruning against that older
      // horizon would discard ids a later sweep legitimately recorded — persistCursor then writes
      // the loss back. A row dated beyond even the run horizon is forgotten and re-admitted
      // (deduplicated), which only happens when a provider violates the `before` filter it was sent.
      const memoHorizonAtMs = runAtMs + AGENTMAIL_PROVIDER_FUTURE_SKEW_MAX_MS;
      const futureAdmissions = new Map(
        (storedCursor.futureAdmissions ?? [])
          .filter((entry) => entry.atMs > runAtMs && entry.atMs <= memoHorizonAtMs)
          .map((entry) => [entry.messageId, entry.atMs] as const),
      );
      const baseAfterMs =
        requestedSinceBaseline || !storedCursor.established
          ? effectiveBaselineAtMs
          : effectiveHighWaterAtMs - AGENTMAIL_REST_CATCH_UP_OVERLAP_MS;
      const afterMs = resumableCheckpoint
        ? resumableCheckpoint.afterAtMs
        : Math.max(0, baseAfterMs, recoveryFloorMs);
      let highWaterAtMs = Math.max(
        effectiveHighWaterAtMs,
        Math.min(sweepAtMs, resumableCheckpoint?.highWaterAtMs ?? 0),
      );
      let pageCursor = resumableCheckpoint?.pageToken;
      let admitted = 0;
      do {
        const page = await client.inboxes.messages.list(
          params.account.inboxId,
          {
            limit: PAGE_LIMIT,
            ...(pageCursor ? { pageToken: pageCursor } : {}),
            labels: [AGENTMAIL_RECEIVED_LABEL],
            after: new Date(afterMs),
            // Exclude implausibly future provider rows from normal pagination. The per-row clamp
            // below remains defensive in case a provider projection violates this filter.
            before: new Date(providerBeforeMs),
            ascending: true,
            includeSpam: false,
            includeBlocked: false,
            includeUnauthenticated: false,
            includeTrash: false,
          },
          { abortSignal },
        );
        if (!page || typeof page !== "object" || !Array.isArray(page.messages)) {
          // Do not let one malformed provider response trap the serialized supervisor in its retry
          // loop. Leave the cursor untouched and let the next periodic pass retry the same range.
          params.log?.error?.(
            `AgentMail catch-up received a malformed messages page for account ${params.account.accountId}`,
          );
          return;
        }
        for (const message of page.messages) {
          if (abortSignal.aborted) {
            return;
          }
          if (!isReceivedAgentMailMessage(message, params.account.inboxId)) {
            continue;
          }
          const providerReceivedAt = resolveReceivedAgentMailMessageTimestampMs(
            message,
            params.account.inboxId,
          );
          const providerCreatedAt = resolveAgentMailTimestampMs(message.createdAt);
          // Retention is filtered on the SAME effective provider time the row is admitted with,
          // below. Checking only message.timestamp would let a malformed sender date fall through
          // to the createdAt fallback unfiltered, re-admitting mail whose tombstone already expired.
          const providerAtMs = providerReceivedAt ?? providerCreatedAt;
          // A resumed page token retains the original query boundary. Skip rows that have since
          // aged beyond durable tombstone retention so an old continuation cannot re-admit them.
          if (providerAtMs !== null && providerAtMs < recoveryFloorMs) {
            continue;
          }
          // Derived from the same effective provider time the row is admitted and filtered with: a
          // malformed sender date with a future createdAt is just as unreachable by the high-water
          // cursor as a future `timestamp`, so it must be memoized too or it re-lists, re-admits,
          // and re-warns on every sweep until the clock catches up.
          //
          // Compared against the run clock, never the sweep bound: a resumed continuation rewinds
          // sweepAtMs to its original window, and every ordinary row that arrived since would then
          // be misread as sender skew — warned about, and memoized until the next full sweep prunes
          // it. The memo exists for rows the clock has genuinely not reached.
          const isFutureRow = providerAtMs !== null && providerAtMs > runAtMs;
          if (isFutureRow && futureAdmissions.has(message.messageId)) {
            // Already admitted ahead of the clock by an earlier sweep; durable ingress would only
            // deduplicate it again.
            continue;
          }
          const arrivedAt = now();
          const receivedAt = capAgentMailProviderTimestampForRetention(
            providerAtMs ?? arrivedAt,
            arrivedAt,
          );
          if (providerReceivedAt === null) {
            // Invalid sender time must not turn a missed event into a permanent drop. Admit using
            // provider/local arrival and advance to the fixed sweep bound so it is not re-listed
            // and warned about on every periodic scan.
            params.log?.warn?.(
              `AgentMail catch-up used provider/local arrival time for message ${message.messageId} with an invalid timestamp`,
            );
          } else if (isFutureRow) {
            // Sender-authored time can be arbitrarily skewed. The row was admitted above using a
            // bounded retention timestamp, and cursor advancement remains clamped to this sweep.
            params.log?.warn?.(
              `AgentMail catch-up clamped future timestamp for message ${message.messageId}`,
            );
          }
          try {
            await receive({
              accountId: params.account.accountId,
              inboxId: params.account.inboxId,
              messageId: message.messageId,
              transport: "rest",
              receivedAt,
              arrivedAt,
            });
          } catch (error) {
            if (error instanceof AgentMailIngressCapacityError) {
              // Durable ingress is full. Stop this pass without advancing the cursor past the
              // unadmitted message and without a tight failure loop that would re-list the same
              // pages. The periodic sweep re-runs catch-up once capacity frees.
              params.log?.info?.(
                `AgentMail catch-up paused: durable ingress is full for account ${params.account.accountId}`,
              );
              return;
            }
            throw error;
          }
          admitted += 1;
          if (isFutureRow) {
            futureAdmissions.set(message.messageId, providerAtMs);
          }
          highWaterAtMs = Math.max(
            highWaterAtMs,
            providerReceivedAt === null ? sweepAtMs : Math.min(providerReceivedAt, sweepAtMs),
          );
        }
        pageCursor = page.nextPageToken;
        if (pageCursor) {
          // Save a continuation only after every message on this page was durably admitted. The
          // committed high-water mark remains unchanged until the entire sweep completes, so an
          // out-of-order later page can never be skipped after capacity or a process restart.
          const persisted = await persistCursor({
            store,
            key,
            baselineAtMs: effectiveBaselineAtMs,
            highWaterAtMs: effectiveHighWaterAtMs,
            established: storedCursor.established,
            // A deep continuation can predate a completed normal sweep. Bound clock repair to the
            // current run, not the resumed sweep, so its older window cannot rewind high-water.
            upperBoundAtMs: runAtMs,
            generation,
            checkpointMode,
            checkpoint: {
              afterAtMs: afterMs,
              beforeAtMs: beforeMs,
              pageToken: pageCursor,
              highWaterAtMs,
              sinceBaseline: requestedSinceBaseline,
            },
            futureAdmissions: serializeFutureAdmissions(futureAdmissions),
          });
          if (!persisted) {
            return;
          }
        }
      } while (pageCursor && !abortSignal.aborted);

      if (abortSignal.aborted) {
        return;
      }
      const persisted = await persistCursor({
        store,
        key,
        baselineAtMs: effectiveBaselineAtMs,
        highWaterAtMs,
        established: true,
        upperBoundAtMs: runAtMs,
        generation,
        checkpointMode,
        checkpoint: null,
        futureAdmissions: serializeFutureAdmissions(futureAdmissions),
      });
      if (!persisted) {
        return;
      }
      if (admitted > 0) {
        params.log?.info?.(
          `AgentMail WebSocket catch-up admitted ${admitted} message${admitted === 1 ? "" : "s"} for account ${params.account.accountId}`,
        );
      }
    },
  };
}
