import type { AgentMail, AgentMailClient } from "agentmail";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { type AgentMailLog, errorText } from "./log.js";
import { createAgentMailClient } from "./client.js";
import { sha256Hex } from "./digest.js";
import {
  AGENTMAIL_DURABLE_PENDING_TTL_MS,
  AgentMailIngressCapacityError,
} from "./durable-receive.js";
import { AGENTMAIL_RECEIVED_LABEL } from "./inbound.js";
import { createBackoff, waitForRetry } from "./retry.js";
import { getAgentMailRuntime } from "./runtime.js";
import type { AgentMailIngressRecord, ResolvedAgentMailAccount } from "./types.js";

const CURSOR_VERSION = 1;
const PAGE_LIMIT = 100;

export const AGENTMAIL_REST_CATCH_UP_NAMESPACE = "agentmail.rest-catch-up";
export const AGENTMAIL_REST_CATCH_UP_LEGACY_MAX_ACCOUNTS = 1_000;
export const AGENTMAIL_REST_CATCH_UP_MAX_ENTRIES_PER_ACCOUNT = 1;
export const AGENTMAIL_REST_CATCH_UP_CURSOR_TTL_MS = 90 * 24 * 60 * 60 * 1000;
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

function cursorNamespace(account: ResolvedAgentMailAccount): string {
  // Namespace by account rather than inbox so rotation reuses the bounded store and evicts the old
  // inbox cursor. The hash keeps operator-provided account ids out of state paths.
  return `${AGENTMAIL_REST_CATCH_UP_NAMESPACE}.${sha256Hex(account.accountId)}`;
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

function isReceivedMessage(message: AgentMail.MessageItem, inboxId: string): boolean {
  return (
    message.inboxId === inboxId &&
    (Array.isArray(message.labels) ? message.labels : []).some(
      (label) => String(label).toLocaleLowerCase("en-US") === AGENTMAIL_RECEIVED_LABEL,
    )
  );
}

async function persistCursor(params: {
  store: PluginStateKeyedStore<AgentMailCatchUpCursor>;
  key: string;
  baselineAtMs: number;
  highWaterAtMs: number;
  established: boolean;
}): Promise<void> {
  const update = params.store.update;
  if (update) {
    await update(
      params.key,
      (currentValue) => {
        const current = normalizeCursor(currentValue);
        return {
          version: CURSOR_VERSION,
          baselineAtMs: current?.baselineAtMs ?? params.baselineAtMs,
          highWaterAtMs: Math.max(current?.highWaterAtMs ?? 0, params.highWaterAtMs),
          established: current?.established === true || params.established,
        };
      },
      { ttlMs: AGENTMAIL_REST_CATCH_UP_CURSOR_TTL_MS },
    );
    return;
  }
  const current = normalizeCursor(await params.store.lookup(params.key));
  await params.store.register(
    params.key,
    {
      version: CURSOR_VERSION,
      baselineAtMs: current?.baselineAtMs ?? params.baselineAtMs,
      highWaterAtMs: Math.max(current?.highWaterAtMs ?? 0, params.highWaterAtMs),
      established: current?.established === true || params.established,
    },
    { ttlMs: AGENTMAIL_REST_CATCH_UP_CURSOR_TTL_MS },
  );
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
      // Isolate each account in its own one-entry namespace. Inbox rotation evicts the prior cursor,
      // while inactive rows expire instead of accumulating forever.
      namespace: cursorNamespace(params.account),
      maxEntries: AGENTMAIL_REST_CATCH_UP_MAX_ENTRIES_PER_ACCOUNT,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: AGENTMAIL_REST_CATCH_UP_CURSOR_TTL_MS,
    });
    store = accountStore;
    if (!normalizeCursor(await accountStore.lookup(key))) {
      const migrateFrom = async (
        source: PluginStateKeyedStore<AgentMailCatchUpCursor>,
      ): Promise<boolean> => {
        const previousCursor = normalizeCursor(await source.lookup(key));
        if (!previousCursor) {
          return false;
        }
        await accountStore.registerIfAbsent(key, previousCursor, {
          ttlMs: AGENTMAIL_REST_CATCH_UP_CURSOR_TTL_MS,
        });
        if (normalizeCursor(await accountStore.lookup(key))) {
          try {
            await source.delete(key);
          } catch (error) {
            params.log?.warn?.(
              `AgentMail could not remove a migrated catch-up cursor: ${errorText(error)}`,
            );
          }
          return true;
        }
        return false;
      };
      // Upgrade migration: first check the short-lived per-inbox namespace used by early builds of
      // this PR, then the original shared namespace. Copy before creating a fresh baseline so mail
      // received between shutdown and upgraded startup remains inside the recovery window.
      const previousAccountStore = state.openKeyedStore<AgentMailCatchUpCursor>({
        namespace: `${AGENTMAIL_REST_CATCH_UP_NAMESPACE}.${key}`,
        maxEntries: AGENTMAIL_REST_CATCH_UP_MAX_ENTRIES_PER_ACCOUNT,
        overflowPolicy: "reject-new",
      });
      if (!(await migrateFrom(previousAccountStore))) {
        const legacyStore = state.openKeyedStore<AgentMailCatchUpCursor>({
          namespace: AGENTMAIL_REST_CATCH_UP_NAMESPACE,
          maxEntries: AGENTMAIL_REST_CATCH_UP_LEGACY_MAX_ACCOUNTS,
          overflowPolicy: "reject-new",
        });
        await migrateFrom(legacyStore);
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
  const client = params.client ?? createAgentMailClient(params.account);

  return {
    run: async ({ receive, abortSignal, sinceBaseline }) => {
      const storedCursor = normalizeCursor(await store.lookup(key));
      if (!storedCursor) {
        throw new Error("AgentMail WebSocket catch-up cursor is unavailable");
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
      const recoveryFloorMs = now() - AGENTMAIL_DURABLE_PENDING_TTL_MS;
      const baseAfterMs =
        sinceBaseline || !storedCursor.established
          ? storedCursor.baselineAtMs
          : storedCursor.highWaterAtMs - AGENTMAIL_REST_CATCH_UP_OVERLAP_MS;
      const afterMs = Math.max(0, baseAfterMs, recoveryFloorMs);
      let highWaterAtMs = storedCursor.highWaterAtMs;
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
          if (!isReceivedMessage(message, params.account.inboxId)) {
            continue;
          }
          const receivedAt =
            message.timestamp instanceof Date ? message.timestamp.getTime() : Number.NaN;
          if (!Number.isFinite(receivedAt) || receivedAt < 0) {
            // A malformed provider row must not poison high-water state with NaN or crash-loop the
            // whole recovery pass. Skip it; a later corrected projection can be admitted normally.
            params.log?.warn?.(
              `AgentMail catch-up ignored message ${message.messageId} with an invalid timestamp`,
            );
            continue;
          }
          try {
            await receive({
              accountId: params.account.accountId,
              inboxId: params.account.inboxId,
              messageId: message.messageId,
              transport: "rest",
              receivedAt,
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
          highWaterAtMs = Math.max(highWaterAtMs, receivedAt);
          pageAdvanced = true;
        }
        if (pageAdvanced) {
          // Persist once per page. If admission fails mid-page, the cursor stays behind the page
          // and durable message-id dedupe safely absorbs the repeated prefix on the next pass.
          await persistCursor({
            store,
            key,
            baselineAtMs: storedCursor.baselineAtMs,
            highWaterAtMs,
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
