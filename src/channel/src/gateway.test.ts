import { describe, expect, it, vi } from "vitest";
import {
  collectAgentMailSecurityWarnings,
  startAgentMailGatewayAccount,
} from "./gateway.js";
import type { ResolvedAgentMailAccount } from "./types.js";

const mocks = vi.hoisted(() => ({
  routes: [] as Array<{ path: string; unregister: ReturnType<typeof vi.fn> }>,
  startWebSocket: vi.fn(async () => undefined),
  processIngress: vi.fn(async () => "accepted"),
  catchUpRun: vi.fn(async () => undefined),
  catchUpRequest: vi.fn(),
  catchUpSettle: vi.fn(async () => undefined),
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
  registerPluginHttpRoute: ({ path }: { path: string }) => {
    const unregister = vi.fn();
    mocks.routes.push({ path, unregister });
    return unregister;
  },
}));

vi.mock("./durable-receive.js", () => ({
  createAgentMailDurableInboundReceiveJournal: () => ({}),
}));

vi.mock("./catch-up.js", () => ({
  createAgentMailCatchUpSession: vi.fn(async () => ({ run: mocks.catchUpRun })),
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
