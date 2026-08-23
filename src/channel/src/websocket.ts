import type { AgentMail, AgentMailClient } from "agentmail";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import {
  createAgentMailCatchUpSession,
  createAgentMailCatchUpSupervisor,
  startAgentMailPeriodicCatchUp,
  type AgentMailCatchUpSession,
} from "./catch-up.js";
import { type AgentMailLog, errorText } from "./log.js";
import { createAgentMailClient } from "./client.js";
import { AgentMailIngressCapacityError } from "./ingress.js";
import { createBackoff, waitForRetry } from "./retry.js";
import {
  agentMailInboxIdsEqual,
  resolveAgentMailTimestampMs,
} from "./received-message.js";
import type { AgentMailIngressRecord, ResolvedAgentMailAccount } from "./types.js";

const AGENTMAIL_WEBSOCKET_LIVE_QUEUE_MAX = 32;
const AGENTMAIL_WEBSOCKET_STABLE_CONNECTION_MS = 30_000;
// A single record must not pin the one bounded live worker forever. After this many failed durable
// admissions, hand the record to REST catch-up (which retains the provider-side source) so later
// live events keep advancing.
const AGENTMAIL_WEBSOCKET_MAX_RECORD_ATTEMPTS = 8;

function isReceivedEvent(value: unknown): value is AgentMail.MessageReceivedEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const event = value as Partial<AgentMail.MessageReceivedEvent>;
  if (event.type !== "event" || event.eventType !== "message.received") {
    return false;
  }
  // Validate the stable identifier shape here. The shared received-message predicate below owns
  // inbox, label, and timestamp validation for both WebSocket and REST recovery.
  const message = event.message as Partial<AgentMail.Message> | undefined;
  return Boolean(
    message &&
      typeof message.inboxId === "string" &&
      typeof message.messageId === "string",
  );
}

const websocketRetryDelayMs = createBackoff(30_000);

async function receiveUntilDurable(params: {
  record: AgentMailIngressRecord;
  receive: (record: AgentMailIngressRecord) => Promise<void>;
  abortSignal: AbortSignal;
  retryDelay: (attempt: number) => number;
  deferToRestRecovery: () => void;
  maxAttempts: number;
  log?: AgentMailLog;
}): Promise<void> {
  let attempts = 0;
  while (!params.abortSignal.aborted) {
    try {
      await params.receive(params.record);
      return;
    } catch (error) {
      if (error instanceof AgentMailIngressCapacityError) {
        // Do not pin the single bounded live worker behind a full durable queue. REST catch-up
        // retains the provider-side source and retries once durable capacity becomes available.
        params.log?.warn?.(
          "AgentMail durable ingress is full; deferring the message to REST catch-up",
        );
        params.deferToRestRecovery();
        return;
      }
      attempts += 1;
      params.log?.error?.(
        `AgentMail WebSocket durable ingress failed; retrying: ${errorText(error)}`,
      );
      if (attempts >= params.maxAttempts) {
        // A persistent storage/serialization fault would otherwise block every later live event
        // behind this one record. Hand it to REST catch-up and let the worker advance.
        params.log?.error?.(
          "AgentMail WebSocket record exceeded its retry budget; deferring to REST catch-up",
        );
        params.deferToRestRecovery();
        return;
      }
      if (!(await waitForRetry(params.abortSignal, params.retryDelay(attempts)))) {
        return;
      }
    }
  }
}

