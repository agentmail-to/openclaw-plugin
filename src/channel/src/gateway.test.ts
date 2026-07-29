import { describe, expect, it, vi } from "vitest";
import {
  collectAgentMailSecurityWarnings,
  startAgentMailGatewayAccount,
} from "./gateway.js";
import type { ResolvedAgentMailAccount } from "./types.js";

const mocks = vi.hoisted(() => ({
  routes: [] as Array<{
    path: string;
    replaceExisting?: boolean;
    unregister: ReturnType<typeof vi.fn>;
  }>,
  startWebSocket: vi.fn(async () => undefined),
  processIngress: vi.fn(async () => "accepted"),
  catchUpRun: vi.fn(async () => undefined),
  catchUpRequest: vi.fn(),
  catchUpSettle: vi.fn(async () => undefined),
  createCatchUpSession: vi.fn(async () => ({ run: vi.fn(async () => undefined) })),
  registerError: false,
  reclaimDeferredMedia: vi.fn(async () => undefined),
  webhookReceives: [] as Array<(record: unknown) => Promise<void>>,
}));
const apiVal = "key";
const hookVal = "hook-value";

vi.mock("openclaw/plugin-sdk/channel-outbound", () => ({
  waitUntilAbort: async (signal: AbortSignal, onAbort?: () => void) =>
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          onAbort?.();
          resolve();
        },
        { once: true },
      );
    }),
}));

vi.mock("openclaw/plugin-sdk/webhook-ingress", () => ({
  registerPluginHttpRoute: ({
    path,
    replaceExisting,
  }: {
    path: string;
    replaceExisting?: boolean;
  }) => {
    if (mocks.registerError) {
      throw new Error("route registration failed");
    }
    const unregister = vi.fn();
    mocks.routes.push({ path, replaceExisting, unregister });
    return unregister;
  },
}));

vi.mock("./durable-receive.js", () => ({
  createAgentMailDurableInboundReceiveJournal: () => ({}),
}));

vi.mock("./catch-up.js", () => ({
  createAgentMailCatchUpSession: mocks.createCatchUpSession,
  createAgentMailCatchUpSupervisor: vi.fn(() => ({
    request: mocks.catchUpRequest,
    requestDeep: mocks.catchUpRequest,
    settle: mocks.catchUpSettle,
  })),
  startAgentMailPeriodicCatchUp: vi.fn(() => []),
}));

vi.mock("./ingress.js", () => ({
  processAgentMailIngress: mocks.processIngress,
  replayPendingAgentMailIngress: vi.fn(async () => undefined),
}));

vi.mock("./inbound.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inbound.js")>()),
  reclaimAbortedAgentMailDeferredMedia: mocks.reclaimDeferredMedia,
}));

vi.mock("./webhook.js", () => ({
  createAgentMailWebhookVerifier: (secret: string) => (secret === "invalid" ? null : {}),
  createAgentMailWebhookHandler: ({ receive }: { receive: (record: unknown) => Promise<void> }) => {
    mocks.webhookReceives.push(receive);
    return vi.fn();
  },
}));

vi.mock("./websocket.js", () => ({
  startAgentMailWebSocket: mocks.startWebSocket,
}));

function account(accountId: string, webhookPath: string): ResolvedAgentMailAccount {
  return {
    accountId,
    enabled: true,
    apiKey: apiVal,
    inboxId: `inbox_${accountId}`,
    webhookSecret: hookVal,
    webhookPath,
    dmPolicy: "allowlist",
    allowFrom: [],
    mediaMaxBytes: 20 * 1024 * 1024,
  };
}

