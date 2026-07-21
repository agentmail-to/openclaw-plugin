import type { AgentMail } from "agentmail";
import type {
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  AGENTMAIL_REST_CATCH_UP_OVERLAP_MS,
  createAgentMailCatchUpSession,
  createAgentMailCatchUpSupervisor,
} from "./catch-up.js";
import type { AgentMailIngressRecord, ResolvedAgentMailAccount } from "./types.js";

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

function memoryStore<T>(): PluginStateKeyedStore<T> {
  const values = new Map<string, PluginStateEntry<T>>();
  return {
    async register(key, value) {
      values.set(key, { key, value, createdAt: Date.now() });
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, { key, value, createdAt: Date.now() });
      return true;
    },
    async update(key, updateValue) {
      const next = updateValue(values.get(key)?.value);
      if (next === undefined) {
        return false;
      }
      values.set(key, { key, value: next, createdAt: Date.now() });
      return true;
    },
    async lookup(key) {
      return values.get(key)?.value;
    },
    async consume(key) {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.values()];
    },
    async clear() {
      values.clear();
    },
  };
}

function message(params: {
  id: string;
  timestamp: number;
  labels?: string[];
  inboxId?: string;
}): AgentMail.MessageItem {
  return {
    inboxId: params.inboxId ?? "inbox_1",
    threadId: "thread_1",
    messageId: params.id,
    labels: params.labels ?? ["received"],
    timestamp: new Date(params.timestamp),
    from: "sender@example.com",
    to: ["agent@example.com"],
    size: 1,
    updatedAt: new Date(params.timestamp),
    createdAt: new Date(params.timestamp),
  };
}

describe("AgentMail durable REST catch-up", () => {
  it("coalesces recovery requests into one bounded retry supervisor", async () => {
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("queue full"))
      .mockResolvedValueOnce(undefined);
    const controller = new AbortController();
    const supervisor = createAgentMailCatchUpSupervisor({
      session: { run },
      receive: vi.fn(),
      abortSignal: controller.signal,
      retryDelayMs: () => 0,
    });

    supervisor.request();
    supervisor.request();
    await supervisor.settle();
    expect(run).toHaveBeenCalledTimes(2);
    controller.abort();
  });

  it("establishes a fresh baseline, paginates received mail, and persists overlap", async () => {
    const store = memoryStore<never>();
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        count: 2,
        messages: [
          message({ id: "message_1", timestamp: 1_100 }),
          message({ id: "sent_1", timestamp: 1_150, labels: ["sent"] }),
        ],
        nextPageToken: "page_2",
      })
      .mockResolvedValueOnce({
        count: 2,
        messages: [
          message({ id: "message_2", timestamp: 1_200 }),
          message({ id: "wrong_inbox", timestamp: 1_250, inboxId: "inbox_other" }),
        ],
      })
      .mockResolvedValueOnce({
        count: 1,
        messages: [message({ id: "message_3", timestamp: 1_300 })],
      });
    const session = await createAgentMailCatchUpSession({
      account,
      client: { inboxes: { messages: { list } } } as never,
      store: store as never,
      now: () => 1_000,
    });
    const receive = vi.fn<(record: AgentMailIngressRecord) => Promise<void>>(async () => undefined);

    await session.run({ receive, abortSignal: new AbortController().signal });
    expect(receive.mock.calls.map(([record]) => record.messageId)).toEqual([
      "message_1",
      "message_2",
    ]);
    expect(list).toHaveBeenNthCalledWith(
      1,
      "inbox_1",
      expect.objectContaining({
        labels: ["received"],
        after: new Date(1_000),
        ascending: true,
      }),
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    expect(list).toHaveBeenNthCalledWith(
      2,
      "inbox_1",
      expect.objectContaining({ pageToken: "page_2" }),
      expect.any(Object),
    );

    await session.run({ receive, abortSignal: new AbortController().signal });
    expect(list).toHaveBeenNthCalledWith(
      3,
      "inbox_1",
      expect.objectContaining({
        after: new Date(Math.max(0, 1_200 - AGENTMAIL_REST_CATCH_UP_OVERLAP_MS)),
      }),
      expect.any(Object),
    );
    expect(receive).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: "message_3", transport: "rest" }),
    );
  });

  it("does not establish the cursor past a failed durable admission", async () => {
    const store = memoryStore<never>();
    const page = {
      count: 2,
      messages: [
        message({ id: "message_1", timestamp: 2_100 }),
        message({ id: "message_2", timestamp: 2_200 }),
      ],
    };
    const list = vi.fn(async () => page);
    const session = await createAgentMailCatchUpSession({
      account,
      client: { inboxes: { messages: { list } } } as never,
      store: store as never,
      now: () => 2_000,
    });
    const receive = vi.fn(async (record: { messageId: string }) => {
      if (record.messageId === "message_2") {
        throw new Error("queue full");
      }
    });

    await expect(
      session.run({ receive: receive as never, abortSignal: new AbortController().signal }),
    ).rejects.toThrow("queue full");
    await expect(
      session.run({ receive: receive as never, abortSignal: new AbortController().signal }),
    ).rejects.toThrow("queue full");
    expect(list).toHaveBeenNthCalledWith(
      2,
      "inbox_1",
      expect.objectContaining({ after: new Date(2_000) }),
      expect.any(Object),
    );
    expect(receive.mock.calls.map(([record]) => record.messageId)).toEqual([
      "message_1",
      "message_2",
      "message_1",
      "message_2",
    ]);
  });
});
