import type { AgentMail } from "agentmail";
import type {
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  AGENTMAIL_REST_CATCH_UP_CURSOR_TTL_MS,
  AGENTMAIL_REST_CATCH_UP_LEGACY_MAX_ACCOUNTS,
  AGENTMAIL_REST_CATCH_UP_MAX_ENTRIES_PER_ACCOUNT,
  AGENTMAIL_REST_CATCH_UP_NAMESPACE,
  AGENTMAIL_REST_CATCH_UP_OVERLAP_MS,
  type AgentMailCatchUpCursor,
  createAgentMailCatchUpSession,
  createAgentMailCatchUpSupervisor,
} from "./catch-up.js";
import { sha256Hex } from "./digest.js";
import {
  AGENTMAIL_DURABLE_PENDING_TTL_MS,
  AgentMailIngressCapacityError,
} from "./durable-receive.js";
import { AGENTMAIL_PROVIDER_FUTURE_SKEW_MAX_MS } from "./received-message.js";
import type { AgentMailIngressRecord, ResolvedAgentMailAccount } from "./types.js";

const openKeyedStore = vi.hoisted(() => vi.fn());
vi.mock("./runtime.js", () => ({
  getAgentMailRuntime: () => ({ state: { openKeyedStore } }),
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

function memoryStore<T>(maxEntries = Number.POSITIVE_INFINITY): PluginStateKeyedStore<T> {
  const values = new Map<string, PluginStateEntry<T>>();
  const setValue = (key: string, value: T) => {
    if (!values.has(key) && values.size >= maxEntries) {
      const oldestKey = values.keys().next().value;
      if (oldestKey !== undefined) {
        values.delete(oldestKey);
      }
    }
    values.set(key, { key, value, createdAt: Date.now() });
  };
  return {
    async register(key, value) {
      setValue(key, value);
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      setValue(key, value);
      return true;
    },
    async update(key, updateValue) {
      const next = updateValue(values.get(key)?.value);
      if (next === undefined) {
        return false;
      }
      setValue(key, next);
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
  it("isolates each account cursor in a one-entry state namespace", async () => {
    openKeyedStore.mockReset();
    const legacyStore = memoryStore();
    openKeyedStore.mockImplementation(({ namespace }) =>
      namespace === AGENTMAIL_REST_CATCH_UP_NAMESPACE ? legacyStore : memoryStore(),
    );
    const client = { inboxes: { messages: { list: vi.fn() } } } as never;

    await createAgentMailCatchUpSession({ account, client, now: () => 1_000 });
    await createAgentMailCatchUpSession({
      account: { ...account, accountId: "support", inboxId: "inbox_2" },
      client,
      now: () => 1_000,
    });

    expect(openKeyedStore).toHaveBeenCalledTimes(4);
    const options = openKeyedStore.mock.calls.map(([value]) => value);
    const accountOptions = options.filter(
      ({ overflowPolicy }) => overflowPolicy === "evict-oldest",
    );
    expect(accountOptions).toHaveLength(2);
    expect(accountOptions[0]).toMatchObject({
      maxEntries: AGENTMAIL_REST_CATCH_UP_MAX_ENTRIES_PER_ACCOUNT,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: AGENTMAIL_REST_CATCH_UP_CURSOR_TTL_MS,
    });
    expect(accountOptions[0].namespace).toMatch(
      new RegExp(`^${AGENTMAIL_REST_CATCH_UP_NAMESPACE}\\.`),
    );
    expect(accountOptions[1].namespace).not.toBe(accountOptions[0].namespace);
  });

  it("reuses an account namespace when its inbox rotates", async () => {
    openKeyedStore.mockReset();
    const stores = new Map<string, PluginStateKeyedStore<unknown>>();
    openKeyedStore.mockImplementation(({ namespace }) => {
      const existing = stores.get(namespace);
      if (existing) {
        return existing;
      }
      const created = memoryStore();
      stores.set(namespace, created);
      return created;
    });
    const client = { inboxes: { messages: { list: vi.fn() } } } as never;

    await createAgentMailCatchUpSession({ account, client, now: () => 1_000 });
    await createAgentMailCatchUpSession({
      account: { ...account, inboxId: "inbox_rotated" },
      client,
      now: () => 2_000,
    });

    const accountNamespaces = openKeyedStore.mock.calls
      .map(([options]) => options)
      .filter(({ overflowPolicy }) => overflowPolicy === "evict-oldest")
      .map(({ namespace }) => namespace);
    expect(accountNamespaces).toHaveLength(2);
    expect(new Set(accountNamespaces).size).toBe(1);
  });

  it("fences an overlapping session after a replacement claims the cursor", async () => {
    const store = memoryStore<AgentMailCatchUpCursor>();
    const list = vi.fn(async () => ({ count: 0, messages: [] }));
    const client = { inboxes: { messages: { list } } } as never;
    const oldSession = await createAgentMailCatchUpSession({
      account,
      client,
      store,
      now: () => 1_000,
    });
    const replacement = await createAgentMailCatchUpSession({
      account,
      client,
      store,
      now: () => 2_000,
    });

    await oldSession.run({ receive: vi.fn(), abortSignal: new AbortController().signal });
    expect(list).not.toHaveBeenCalled();

    await replacement.run({ receive: vi.fn(), abortSignal: new AbortController().signal });
    expect(list).toHaveBeenCalledOnce();
  });

  it("prevents a late old-inbox write from evicting the rotated inbox cursor", async () => {
    const store = memoryStore<AgentMailCatchUpCursor>(1);
    let finishOldPage!: (page: {
      count: number;
      messages: AgentMail.MessageItem[];
    }) => void;
    const oldList = vi.fn(
      async () =>
        await new Promise<{ count: number; messages: AgentMail.MessageItem[] }>((resolve) => {
          finishOldPage = resolve;
        }),
    );
    const oldSession = await createAgentMailCatchUpSession({
      account,
      client: { inboxes: { messages: { list: oldList } } } as never,
      store,
      now: () => 1_000,
    });
    const oldRun = oldSession.run({
      receive: vi.fn(async () => undefined),
      abortSignal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(oldList).toHaveBeenCalledOnce());

    const rotatedAccount = { ...account, inboxId: "inbox_2" };
    const replacementList = vi.fn(async () => ({ count: 0, messages: [] }));
    const replacement = await createAgentMailCatchUpSession({
      account: rotatedAccount,
      client: { inboxes: { messages: { list: replacementList } } } as never,
      store,
      now: () => 2_000,
    });
    finishOldPage({
      count: 1,
      messages: [message({ id: "late_old", timestamp: 1_500 })],
    });
    await oldRun;

    await expect(
      replacement.run({
        receive: vi.fn(),
        abortSignal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();
    expect(replacementList).toHaveBeenCalledOnce();
    expect((await store.entries()).map((entry) => entry.key)).toEqual([
      sha256Hex("default\ninbox_2"),
    ]);
  });

  it("migrates a legacy shared cursor before establishing a new baseline", async () => {
    openKeyedStore.mockReset();
    const legacyStore = memoryStore<AgentMailCatchUpCursor>();
    const accountStore = memoryStore<AgentMailCatchUpCursor>();
    const legacyCursor: AgentMailCatchUpCursor = {
      version: 1,
      baselineAtMs: 500,
      highWaterAtMs: 900,
      established: true,
    };
    await legacyStore.register(sha256Hex("default\ninbox_1"), legacyCursor);
    legacyStore.delete = vi.fn(async () => true);
    openKeyedStore.mockImplementation(({ namespace }) =>
      namespace === AGENTMAIL_REST_CATCH_UP_NAMESPACE ? legacyStore : accountStore,
    );
    const list = vi.fn(async () => ({ count: 0, messages: [] }));

    const session = await createAgentMailCatchUpSession({
      account,
      client: { inboxes: { messages: { list } } } as never,
      now: () => 10_000,
    });
    await session.run({
      receive: vi.fn(),
      abortSignal: new AbortController().signal,
    });

    expect(list).toHaveBeenCalledWith(
      "inbox_1",
      expect.objectContaining({
        after: new Date(Math.max(0, 900 - AGENTMAIL_REST_CATCH_UP_OVERLAP_MS)),
      }),
      expect.any(Object),
    );
    expect(legacyStore.delete).toHaveBeenCalledOnce();
    expect(openKeyedStore).toHaveBeenCalledWith({
      namespace: AGENTMAIL_REST_CATCH_UP_NAMESPACE,
      maxEntries: AGENTMAIL_REST_CATCH_UP_LEGACY_MAX_ACCOUNTS,
      overflowPolicy: "reject-new",
    });
  });

  it("retries legacy cursor cleanup after a transient delete failure", async () => {
    openKeyedStore.mockReset();
    const key = sha256Hex("default\ninbox_1");
    const legacyStore = memoryStore<AgentMailCatchUpCursor>();
    const accountStore = memoryStore<AgentMailCatchUpCursor>();
    await legacyStore.register(key, {
      version: 1,
      baselineAtMs: 500,
      highWaterAtMs: 900,
      established: true,
    });
    const deleteLegacy = legacyStore.delete.bind(legacyStore);
    legacyStore.delete = vi
      .fn<(key: string) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("database busy"))
      .mockImplementation(deleteLegacy);
    openKeyedStore.mockImplementation(({ namespace }) =>
      namespace === AGENTMAIL_REST_CATCH_UP_NAMESPACE ? legacyStore : accountStore,
    );
    const warn = vi.fn();
    const client = { inboxes: { messages: { list: vi.fn() } } } as never;

    await createAgentMailCatchUpSession({ account, client, now: () => 10_000, log: { warn } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not remove"));
    expect(await legacyStore.lookup(key)).toBeDefined();

    await createAgentMailCatchUpSession({ account, client, now: () => 11_000, log: { warn } });
    expect(legacyStore.delete).toHaveBeenCalledTimes(2);
    expect(await legacyStore.lookup(key)).toBeUndefined();
  });

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
          message({ id: "message_1", timestamp: 1_100, inboxId: "INBOX_1" }),
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

  it("admits malformed timestamps using provider creation time", async () => {
    const store = memoryStore<never>();
    const malformed = message({ id: "bad_timestamp", timestamp: 1_100 }) as AgentMail.MessageItem;
    (malformed as { timestamp: unknown }).timestamp = new Date(Number.NaN);
    const list = vi.fn(async () => ({ count: 1, messages: [malformed] }));
    const session = await createAgentMailCatchUpSession({
      account,
      client: { inboxes: { messages: { list } } } as never,
      store: store as never,
      now: () => 1_000,
    });
    const receive = vi.fn(async () => undefined);

    await session.run({ receive, abortSignal: new AbortController().signal });
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "bad_timestamp",
        receivedAt: 1_100,
        arrivedAt: 1_000,
      }),
    );
  });

  it("advances the cursor from an invalid timestamp's fixed sweep fallback", async () => {
    const store = memoryStore<never>();
    const malformed = message({ id: "bad_timestamp", timestamp: 1_100 }) as AgentMail.MessageItem;
    (malformed as { timestamp: unknown }).timestamp = new Date(Number.NaN);
    const list = vi
      .fn()
      .mockResolvedValueOnce({ count: 1, messages: [malformed] })
      .mockResolvedValueOnce({ count: 0, messages: [] });
    let nowMs = 1_000_000;
    const session = await createAgentMailCatchUpSession({
      account,
      client: { inboxes: { messages: { list } } } as never,
      store: store as never,
      now: () => nowMs,
    });
    nowMs = 2_000_000;
    await session.run({
      receive: async () => {
        nowMs = 3_000_000;
      },
      abortSignal: new AbortController().signal,
    });

    await session.run({ receive: vi.fn(), abortSignal: new AbortController().signal });
    expect(list).toHaveBeenLastCalledWith(
      "inbox_1",
      expect.objectContaining({
        after: new Date(2_000_000 - AGENTMAIL_REST_CATCH_UP_OVERLAP_MS),
      }),
      expect.any(Object),
    );
  });

  it("clamps a future message timestamp before advancing the high-water cursor", async () => {
    const store = memoryStore<never>();
    const nowMs = 1_000_000;
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        count: 1,
        messages: [message({ id: "future", timestamp: nowMs + 60 * 60_000 })],
      })
      .mockResolvedValueOnce({ count: 0, messages: [] });
    const session = await createAgentMailCatchUpSession({
      account,
      client: { inboxes: { messages: { list } } } as never,
      store: store as never,
      now: () => nowMs,
    });
    const receive = vi.fn(async () => undefined);

    await session.run({ receive, abortSignal: new AbortController().signal });
    expect(list).toHaveBeenNthCalledWith(
      1,
      "inbox_1",
      expect.objectContaining({
        before: new Date(nowMs + AGENTMAIL_PROVIDER_FUTURE_SKEW_MAX_MS + 1),
      }),
      expect.any(Object),
    );
    await session.run({ receive, abortSignal: new AbortController().signal });
    expect(list).toHaveBeenLastCalledWith(
      "inbox_1",
      expect.objectContaining({
        after: new Date(nowMs - AGENTMAIL_REST_CATCH_UP_OVERLAP_MS),
      }),
      expect.any(Object),
    );
  });

  it("repairs future cursor bounds when the clock moves backward", async () => {
    const store = memoryStore<AgentMailCatchUpCursor>();
    const key = sha256Hex("default\ninbox_1");
    await store.register(key, {
      version: 1,
      baselineAtMs: 2_000_000,
      highWaterAtMs: 3_000_000,
      established: true,
    });
    const list = vi.fn(async () => ({ count: 0, messages: [] }));
    const session = await createAgentMailCatchUpSession({
      account,
      client: { inboxes: { messages: { list } } } as never,
      store,
      now: () => 1_000_000,
    });

    await session.run({
      receive: vi.fn(),
      abortSignal: new AbortController().signal,
      sinceBaseline: true,
    });

    expect(list).toHaveBeenCalledWith(
      "inbox_1",
      expect.objectContaining({ after: new Date(1_000_000) }),
      expect.any(Object),
    );
    expect(await store.lookup(key)).toMatchObject({
      baselineAtMs: 1_000_000,
      highWaterAtMs: 1_000_000,
      established: true,
    });
  });

  it("does not invert baseline catch-up bounds when the clock moves backward", async () => {
    const store = memoryStore<never>();
    const list = vi.fn(async () => ({ count: 0, messages: [] }));
    let nowMs = 2_000_000;
    const session = await createAgentMailCatchUpSession({
      account,
      client: { inboxes: { messages: { list } } } as never,
      store: store as never,
      now: () => nowMs,
    });
    nowMs = 1_000_000;

    await session.run({ receive: vi.fn(), abortSignal: new AbortController().signal });
    await session.run({
      receive: vi.fn(),
      abortSignal: new AbortController().signal,
      sinceBaseline: true,
    });

    for (const [, query] of list.mock.calls) {
      expect(query).toEqual(
        expect.objectContaining({
          after: new Date(nowMs),
          before: new Date(nowMs + AGENTMAIL_PROVIDER_FUTURE_SKEW_MAX_MS + 1),
        }),
      );
    }
  });

  it("lists from the monitoring baseline on a deep sweep", async () => {
    const store = memoryStore<never>();
    const list = vi.fn(async () => ({
      count: 1,
      messages: [message({ id: "message_1", timestamp: 5_000 })],
    }));
    const session = await createAgentMailCatchUpSession({
      account,
      client: { inboxes: { messages: { list } } } as never,
      store: store as never,
      now: () => 1_000,
    });
    const receive = vi.fn(async () => undefined);
    // Establish the cursor; high-water advances to 5_000.
    await session.run({ receive, abortSignal: new AbortController().signal });
    // A normal established run would list from max(0, 5_000 - overlap) = 0; the deep sweep instead
    // lists from the baseline (1_000) so back-dated mail below the overlap window is recovered.
    await session.run({
      receive,
      abortSignal: new AbortController().signal,
      sinceBaseline: true,
    });
    expect(list).toHaveBeenLastCalledWith(
      "inbox_1",
      expect.objectContaining({ after: new Date(1_000) }),
      expect.any(Object),
    );
  });

  it("keeps deep recovery at the baseline beyond the former seven-day horizon", async () => {
    const store = memoryStore<never>();
    const list = vi.fn(async () => ({ count: 0, messages: [] }));
    let nowMs = 1_000;
    const session = await createAgentMailCatchUpSession({
      account,
      client: { inboxes: { messages: { list } } } as never,
      store: store as never,
      now: () => nowMs,
    });
    const receive = vi.fn(async () => undefined);
    await session.run({ receive, abortSignal: new AbortController().signal }); // baseline = 1_000
    nowMs = 1_000 + 8 * 24 * 60 * 60 * 1000; // 8 days later
    await session.run({ receive, abortSignal: new AbortController().signal, sinceBaseline: true });
    // Recovery remains at the monitoring baseline because pending ingress is retained for 30 days.
    expect(list).toHaveBeenLastCalledWith(
      "inbox_1",
      expect.objectContaining({ after: new Date(1_000) }),
      expect.any(Object),
    );
  });

  it("floors an idle high-water sweep at the durable recovery horizon", async () => {
    const store = memoryStore<never>();
    const list = vi.fn(async () => ({ count: 0, messages: [] }));
    let nowMs = 1_000;
    const session = await createAgentMailCatchUpSession({
      account,
      client: { inboxes: { messages: { list } } } as never,
      store: store as never,
      now: () => nowMs,
    });
    const receive = vi.fn(async () => undefined);
    await session.run({ receive, abortSignal: new AbortController().signal }); // establish, highWater≈1_000
    nowMs = 1_000 + AGENTMAIL_DURABLE_PENDING_TTL_MS + 24 * 60 * 60 * 1000;
    await session.run({ receive, abortSignal: new AbortController().signal }); // normal high-water sweep
    // The high-water cursor never advanced, so the sweep is bounded by the same 30-day horizon as
    // durable pending ingress and completed tombstones.
    const expectedFloor = nowMs - AGENTMAIL_DURABLE_PENDING_TTL_MS;
    expect(list).toHaveBeenLastCalledWith(
      "inbox_1",
      expect.objectContaining({ after: new Date(expectedFloor) }),
      expect.any(Object),
    );
  });

  it("advances malformed timestamps using provider creation time", async () => {
    const store = memoryStore<AgentMailCatchUpCursor>();
    const key = sha256Hex("default\ninbox_1");
    await store.register(key, {
      version: 1,
      baselineAtMs: 100_000,
      highWaterAtMs: 200_000,
      established: true,
    });
    const malformed = {
      ...message({ id: "malformed", timestamp: 900_000 }),
      timestamp: new Date(Number.NaN),
    };
    const list = vi
      .fn()
      .mockResolvedValueOnce({ count: 1, messages: [malformed] })
      .mockResolvedValueOnce({ count: 0, messages: [] });
    const warn = vi.fn();
    const session = await createAgentMailCatchUpSession({
      account,
      client: { inboxes: { messages: { list } } } as never,
      store,
      now: () => 1_000_000,
      log: { warn },
    });
    const receive = vi.fn(async () => undefined);

    await session.run({ receive, abortSignal: new AbortController().signal });
    await session.run({ receive, abortSignal: new AbortController().signal });

    expect(receive.mock.calls.map(([record]) => [record.messageId, record.receivedAt])).toEqual([
      ["malformed", 900_000],
    ]);
    expect(list).toHaveBeenNthCalledWith(
      1,
      "inbox_1",
      expect.objectContaining({
        before: new Date(1_000_000 + AGENTMAIL_PROVIDER_FUTURE_SKEW_MAX_MS + 1),
      }),
      expect.any(Object),
    );
    expect(list).toHaveBeenNthCalledWith(
      2,
      "inbox_1",
      expect.objectContaining({
        after: new Date(1_000_000 - AGENTMAIL_REST_CATCH_UP_OVERLAP_MS),
      }),
      expect.any(Object),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid timestamp"));
  });

  it("pauses the pass when durable ingress reports capacity", async () => {
    const store = memoryStore<never>();
    const list = vi.fn(async () => ({
      count: 2,
      messages: [
        message({ id: "message_1", timestamp: 1_100 }),
        message({ id: "message_2", timestamp: 1_200 }),
      ],
      nextPageToken: "page_2",
    }));
    const session = await createAgentMailCatchUpSession({
      account,
      client: { inboxes: { messages: { list } } } as never,
      store: store as never,
      now: () => 1_000,
    });
    const receive = vi.fn(async (record: { messageId: string }) => {
      if (record.messageId === "message_1") {
        throw new AgentMailIngressCapacityError();
      }
    });
    // The pass returns cleanly (no throw), so the supervisor does not enter a tight failure loop
    // that would re-list the same pages. It stops before fetching page 2 or admitting message_2.
    await expect(
      session.run({ receive: receive as never, abortSignal: new AbortController().signal }),
    ).resolves.toBeUndefined();
    expect(list).toHaveBeenCalledTimes(1);
    expect(receive).toHaveBeenCalledTimes(1);
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

  it("resumes a saved continuation after capacity pauses a later page", async () => {
    const store = memoryStore<AgentMailCatchUpCursor>();
    const key = sha256Hex("default\ninbox_1");
    await store.register(key, {
      version: 1,
      baselineAtMs: 100_000,
      highWaterAtMs: 400_000,
      established: true,
    });
    const firstPage = {
      count: 1,
      messages: [message({ id: "newer", timestamp: 900_000 })],
      nextPageToken: "page_2",
    };
    const secondPage = {
      count: 1,
      // Defensive case: provider pagination claims ascending order but returns a later page with a
      // timestamp below both the first page and the overlap window.
      messages: [message({ id: "backdated", timestamp: 200_000 })],
    };
    const list = vi.fn(async (_inboxId: string, options: { pageToken?: string }) =>
      options.pageToken ? secondPage : firstPage,
    );
    const session = await createAgentMailCatchUpSession({
      account,
      client: { inboxes: { messages: { list } } } as never,
      store,
      now: () => 1_000_000,
    });
    let capacityPause = true;
    const receive = vi.fn(async (record: AgentMailIngressRecord) => {
      if (record.messageId === "backdated" && capacityPause) {
        capacityPause = false;
        throw new AgentMailIngressCapacityError();
      }
    });

    await session.run({ receive, abortSignal: new AbortController().signal });
    await session.run({ receive, abortSignal: new AbortController().signal });

    expect(list).toHaveBeenNthCalledWith(
      3,
      "inbox_1",
      expect.objectContaining({
        after: new Date(400_000 - AGENTMAIL_REST_CATCH_UP_OVERLAP_MS),
        pageToken: "page_2",
      }),
      expect.any(Object),
    );
    expect(receive.mock.calls.map(([value]) => value.messageId)).toEqual([
      "newer",
      "backdated",
      "backdated",
    ]);
  });

  it("resumes the last completed page after a mid-page abort", async () => {
    const store = memoryStore<AgentMailCatchUpCursor>();
    const key = sha256Hex("default\ninbox_1");
    await store.register(key, {
      version: 1,
      baselineAtMs: 100_000,
      highWaterAtMs: 400_000,
      established: true,
    });
    const list = vi.fn(async (_inboxId: string, options: { pageToken?: string }) =>
      options.pageToken
        ? { count: 1, messages: [message({ id: "page_2", timestamp: 600_000 })] }
        : {
            count: 1,
            messages: [message({ id: "page_1", timestamp: 500_000 })],
            nextPageToken: "page_2",
          },
    );
    const session = await createAgentMailCatchUpSession({
      account,
      client: { inboxes: { messages: { list } } } as never,
      store,
      now: () => 1_000_000,
    });
    const firstController = new AbortController();
    const receive = vi.fn(async (record: AgentMailIngressRecord) => {
      if (record.messageId === "page_2" && !firstController.signal.aborted) {
        firstController.abort();
      }
    });

    await session.run({ receive, abortSignal: firstController.signal });
    await session.run({ receive, abortSignal: new AbortController().signal });

    expect(list).toHaveBeenNthCalledWith(
      3,
      "inbox_1",
      expect.objectContaining({ pageToken: "page_2" }),
      expect.any(Object),
    );
    expect(receive.mock.calls.map(([value]) => value.messageId)).toEqual([
      "page_1",
      "page_2",
      "page_2",
    ]);
  });
});