export async function startAgentMailWebSocket(params: {
  account: ResolvedAgentMailAccount;
  abortSignal: AbortSignal;
  receive: (record: AgentMailIngressRecord) => Promise<void>;
  log?: AgentMailLog;
  retryDelayMs?: (attempt: number) => number;
  reconnectDelayMs?: (attempt: number) => number;
  catchUpSession?: AgentMailCatchUpSession;
  liveQueueMax?: number;
  catchUpIntervalMs?: number;
  deepSweepIntervalMs?: number;
  client?: AgentMailClient;
  now?: () => number;
}): Promise<void> {
  const client = params.client ?? createAgentMailClient(params.account);
  const catchUpSession =
    params.catchUpSession ??
    (await createAgentMailCatchUpSession({
      account: params.account,
      client,
      log: params.log,
    }));
  const retryDelay = params.retryDelayMs ?? websocketRetryDelayMs;
  const reconnectDelay = params.reconnectDelayMs ?? retryDelay;
  const liveQueueMax = params.liveQueueMax ?? AGENTMAIL_WEBSOCKET_LIVE_QUEUE_MAX;
  const now = params.now ?? Date.now;
  const liveQueue: AgentMailIngressRecord[] = [];
  const queuedMessageIds = new Set<string>();
  let liveWorker: Promise<void> | undefined;
  const catchUpSupervisor = createAgentMailCatchUpSupervisor({
    session: catchUpSession,
    receive: params.receive,
    abortSignal: params.abortSignal,
    retryDelayMs: retryDelay,
    log: params.log,
  });
  // The SDK protocol has no replay cursor; these timers also cover half-open sockets that emit
  // neither a close event nor new messages.
  const [periodicCatchUpWorker, deepSweepWorker] = startAgentMailPeriodicCatchUp({
    supervisor: catchUpSupervisor,
    abortSignal: params.abortSignal,
    catchUpIntervalMs: params.catchUpIntervalMs,
    deepSweepIntervalMs: params.deepSweepIntervalMs,
  });

  const runLiveWorker = (): void => {
    if (liveWorker) {
      return;
    }
    liveWorker = (async () => {
      while (!params.abortSignal.aborted) {
        const record = liveQueue.shift();
        if (!record) {
          return;
        }
        try {
          await receiveUntilDurable({
            record,
            receive: params.receive,
            abortSignal: params.abortSignal,
            retryDelay,
            deferToRestRecovery: () => catchUpSupervisor.request(),
            maxAttempts: AGENTMAIL_WEBSOCKET_MAX_RECORD_ATTEMPTS,
            log: params.log,
          });
        } finally {
          queuedMessageIds.delete(record.messageId);
        }
      }
    })().finally(() => {
      liveWorker = undefined;
      if (liveQueue.length > 0 && !params.abortSignal.aborted) {
        runLiveWorker();
      }
    });
  };

  const handleMessage = (event: unknown): boolean => {
    if (!isReceivedEvent(event)) {
      return false;
    }
    if (!agentMailInboxIdsEqual(event.message.inboxId, params.account.inboxId)) {
      params.log?.warn?.("AgentMail WebSocket ignored an event for the wrong inbox");
      return false;
    }
    // The event type itself is authoritative for live receipt. Provider label projection can lag
    // the WebSocket frame; durable hydration already retries that condition safely.
    const messageTimestampMs = resolveAgentMailTimestampMs(event.message.timestamp);
    if (messageTimestampMs === null) {
      params.log?.warn?.("AgentMail WebSocket received an event with an invalid timestamp");
      catchUpSupervisor.request();
      return false;
    }
    if (queuedMessageIds.has(event.message.messageId)) {
      return true;
    }
    if (queuedMessageIds.size >= liveQueueMax) {
      // Keep the process-local backlog bounded. REST catch-up remains the authoritative recovery
      // source for events dropped while durable admission is backpressured.
      params.log?.warn?.("AgentMail WebSocket live admission is full; scheduling REST catch-up");
      catchUpSupervisor.request();
      return true;
    }
    queuedMessageIds.add(event.message.messageId);
    liveQueue.push({
      accountId: params.account.accountId,
      inboxId: params.account.inboxId,
      messageId: event.message.messageId,
      transport: "websocket",
      receivedAt: messageTimestampMs,
      arrivedAt: Date.now(),
    });
    runLiveWorker();
    return true;
  };

  // Own reconnection. The pinned agentmail@0.5.16 can synthesize a normal close, disable its
  // internal reconnect, and turn a later reconnect into a no-op, leaving only periodic REST polling
  // until process restart. Instead, disable the SDK reconnect and recreate the socket ourselves on
  // every close until aborted, re-subscribing and overlapping REST on each fresh connection.
  //
  // One shared abort promise for the whole loop: abort is terminal, so attaching a fresh listener
  // per reconnect would leak closures on the long-lived signal (listener-limit warnings under churn).
  const aborted = waitUntilAbort(params.abortSignal);
  const connectionLoop = (async () => {
    let reconnectAttempt = 0;
    while (!params.abortSignal.aborted) {
      let socket: Awaited<ReturnType<(typeof client)["websockets"]["connect"]>>;
      try {
        socket = await client.websockets.connect({
          apiKey: params.account.apiKey,
          abortSignal: params.abortSignal,
          reconnectAttempts: 0,
          // agentmail@0.5.16 waits only for open/error by default; an abort closes the socket and
          // would otherwise leave connect() pending before lifecycle handlers are registered.
          waitForOpen: false,
        });
      } catch (error) {
        params.log?.error?.(
          `AgentMail WebSocket connect failed for account ${params.account.accountId}: ${errorText(error)}`,
        );
        // REST catch-up remains the authoritative recovery source while the socket is down.
        catchUpSupervisor.request();
        if (!(await waitForRetry(params.abortSignal, reconnectDelay(++reconnectAttempt)))) {
          return;
        }
        continue;
      }
      let subscribedForCurrentConnection = false;
      let subscribedAtMs: number | undefined;
      const subscribe = () => {
        if (subscribedForCurrentConnection) {
          return;
        }
        socket.sendSubscribe({
          type: "subscribe",
          inboxIds: [params.account.inboxId],
          eventTypes: ["message.received"],
        });
        subscribedForCurrentConnection = true;
        subscribedAtMs = now();
        params.log?.info?.(
          `AgentMail WebSocket subscribed for account ${params.account.accountId}`,
        );
        // Subscribe first, then overlap the persisted REST cursor. Live and catch-up events share
        // the same durable id, closing restart/reconnect gaps without creating duplicate turns.
        catchUpSupervisor.request();
      };
      const closed = new Promise<void>((resolve) => {
        let settled = false;
        const settleClosed = () => {
          if (settled) {
            return;
          }
          settled = true;
          subscribedForCurrentConnection = false;
          resolve();
        };
        socket.on("open", () => {
          subscribe();
        });
        socket.on("close", settleClosed);
        socket.on("error", (error) => {
          params.log?.error?.(
            `AgentMail WebSocket error for account ${params.account.accountId}: ${errorText(error)}`,
          );
          // Parsing/transport errors may not close the socket. Recover authoritative events even
          // when the socket stays connected and emits no close.
          catchUpSupervisor.request();
          // Fatal socket errors do not always emit a later close. Treat either event as terminal
          // for this connection so the outer loop recreates it.
          settleClosed();
        });
        socket.on("message", (event) => {
          handleMessage(event);
        });
      });
      // waitForOpen() does not settle on an aborted initial connection; close the already-open race
      // from readyState instead.
      if (socket.readyState === 1) {
        subscribe();
      }
      await Promise.race([closed, aborted]);
      socket.close();
      if (params.abortSignal.aborted) {
        return;
      }
      // An `open` event alone does not prove a healthy connection: resetting there turns repeated
      // open/close flaps into a zero-attempt reconnect loop. Reset only after the socket remained
      // subscribed for a meaningful interval.
      if (
        subscribedAtMs !== undefined &&
        now() - subscribedAtMs >= AGENTMAIL_WEBSOCKET_STABLE_CONNECTION_MS
      ) {
        reconnectAttempt = 0;
      }
      // Unexpected close: reconnect after a bounded backoff. REST catch-up covers the gap.
      params.log?.warn?.(
        `AgentMail WebSocket closed for account ${params.account.accountId}; reconnecting`,
      );
      catchUpSupervisor.request();
      if (!(await waitForRetry(params.abortSignal, reconnectDelay(++reconnectAttempt)))) {
        return;
      }
    }
  })();

  await connectionLoop;
  const workers = [
    liveWorker,
    periodicCatchUpWorker,
    deepSweepWorker,
    catchUpSupervisor.settle(),
  ].filter((worker): worker is Promise<void> => worker !== undefined);
  await Promise.allSettled(workers);
}
