import { describe, expect, it, vi } from "vitest";
import { AgentMailIngressCapacityError } from "./ingress.js";
import type { ResolvedAgentMailAccount } from "./types.js";
import { startAgentMailWebSocket } from "./websocket.js";

const handlers = new Map<string, (value?: unknown) => void>();
const sendSubscribe = vi.fn();
const close = vi.fn();
const waitForOpen = vi.fn(async () => undefined);
const catchUpRun = vi.fn(async () => undefined);
const connect = vi.fn(async () => ({
  on: (event: string, handler: (value?: unknown) => void) => handlers.set(event, handler),
  sendSubscribe,
  waitForOpen,
  readyState: 0,
  close,
}));

vi.mock("./client.js", () => ({
  createAgentMailClient: () => ({
    websockets: { connect },
  }),
}));

const account: ResolvedAgentMailAccount = {
  accountId: "default",
  enabled: true,
  apiKey: "key",
  inboxId: "inbox_1",
  webhookSecret: "",
  webhookPath: "/webhooks/agentmail",
  dmPolicy: "allowlist",
  allowFrom: ["sender@example.com"],
  mediaMaxBytes: 20 * 1024 * 1024,
};

describe("AgentMail WebSocket ingress", () => {
  it("re-subscribes on each connection and reconnects itself after a close", async () => {
    handlers.clear();
    sendSubscribe.mockClear();
    close.mockClear();
    connect.mockClear();
    catchUpRun.mockClear();
    const receive = vi.fn(async () => undefined);
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive,
      catchUpSession: { run: catchUpRun },
      reconnectDelayMs: () => 0,
    });
    await vi.waitFor(() => expect(handlers.has("open")).toBe(true));
    // The plugin owns reconnection, so the SDK's own reconnect is disabled.
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ reconnectAttempts: 0, waitForOpen: false }),
    );
    expect(waitForOpen).not.toHaveBeenCalled();
    handlers.get("open")?.();
    await vi.waitFor(() => expect(catchUpRun).toHaveBeenCalled());
    // A close triggers a plugin-managed reconnect (a fresh connect), not an SDK re-open.
    handlers.get("close")?.();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    handlers.get("open")?.();
    await vi.waitFor(() => expect(sendSubscribe).toHaveBeenCalledTimes(2));
    expect(sendSubscribe).toHaveBeenLastCalledWith({
      type: "subscribe",
      inboxIds: ["inbox_1"],
      eventTypes: ["message.received"],
    });

    handlers.get("message")?.({
      type: "event",
      eventType: "message.received",
      eventId: "event_1",
      message: {
        inboxId: "INBOX_1",
        messageId: "message_1",
        labels: ["received"],
        timestamp: new Date(1_234),
      },
    });
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxId: "inbox_1",
        messageId: "message_1",
        transport: "websocket",
        receivedAt: 1_234,
      }),
    );
    controller.abort();
    await running;
    // The first socket is closed on reconnect and the second on abort.
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("does not reset reconnect backoff for open-close flaps", async () => {
    handlers.clear();
    connect.mockClear();
    const reconnectDelay = vi.fn(() => 0);
    let nowMs = 1_000;
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive: vi.fn(async () => undefined),
      catchUpSession: { run: catchUpRun },
      reconnectDelayMs: reconnectDelay,
      now: () => nowMs,
    });

    await vi.waitFor(() => expect(handlers.has("open")).toBe(true));
    handlers.get("open")?.();
    handlers.get("close")?.();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    handlers.get("open")?.();
    handlers.get("close")?.();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
    expect(reconnectDelay.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2]);

    handlers.get("open")?.();
    nowMs += 30_000;
    handlers.get("close")?.();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(4));
    expect(reconnectDelay.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 1]);

    controller.abort();
    await running;
  });

  it("does not reset reconnect backoff for traffic on a short-lived connection", async () => {
    handlers.clear();
    connect.mockClear();
    const reconnectDelay = vi.fn(() => 0);
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive: vi.fn(async () => undefined),
      catchUpSession: { run: catchUpRun },
      reconnectDelayMs: reconnectDelay,
    });

    await vi.waitFor(() => expect(handlers.has("open")).toBe(true));
    handlers.get("open")?.();
    handlers.get("close")?.();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    handlers.get("open")?.();
    handlers.get("message")?.({
      type: "event",
      eventType: "message.received",
      message: {
        inboxId: "inbox_1",
        messageId: "message_productive_socket",
        labels: ["received"],
        timestamp: new Date(1_234),
      },
    });
    handlers.get("close")?.();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(3));

    expect(reconnectDelay.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2]);
    controller.abort();
    await running;
  });

  it("stops cleanly when aborted before the initial socket opens", async () => {
    handlers.clear();
    close.mockClear();
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive: vi.fn(async () => undefined),
      catchUpSession: { run: catchUpRun },
    });
    await vi.waitFor(() => expect(handlers.has("open")).toBe(true));
    controller.abort();
    await expect(running).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(waitForOpen).not.toHaveBeenCalled();
  });

  it("admits far-future sender timestamps with bounded retention", async () => {
    handlers.clear();
    const now = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    const receive = vi.fn(async () => undefined);
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive,
      catchUpSession: { run: catchUpRun },
    });
    try {
      await vi.waitFor(() => expect(handlers.has("message")).toBe(true));
      catchUpRun.mockClear();
      handlers.get("message")?.({
        type: "event",
        eventType: "message.received",
        message: {
          inboxId: "inbox_1",
          messageId: "message_future",
          labels: ["received"],
          timestamp: new Date(now + 365 * 24 * 60 * 60_000),
        },
      });

      await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
      expect(receive).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: "message_future",
          receivedAt: now + 24 * 60 * 60_000,
          arrivedAt: now,
        }),
      );
    } finally {
      controller.abort();
      await running;
      dateNow.mockRestore();
    }
  });

  it("admits invalid sender timestamps using provider creation time", async () => {
    handlers.clear();
    const now = 1_000_000;
    const receive = vi.fn(async () => undefined);
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive,
      catchUpSession: { run: catchUpRun },
      now: () => now,
    });
    await vi.waitFor(() => expect(handlers.has("message")).toBe(true));
    handlers.get("message")?.({
      type: "event",
      eventType: "message.received",
      message: {
        inboxId: "inbox_1",
        messageId: "message_created",
        labels: ["received"],
        timestamp: new Date(Number.NaN),
        createdAt: new Date(900_000),
      },
    });

    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "message_created",
        receivedAt: 900_000,
        arrivedAt: now,
      }),
    );
    controller.abort();
    await running;
  });

  it("durably admits message.received frames before the received label projects", async () => {
    handlers.clear();
    const receive = vi.fn(async () => undefined);
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive,
      catchUpSession: { run: catchUpRun },
    });
    await vi.waitFor(() => expect(handlers.has("message")).toBe(true));
    handlers.get("message")?.({
      type: "event",
      eventType: "message.received",
      message: {
        inboxId: "inbox_1",
        messageId: "message_label_pending",
        labels: [],
        timestamp: new Date(1_234),
      },
    });

    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "message_label_pending",
        transport: "websocket",
        receivedAt: 1_234,
      }),
    );
    controller.abort();
    await running;
  });

  it("retries until a WebSocket event is durably admitted", async () => {
    handlers.clear();
    const receive = vi
      .fn<(record: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce(undefined);
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive: receive as never,
      retryDelayMs: () => 0,
      catchUpSession: { run: catchUpRun },
    });
    await vi.waitFor(() => expect(handlers.has("message")).toBe(true));
    handlers.get("message")?.({
      type: "event",
      eventType: "message.received",
      message: {
        inboxId: "inbox_1",
        messageId: "message_retry",
        labels: ["received"],
        timestamp: new Date(1_234),
      },
    });
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
    controller.abort();
    await running;
  });

  it("bounds live admission and uses REST catch-up for overflow", async () => {
    handlers.clear();
    catchUpRun.mockClear();
    let finishReceive!: () => void;
    const receive = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          finishReceive = resolve;
        }),
    );
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive,
      catchUpSession: { run: catchUpRun },
      liveQueueMax: 1,
    });
    await vi.waitFor(() => expect(handlers.has("message")).toBe(true));
    handlers.get("message")?.({
      type: "event",
      eventType: "message.received",
      message: {
        inboxId: "inbox_1",
        messageId: "message_1",
        labels: ["received"],
        timestamp: new Date(1_234),
      },
    });
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    handlers.get("message")?.({
      type: "event",
      eventType: "message.received",
      message: {
        inboxId: "inbox_1",
        messageId: "message_2",
        labels: ["received"],
        timestamp: new Date(1_235),
      },
    });
    await vi.waitFor(() => expect(catchUpRun).toHaveBeenCalledOnce());
    expect(receive).toHaveBeenCalledOnce();

    finishReceive();
    controller.abort();
    await running;
  });

  it("defers capacity-blocked events to REST catch-up without pinning the live worker", async () => {
    handlers.clear();
    catchUpRun.mockClear();
    const receive = vi
      .fn<(record: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new AgentMailIngressCapacityError())
      .mockResolvedValueOnce(undefined);
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive: receive as never,
      retryDelayMs: () => 0,
      catchUpSession: { run: catchUpRun },
      liveQueueMax: 2,
    });
    await vi.waitFor(() => expect(handlers.has("message")).toBe(true));
    handlers.get("message")?.({
      type: "event",
      eventType: "message.received",
      message: {
        inboxId: "inbox_1",
        messageId: "message_full",
        labels: ["received"],
        timestamp: new Date(1_234),
      },
    });
    handlers.get("message")?.({
      type: "event",
      eventType: "message.received",
      message: {
        inboxId: "inbox_1",
        messageId: "message_next",
        labels: ["received"],
        timestamp: new Date(1_235),
      },
    });

    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(catchUpRun).toHaveBeenCalledOnce());
    controller.abort();
    await running;
  });

  it("runs periodic REST catch-up even without a socket lifecycle event", async () => {
    handlers.clear();
    catchUpRun.mockClear();
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive: vi.fn(async () => undefined),
      catchUpSession: { run: catchUpRun },
      catchUpIntervalMs: 1,
    });
    await vi.waitFor(() => expect(catchUpRun).toHaveBeenCalled());
    controller.abort();
    await running;
  });

  it("reconnects after an SDK error even when no close event follows", async () => {
    handlers.clear();
    catchUpRun.mockClear();
    connect.mockClear();
    close.mockClear();
    const error = vi.fn();
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive: vi.fn(async () => undefined),
      catchUpSession: { run: catchUpRun },
      reconnectDelayMs: () => 0,
      log: { error },
    });
    await vi.waitFor(() => expect(handlers.has("error")).toBe(true));

    handlers.get("error")?.(new Error("frame parse failed"));

    await vi.waitFor(() => expect(catchUpRun).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(error).toHaveBeenCalledWith(
      "AgentMail WebSocket error for account default: frame parse failed",
    );
    controller.abort();
    await running;
  });

  it("keeps a healthy quiet socket open without application messages", async () => {
    handlers.clear();
    catchUpRun.mockClear();
    connect.mockClear();
    close.mockClear();
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      const running = startAgentMailWebSocket({
        account,
        abortSignal: controller.signal,
        receive: vi.fn(async () => undefined),
        catchUpSession: { run: catchUpRun },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(handlers.has("open")).toBe(true);
      handlers.get("open")?.();

      // The SDK exposes no heartbeat/liveness probe through this facade. Silence is healthy; the
      // periodic REST sweep covers missed delivery without forcing a reconnect storm.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(connect).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();

      controller.abort();
      await running;
      expect(close).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
      vi.useRealTimers();
    }
  });
});
