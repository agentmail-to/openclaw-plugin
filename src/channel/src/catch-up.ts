import type { AgentMail, AgentMailClient } from "agentmail";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { type AgentMailLog, errorText } from "./log.js";
import { createAgentMailClient } from "./client.js";
import { sha256Hex } from "./digest.js";
import {
  AGENTMAIL_DURABLE_COMPLETED_TTL_MS,
  AgentMailIngressCapacityError,
} from "./durable-receive.js";
import {
  AGENTMAIL_RECEIVED_LABEL,
  isAgentMailProviderTimestampWithinFutureSkew,
  isReceivedAgentMailMessage,
  resolveReceivedAgentMailMessageTimestampMs,
} from "./received-message.js";
import { createBackoff, waitForRetry } from "./retry.js";
import { getAgentMailRuntime } from "./runtime.js";
import type { AgentMailIngressRecord, ResolvedAgentMailAccount } from "./types.js";

const CURSOR_VERSION = 1;
const PAGE_LIMIT = 100;

export const AGENTMAIL_REST_CATCH_UP_NAMESPACE = "agentmail.rest-catch-up";
export const AGENTMAIL_REST_CATCH_UP_MAX_ACCOUNTS = 1_000;
export const AGENTMAIL_REST_CATCH_UP_OVERLAP_MS = 5 * 60_000;
// Periodic overlap covers half-open sockets and provider webhook gaps; the less frequent deep sweep
// lists from the baseline so back-dated mail below the overlap window is still recovered. Both run
// for WebSocket and webhook ingress so recovery never stalls after a capacity pause.
export const AGENTMAIL_CATCH_UP_INTERVAL_MS = 60_000;
export const AGENTMAIL_DEEP_SWEEP_INTERVAL_MS = 15 * 60_000;

export type AgentMailCatchUpCursor = {
  version: typeof CURSOR_VERSION;
  baselineAtMs: number;
  highWaterAtMs: number;
  established: boolean;
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

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeCursor(value: unknown): AgentMailCatchUpCursor | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const cursor = value as Partial<AgentMailCatchUpCursor>;
  if (
    cursor.version !== CURSOR_VERSION ||
    !validTimestamp(cursor.baselineAtMs) ||
    !validTimestamp(cursor.highWaterAtMs) ||
    typeof cursor.established !== "boolean"
  ) {
    return null;
  }
  return {
    version: CURSOR_VERSION,
    baselineAtMs: cursor.baselineAtMs,
    highWaterAtMs: Math.max(cursor.baselineAtMs, cursor.highWaterAtMs),
    established: cursor.established,
  };
}

async function persistCursor(params: {
  store: PluginStateKeyedStore<AgentMailCatchUpCursor>;
  key: string;
  baselineAtMs: number;
  highWaterAtMs: number;
  upperBoundAtMs: number;
  established: boolean;
}): Promise<void> {
  const merge = (currentValue: unknown): AgentMailCatchUpCursor => {
    const current = normalizeCursor(currentValue);
    const baselineAtMs = current?.baselineAtMs ?? params.baselineAtMs;
    return {
      version: CURSOR_VERSION,
      baselineAtMs,
      // A backward-moving clock may lower this run's upper bound, but must never lower a
      // high-water mark already committed by an earlier run. Clamp only the new contribution.
      highWaterAtMs: Math.max(
        baselineAtMs,
        current?.highWaterAtMs ?? 0,
        Math.min(params.upperBoundAtMs, params.highWaterAtMs),
      ),
      established: current?.established === true || params.established,
    };
  };
  const update = params.store.update;
  if (update) {
    await update(params.key, merge);
    return;
  }
  await params.store.register(params.key, merge(await params.store.lookup(params.key)));
}