describe("AgentMail gateway route ownership", () => {
  it("uses WebSocket only when no webhook secret is configured", async () => {
    mocks.routes.length = 0;
    mocks.startWebSocket.mockClear();
    const websocketAccount = { ...account("default", "/webhooks/agentmail"), webhookSecret: "" };
    await startAgentMailGatewayAccount({
      cfg: {},
      account: websocketAccount,
      channelRuntime: {} as never,
      abortSignal: new AbortController().signal,
    });
    expect(mocks.startWebSocket).toHaveBeenCalledOnce();
    expect(mocks.routes).toHaveLength(0);
  });

  it("falls back to WebSocket when the webhook secret is malformed", async () => {
    mocks.routes.length = 0;
    mocks.startWebSocket.mockClear();
    const invalidSecret = { ...account("default", "/webhooks/agentmail"), webhookSecret: "invalid" };
    await startAgentMailGatewayAccount({
      cfg: {},
      account: invalidSecret,
      channelRuntime: {} as never,
      abortSignal: new AbortController().signal,
    });
    expect(mocks.startWebSocket).toHaveBeenCalledOnce();
    expect(mocks.routes).toHaveLength(0);
  });

  it("does not start a duplicate consumer for an inbox owned by an earlier account", async () => {
    mocks.routes.length = 0;
    mocks.startWebSocket.mockClear();
    const cfg = {
      channels: {
        agentmail: {
          apiKey: "key",
          accounts: {
            alpha: { inboxId: "shared@agentmail.to" },
            beta: { inboxId: "shared@agentmail.to" },
          },
        },
      },
    };
    const beta = {
      ...account("beta", "/webhooks/agentmail/beta"),
      inboxId: "shared@agentmail.to",
      webhookSecret: "",
    };
    const controller = new AbortController();
    const running = startAgentMailGatewayAccount({
      cfg: cfg as never,
      account: beta,
      channelRuntime: {} as never,
      abortSignal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await running;
    expect(mocks.startWebSocket).not.toHaveBeenCalled();
    expect(mocks.routes).toHaveLength(0);
  });

  it("starts REST recovery and requests it again after webhook admission failure", async () => {
    mocks.routes.length = 0;
    mocks.webhookReceives.length = 0;
    mocks.catchUpRequest.mockClear();
    mocks.processIngress.mockReset();
    mocks.reclaimDeferredMedia.mockClear();
    mocks.processIngress.mockRejectedValueOnce(new Error("queue full"));
    const controller = new AbortController();
    const running = startAgentMailGatewayAccount({
      cfg: {},
      account: account("support", "/webhooks/agentmail/support"),
      channelRuntime: {} as never,
      abortSignal: controller.signal,
    });
    await vi.waitFor(() => expect(mocks.webhookReceives).toHaveLength(1));
    expect(mocks.catchUpRequest).toHaveBeenCalledOnce();

    await expect(
      mocks.webhookReceives[0]?.({
        accountId: "support",
        inboxId: "inbox_support",
        messageId: "message_1",
        transport: "webhook",
        receivedAt: 1,
      }),
    ).rejects.toThrow("queue full");
    expect(mocks.catchUpRequest).toHaveBeenCalledTimes(2);
    controller.abort();
    await running;
    expect(mocks.reclaimDeferredMedia).toHaveBeenCalledWith(controller.signal);
  });

  it("releases an account's old path without letting stale cleanup remove its replacement", async () => {
    mocks.routes.length = 0;
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const thirdAbort = new AbortController();
    const runtime = {} as never;
    const first = startAgentMailGatewayAccount({
      cfg: {},
      account: account("support", "/webhooks/agentmail/old"),
      channelRuntime: runtime,
      abortSignal: firstAbort.signal,
    });
    await vi.waitFor(() => expect(mocks.routes).toHaveLength(1));
    const second = startAgentMailGatewayAccount({
      cfg: {},
      account: account("support", "/webhooks/agentmail/new"),
      channelRuntime: runtime,
      abortSignal: secondAbort.signal,
    });
    await vi.waitFor(() => expect(mocks.routes).toHaveLength(2));
    expect(mocks.routes[1]?.replaceExisting).toBe(true);
    expect(mocks.routes[0]?.unregister).toHaveBeenCalledOnce();

    firstAbort.abort();
    await first;
    expect(mocks.routes[0]?.unregister).toHaveBeenCalledOnce();
    const third = startAgentMailGatewayAccount({
      cfg: {},
      account: account("billing", "/webhooks/agentmail/old"),
      channelRuntime: runtime,
      abortSignal: thirdAbort.signal,
    });
    await vi.waitFor(() => expect(mocks.routes).toHaveLength(3));

    secondAbort.abort();
    thirdAbort.abort();
    await Promise.all([second, third]);
  });

  it.each(["initialization", "registration"])(
    "releases route ownership when webhook %s fails",
    async (failure) => {
      mocks.routes.length = 0;
      mocks.registerError = failure === "registration";
      mocks.createCatchUpSession.mockReset();
      mocks.createCatchUpSession.mockResolvedValue({ run: mocks.catchUpRun });
      if (failure === "initialization") {
        mocks.createCatchUpSession.mockRejectedValueOnce(new Error("state store unavailable"));
      }
      const path = `/webhooks/agentmail/failure-${failure}`;
      await expect(
        startAgentMailGatewayAccount({
          cfg: {},
          account: account("first-owner", path),
          channelRuntime: {} as never,
          abortSignal: new AbortController().signal,
        }),
      ).rejects.toThrow();

      mocks.registerError = false;
      const controller = new AbortController();
      const replacement = startAgentMailGatewayAccount({
        cfg: {},
        account: account("replacement-owner", path),
        channelRuntime: {} as never,
        abortSignal: controller.signal,
      });
      await vi.waitFor(() => expect(mocks.routes.some((route) => route.path === path)).toBe(true));
      controller.abort();
      await replacement;
    },
  );

  it.each(["initialization", "registration"])(
    "keeps the predecessor route active when replacement %s fails",
    async (failure) => {
      mocks.routes.length = 0;
      mocks.registerError = false;
      mocks.createCatchUpSession.mockReset();
      mocks.createCatchUpSession.mockResolvedValue({ run: mocks.catchUpRun });
      const controller = new AbortController();
      const running = startAgentMailGatewayAccount({
        cfg: {},
        account: account("support", "/webhooks/agentmail/stable"),
        channelRuntime: {} as never,
        abortSignal: controller.signal,
      });
      await vi.waitFor(() => expect(mocks.routes).toHaveLength(1));

      if (failure === "initialization") {
        mocks.createCatchUpSession.mockRejectedValueOnce(new Error("state store unavailable"));
      } else {
        mocks.registerError = true;
      }
      await expect(
        startAgentMailGatewayAccount({
          cfg: {},
          account: account("support", "/webhooks/agentmail/replacement"),
          channelRuntime: {} as never,
          abortSignal: new AbortController().signal,
        }),
      ).rejects.toThrow();
      mocks.registerError = false;
      expect(mocks.routes[0]?.unregister).not.toHaveBeenCalled();

      controller.abort();
      await running;
      expect(mocks.routes[0]?.unregister).toHaveBeenCalledOnce();
    },
  );

  it("lets a newer startup proceed after an older concurrent startup fails", async () => {
    mocks.routes.length = 0;
    mocks.registerError = false;
    mocks.createCatchUpSession.mockReset();
    let rejectOlder!: (error: Error) => void;
    mocks.createCatchUpSession
      .mockImplementationOnce(
        async () =>
          await new Promise<never>((_resolve, reject) => {
            rejectOlder = reject;
          }),
      )
      .mockResolvedValueOnce({ run: mocks.catchUpRun });

    const olderAbort = new AbortController();
    const newerAbort = new AbortController();
    const older = startAgentMailGatewayAccount({
      cfg: {},
      account: account("support", "/webhooks/agentmail/race"),
      channelRuntime: {} as never,
      abortSignal: olderAbort.signal,
    });
    const olderResult = older.catch((error: unknown) => error);
    await vi.waitFor(() => expect(mocks.createCatchUpSession).toHaveBeenCalledTimes(1));
    const newer = startAgentMailGatewayAccount({
      cfg: {},
      account: account("support", "/webhooks/agentmail/race"),
      channelRuntime: {} as never,
      abortSignal: newerAbort.signal,
    });
    // Per-account startup is serialized: the replacement cannot overtake the unresolved older
    // initialization and leave both invocations parked.
    expect(mocks.routes).toHaveLength(0);

    rejectOlder(new Error("older startup failed"));
    await expect(olderResult).resolves.toEqual(
      expect.objectContaining({ message: "older startup failed" }),
    );
    await vi.waitFor(() => expect(mocks.routes).toHaveLength(1));
    await expect(
      startAgentMailGatewayAccount({
        cfg: {},
        account: account("billing", "/webhooks/agentmail/race"),
        channelRuntime: {} as never,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("already registered by account support");

    olderAbort.abort();
    newerAbort.abort();
    await newer;
  });

  it("serializes different-path replacements without leaking the older route", async () => {
    mocks.routes.length = 0;
    mocks.registerError = false;
    mocks.createCatchUpSession.mockReset();
    let resolveOlder!: (session: { run: typeof mocks.catchUpRun }) => void;
    mocks.createCatchUpSession
      .mockImplementationOnce(
        async () =>
          await new Promise<{ run: typeof mocks.catchUpRun }>((resolve) => {
            resolveOlder = resolve;
          }),
      )
      .mockResolvedValueOnce({ run: mocks.catchUpRun });

    const olderAbort = new AbortController();
    const newerAbort = new AbortController();
    const older = startAgentMailGatewayAccount({
      cfg: {},
      account: account("support", "/webhooks/agentmail/older"),
      channelRuntime: {} as never,
      abortSignal: olderAbort.signal,
    });
    await vi.waitFor(() => expect(mocks.createCatchUpSession).toHaveBeenCalledTimes(1));
    const newer = startAgentMailGatewayAccount({
      cfg: {},
      account: account("support", "/webhooks/agentmail/newer"),
      channelRuntime: {} as never,
      abortSignal: newerAbort.signal,
    });
    expect(mocks.createCatchUpSession).toHaveBeenCalledTimes(1);

    resolveOlder({ run: mocks.catchUpRun });
    await vi.waitFor(() => expect(mocks.routes).toHaveLength(2));
    expect(mocks.routes[0]?.unregister).toHaveBeenCalledOnce();

    olderAbort.abort();
    newerAbort.abort();
    await Promise.all([older, newer]);
    expect(mocks.routes[0]?.unregister).toHaveBeenCalledOnce();
    expect(mocks.routes[1]?.unregister).toHaveBeenCalledOnce();
  });
});

describe("AgentMail security warnings", () => {
  const base = account("default", "/webhooks/agentmail");

  it("warns that allowlist ignores a wildcard allowFrom", () => {
    const warnings = collectAgentMailSecurityWarnings({
      ...base,
      dmPolicy: "allowlist",
      allowFrom: ["*"],
    });
    expect(warnings.some((w) => w.includes('dmPolicy="allowlist" ignores allowFrom=["*"]'))).toBe(
      true,
    );
  });

  it("warns on an empty allowlist and an open policy without a wildcard", () => {
    expect(
      collectAgentMailSecurityWarnings({ ...base, dmPolicy: "allowlist", allowFrom: [] }).some((w) =>
        w.includes("the default allowlist is empty"),
      ),
    ).toBe(true);
    expect(
      collectAgentMailSecurityWarnings({ ...base, dmPolicy: "open", allowFrom: [] }).some((w) =>
        w.includes('dmPolicy="open" requires'),
      ),
    ).toBe(true);
  });

  it("emits no security warning for a populated allowlist", () => {
    expect(
      collectAgentMailSecurityWarnings({
        ...base,
        dmPolicy: "allowlist",
        allowFrom: ["a@example.com"],
      }),
    ).toEqual([]);
  });
});