export async function createAgentMailCatchUpSession(params: {
  account: ResolvedAgentMailAccount;
  client?: AgentMailClient;
  store?: PluginStateKeyedStore<AgentMailCatchUpCursor>;
  now?: () => number;
  log?: AgentMailLog;
}): Promise<AgentMailCatchUpSession> {
  const now = params.now ?? Date.now;
  const store =
    params.store ??
    getAgentMailRuntime().state.openKeyedStore<AgentMailCatchUpCursor>({
      namespace: AGENTMAIL_REST_CATCH_UP_NAMESPACE,
      maxEntries: AGENTMAIL_REST_CATCH_UP_MAX_ACCOUNTS,
      overflowPolicy: "reject-new",
    });
  const key = cursorKey(params.account);
  const initialAtMs = now();
  const initialCursor: AgentMailCatchUpCursor = {
    version: CURSOR_VERSION,
    baselineAtMs: initialAtMs,
    highWaterAtMs: initialAtMs,
    established: false,
  };
  await store.registerIfAbsent(key, initialCursor);
  const client = params.client ?? createAgentMailClient(params.account);

  return {
    run: async ({ receive, abortSignal, sinceBaseline }) => {
      const storedCursor = normalizeCursor(await store.lookup(key));
      if (!storedCursor) {
        throw new Error("AgentMail WebSocket catch-up cursor is unavailable");
      }
      const runAtMs = now();
      const scanUpperBoundAtMs = runAtMs;
      const effectiveHighWaterAtMs = Math.min(storedCursor.highWaterAtMs, runAtMs);
      // Never scan below the dedupe horizon on ANY sweep. Completed-message tombstones expire after
      // AGENTMAIL_DURABLE_COMPLETED_TTL_MS; once they do, a message still in scan range would be
      // re-admitted as a duplicate turn. The floor is applied to the normal high-water sweep too:
      // an idle inbox's high-water stops advancing, so without it the same pre-horizon messages
      // would become eligible again after their tombstones expire.
      //
      // The deep sweep lists from max(baseline, dedupeFloor): it recovers back-dated mail within the
      // dedupe window and since monitoring began, but deliberately does not scan before the baseline,
      // which would re-inject pre-monitoring history that has no tombstone protection.
      const dedupeFloorMs = runAtMs - AGENTMAIL_DURABLE_COMPLETED_TTL_MS;
      const baseAfterMs =
        sinceBaseline || !storedCursor.established
          ? storedCursor.baselineAtMs
          : effectiveHighWaterAtMs - AGENTMAIL_REST_CATCH_UP_OVERLAP_MS;
      const afterMs = Math.max(0, baseAfterMs, dedupeFloorMs);
      let highWaterAtMs = effectiveHighWaterAtMs;
      let pageCursor: string | undefined;
      let admitted = 0;
      do {
        const page = await client.inboxes.messages.list(
          params.account.inboxId,
          {
            limit: PAGE_LIMIT,
            ...(pageCursor ? { pageToken: pageCursor } : {}),
            labels: [AGENTMAIL_RECEIVED_LABEL],
            after: new Date(afterMs),
            // Do not repeatedly scan provider-clock-skewed future messages. Add one millisecond so
            // an exclusive provider bound includes messages stamped exactly at runAtMs and so a
            // fresh cursor never sends identical after/before values.
            before: new Date(scanUpperBoundAtMs + 1),
            ascending: true,
            includeSpam: false,
            includeBlocked: false,
            includeUnauthenticated: false,
            includeTrash: false,
          },
          { abortSignal },
        );
        let pageAdvanced = false;
        for (const message of page.messages) {
          if (abortSignal.aborted) {
            return;
          }
          if (!isReceivedAgentMailMessage(message, params.account.inboxId)) {
            continue;
          }
          // Invalid provider time must not turn a missed live event into a permanent drop. Admit
          // with local observation time; durable message-id dedupe keeps overlap scans safe.
          const rawProviderTimestampMs = resolveReceivedAgentMailMessageTimestampMs(
            message,
            params.account.inboxId,
          );
          if (
            rawProviderTimestampMs !== null &&
            !isAgentMailProviderTimestampWithinFutureSkew(
              rawProviderTimestampMs,
              scanUpperBoundAtMs,
            )
          ) {
            params.log?.warn?.(
              `AgentMail catch-up ignored message ${message.messageId} timestamped too far in the future`,
            );
            continue;
          }
          const providerTimestampMs = rawProviderTimestampMs;
          const admissionTimestampMs = providerTimestampMs ?? scanUpperBoundAtMs;
          try {
            await receive({
              accountId: params.account.accountId,
              inboxId: params.account.inboxId,
              messageId: message.messageId,
              transport: "rest",
              receivedAt: admissionTimestampMs,
              arrivedAt: now(),
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
          // Local observation time makes an invalid provider timestamp admissible, but it is not
          // evidence that every older provider message has been indexed. Only real provider time
          // may advance the REST scan cursor.
          if (providerTimestampMs !== null) {
            highWaterAtMs = Math.max(
              highWaterAtMs,
              Math.min(providerTimestampMs, scanUpperBoundAtMs),
            );
            pageAdvanced = true;
          }
        }
        if (pageAdvanced) {
          // Persist once per page. If admission fails mid-page, the cursor stays behind the page
          // and durable message-id dedupe safely absorbs the repeated prefix on the next pass.
          await persistCursor({
            store,
            key,
            baselineAtMs: storedCursor.baselineAtMs,
            highWaterAtMs,
            upperBoundAtMs: scanUpperBoundAtMs,
            established: false,
          });
        }
        pageCursor = page.nextPageToken;
      } while (pageCursor && !abortSignal.aborted);

      if (abortSignal.aborted) {
        return;
      }
      await persistCursor({
        store,
        key,
        baselineAtMs: storedCursor.baselineAtMs,
        highWaterAtMs,
        upperBoundAtMs: scanUpperBoundAtMs,
        established: true,
      });
      if (admitted > 0) {
        params.log?.info?.(
          `AgentMail WebSocket catch-up admitted ${admitted} message${admitted === 1 ? "" : "s"} for account ${params.account.accountId}`,
        );
      }
    },
  };
}
