import { AgentMailError, type AgentMail } from "agentmail";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentMailLabelPendingError,
  buildAgentMailSessionKey,
  dispatchAgentMailInboundEvent,
  resolveAgentMailMessageText,
} from "./inbound.js";
import { AgentMailMediaPolicyError } from "./media.js";
import type { AgentMailIngressRecord, ResolvedAgentMailAccount } from "./types.js";

const loadAgentMailInboundAttachments = vi.hoisted(() => vi.fn());
const rm = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("node:fs/promises", () => ({ rm }));

vi.mock("./media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media.js")>()),
  loadAgentMailInboundAttachments,
}));

const hookVal = "test-value";

const account: ResolvedAgentMailAccount = {
  accountId: "default",
  enabled: true,
  apiKey: "key",
  inboxId: "inbox_1",
  webhookSecret: hookVal,
  webhookPath: "/webhooks/agentmail",
  dmPolicy: "allowlist",
  allowFrom: ["sender@example.com"],
  mediaMaxBytes: 20 * 1024 * 1024,
};

const record: AgentMailIngressRecord = {
  accountId: "default",
  inboxId: "inbox_1",
  messageId: "message_1",
  transport: "webhook",
  receivedAt: 1,
};

function message(overrides: Partial<AgentMail.Message> = {}): AgentMail.Message {
  return {
    inboxId: "inbox_1",
    threadId: "thread_1",
    messageId: "message_1",
    labels: ["received"],
    timestamp: new Date("2026-07-15T00:00:00Z"),
    from: "Sender <sender@example.com>",
    to: ["inbox@example.com"],
    text: "hello",
    attachments: [],
    size: 5,
    updatedAt: new Date("2026-07-15T00:00:00Z"),
    createdAt: new Date("2026-07-15T00:00:00Z"),
    ...overrides,
  };
}

const attachmentPolicyCases: Array<{
  name: string;
  overrides: Partial<AgentMail.Message>;
  expectedBody: string;
}> = [
  {
    name: "preserves text and omits all attachments after a deterministic media rejection",
    overrides: {},
    expectedBody: "hello\n\n[Attachments omitted because they exceed the configured media limit]",
  },
  {
    name: "dispatches an omission notice when rejected attachments were the only content",
    overrides: {
      text: undefined,
      extractedText: undefined,
      html: undefined,
      extractedHtml: undefined,
      subject: undefined,
    },
    expectedBody: "[Attachments omitted because they exceed the configured media limit]",
  },
];

describe("AgentMail REST-authoritative inbound", () => {
  beforeEach(() => {
    loadAgentMailInboundAttachments.mockReset();
    loadAgentMailInboundAttachments.mockResolvedValue({ paths: [], types: [] });
  });

  it("uses HTML fallback from the hydrated message", () => {
    expect(
      resolveAgentMailMessageText(
        message({ text: undefined, extractedText: undefined, html: "<p>Hello <b>world</b></p>" }),
      ),
    ).toBe("Hello world");
  });

  it("prefers extracted reply content over the full quoted body", () => {
    expect(
      resolveAgentMailMessageText(
        message({
          extractedText: "new reply",
          text: "new reply\n\nOn Tuesday, someone wrote:\nold quoted history",
          extractedHtml: "<p>new html reply</p>",
          html: "<p>full html history</p>",
        }),
      ),
    ).toBe("new reply");
  });

  it("prefers extracted HTML over a full plain-text body", () => {
    expect(
      resolveAgentMailMessageText(
        message({
          extractedText: undefined,
          extractedHtml: "<p>new reply</p>",
          text: "new reply\n\nOn Tuesday, someone wrote:\nold quoted history",
          html: "<p>full html history</p>",
        }),
      ),
    ).toBe("new reply");
  });

  it("uses the hydrated subject when the message body is empty", () => {
    expect(
      resolveAgentMailMessageText(
        message({
          text: undefined,
          extractedText: undefined,
          html: undefined,
          extractedHtml: undefined,
          subject: "Subject-only request",
        }),
      ),
    ).toBe("Subject-only request");
  });

  it.each(attachmentPolicyCases)("$name", async ({ overrides, expectedBody }) => {
    loadAgentMailInboundAttachments.mockRejectedValueOnce(
      new AgentMailMediaPolicyError("attachments exceed the configured aggregate media limit"),
    );
    let context: Record<string, unknown> | undefined;
    await dispatchAgentMailInboundEvent({
      cfg: {},
      account,
      record,
      channelRuntime: {
        routing: {
          resolveAgentRoute: () => ({ agentId: "main" }),
          buildAgentSessionKey: () => "session-thread-1",
        },
        inbound: {
          buildContext: (value: Record<string, unknown>) => {
            context = value;
            return value;
          },
          run: async ({
            raw,
            adapter,
          }: {
            raw: AgentMail.Message;
            adapter: Record<string, Function>;
          }) => {
            const ingested = adapter.ingest!(raw);
            await adapter.resolveTurn!(ingested);
          },
        },
        session: {
          resolveStorePath: () => "/tmp/session.json",
          recordInboundSession: vi.fn(),
        },
        reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
      } as never,
      client: { inboxes: { messages: { get: vi.fn(async () => message(overrides)) } } } as never,
    });

    expect(context?.message).toEqual(
      expect.objectContaining({
        bodyForAgent: expectedBody,
      }),
    );
    expect(context?.extra).toEqual(expect.objectContaining({ MediaPaths: [], MediaTypes: [] }));
  });

  it("hydrates positionally, keys sessions by inbox and thread, and fixes the reply target", async () => {
    const get = vi.fn(async () => message());
    const resolveAgentRoute = vi.fn(() => ({ agentId: "main", sessionKey: "session-thread-1" }));
    const onTurnAdopted = vi.fn(async () => undefined);
    let turn: Record<string, unknown> | undefined;
    const channelRuntime = {
      routing: { resolveAgentRoute },
      inbound: {
        buildContext: (ctx: Record<string, unknown>) => ctx,
        run: async ({
          raw,
          adapter,
          turnAdoptionLifecycle,
        }: {
          raw: AgentMail.Message;
          adapter: Record<string, Function>;
          turnAdoptionLifecycle?: {
            admission?: string;
            onAdopted: () => Promise<void>;
          };
        }) => {
          // The SDK contract is turnAdoptionLifecycle.onAdopted, not a bare onTurnAdopted.
          expect(turnAdoptionLifecycle?.admission).toBe("exclusive");
          await turnAdoptionLifecycle?.onAdopted();
          expect(onTurnAdopted).toHaveBeenCalledOnce();
          const ingested = adapter.ingest!(raw);
          turn = await adapter.resolveTurn!(ingested);
        },
      },
      session: {
        resolveStorePath: () => "/tmp/session.json",
        recordInboundSession: vi.fn(),
      },
      reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
    };

    await dispatchAgentMailInboundEvent({
      cfg: {},
      account,
      record,
      channelRuntime: channelRuntime as never,
      client: { inboxes: { messages: { get } } } as never,
      onTurnAdopted,
    });

    expect(get).toHaveBeenCalledWith("inbox_1", "message_1");
    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        peer: { kind: "direct", id: "inbox_1:thread:thread_1" },
      }),
    );
    // The session is keyed by the shared per-thread helper — the SAME derivation the outbound
    // message-tool route uses, so a reply resolves this exact session.
    expect(turn?.routeSessionKey).toBe(
      buildAgentMailSessionKey({
        agentId: "main",
        accountId: "default",
        conversationId: "inbox_1:thread:thread_1",
      }),
    );
    expect((turn?.ctxPayload as { reply?: unknown }).reply).toEqual({
      to: "message:message_1",
    });
    const delivery = turn?.delivery as {
      preparePayload: (payload: Record<string, unknown>) => Record<string, unknown>;
      durable: () => Record<string, unknown>;
    };
    expect(
      delivery.preparePayload({
        text: "reply",
        replyToId: "message_1",
        replyToTag: false,
        replyToCurrent: true,
      }),
    ).toEqual({ text: "reply" });
    expect(delivery.durable()).toMatchObject({
      to: "message:message_1",
      replyToId: "message_1",
      threadId: "thread_1",
      requiredCapabilities: { reconcileUnknownSend: true },
    });
    expect(turn?.replyOptions).toEqual({
      disableBlockStreaming: true,
      sourceReplyDeliveryMode: "automatic",
    });
  });

  it("removes freshly-saved attachments when the turn fails before adoption", async () => {
    rm.mockClear();
    loadAgentMailInboundAttachments.mockResolvedValueOnce({
      paths: ["/tmp/a.bin"],
      types: ["application/octet-stream"],
    });
    await expect(
      dispatchAgentMailInboundEvent({
        cfg: {},
        account,
        record,
        channelRuntime: {
          routing: { resolveAgentRoute: () => ({ agentId: "agent-1" }) },
          inbound: {
            buildContext: (ctx: Record<string, unknown>) => ctx,
            run: async () => {
              throw new Error("dispatch failed before adoption");
            },
          },
          session: { resolveStorePath: () => "/tmp/s.json", recordInboundSession: vi.fn() },
          reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
        } as never,
        client: { inboxes: { messages: { get: vi.fn(async () => message()) } } } as never,
      }),
    ).rejects.toThrow("dispatch failed before adoption");
    expect(rm).toHaveBeenCalledWith("/tmp/a.bin", { force: true });
  });

  it("retains deferred-turn attachments until the queued turn is abandoned", async () => {
    rm.mockClear();
    loadAgentMailInboundAttachments.mockResolvedValueOnce({
      paths: ["/tmp/deferred.bin"],
      types: ["application/octet-stream"],
    });
    let lifecycle:
      | { onDeferred: () => void; onAbandoned: () => Promise<void> }
      | undefined;
    const onTurnDeferred = vi.fn();
    const onTurnAbandoned = vi.fn(async () => undefined);
    await dispatchAgentMailInboundEvent({
      cfg: {},
      account,
      record,
      channelRuntime: {
        routing: { resolveAgentRoute: () => ({ agentId: "agent-1" }) },
        inbound: {
          buildContext: (ctx: Record<string, unknown>) => ctx,
          run: async ({ turnAdoptionLifecycle }: { turnAdoptionLifecycle: typeof lifecycle }) => {
            lifecycle = turnAdoptionLifecycle;
            turnAdoptionLifecycle?.onDeferred();
          },
        },
        session: { resolveStorePath: () => "/tmp/s.json", recordInboundSession: vi.fn() },
        reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
      } as never,
      client: { inboxes: { messages: { get: vi.fn(async () => message()) } } } as never,
      onTurnDeferred,
      onTurnAbandoned,
    });

    expect(onTurnDeferred).toHaveBeenCalledOnce();
    expect(rm).not.toHaveBeenCalled();
    await lifecycle?.onAbandoned();
    expect(rm).toHaveBeenCalledWith("/tmp/deferred.bin", { force: true });
    expect(onTurnAbandoned).toHaveBeenCalledOnce();
  });

  it("does not delete core-owned deferred attachments when account shutdown aborts", async () => {
    rm.mockClear();
    loadAgentMailInboundAttachments.mockResolvedValueOnce({
      paths: ["/tmp/deferred-abort.bin"],
      types: ["application/octet-stream"],
    });
    const controller = new AbortController();
    let lifecycle:
      | { onDeferred: () => void; onAbandoned: () => Promise<void> }
      | undefined;
    await dispatchAgentMailInboundEvent({
      cfg: {},
      account,
      record,
      channelRuntime: {
        routing: { resolveAgentRoute: () => ({ agentId: "agent-1" }) },
        inbound: {
          buildContext: (ctx: Record<string, unknown>) => ctx,
          run: async ({
            turnAdoptionLifecycle,
          }: {
            turnAdoptionLifecycle: typeof lifecycle;
          }) => {
            lifecycle = turnAdoptionLifecycle;
            turnAdoptionLifecycle?.onDeferred();
          },
        },
        session: { resolveStorePath: () => "/tmp/s.json", recordInboundSession: vi.fn() },
        reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
      } as never,
      client: { inboxes: { messages: { get: vi.fn(async () => message()) } } } as never,
      abortSignal: controller.signal,
    });
    expect(rm).not.toHaveBeenCalled();

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rm).not.toHaveBeenCalled();

    await lifecycle?.onAbandoned();
    expect(rm).toHaveBeenCalledWith("/tmp/deferred-abort.bin", { force: true });
  });

  it("cleans up attachments when inbound handling resolves without adoption", async () => {
    rm.mockClear();
    loadAgentMailInboundAttachments.mockResolvedValueOnce({
      paths: ["/tmp/ignored.bin"],
      types: ["application/octet-stream"],
    });
    await dispatchAgentMailInboundEvent({
      cfg: {},
      account,
      record,
      channelRuntime: {
        routing: { resolveAgentRoute: () => ({ agentId: "agent-1" }) },
        inbound: {
          buildContext: (ctx: Record<string, unknown>) => ctx,
          run: async () => undefined,
        },
        session: { resolveStorePath: () => "/tmp/s.json", recordInboundSession: vi.fn() },
        reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
      } as never,
      client: { inboxes: { messages: { get: vi.fn(async () => message()) } } } as never,
    });
    expect(rm).toHaveBeenCalledWith("/tmp/ignored.bin", { force: true });
  });

  it("cleans up attachments when the adoption hook itself fails", async () => {
    rm.mockClear();
    loadAgentMailInboundAttachments.mockResolvedValueOnce({
      paths: ["/tmp/b.bin"],
      types: ["application/octet-stream"],
    });
    const onTurnAdopted = vi.fn(async () => {
      throw new Error("journal.complete failed");
    });
    await expect(
      dispatchAgentMailInboundEvent({
        cfg: {},
        account,
        record,
        channelRuntime: {
          routing: { resolveAgentRoute: () => ({ agentId: "agent-1" }) },
          inbound: {
            buildContext: (ctx: Record<string, unknown>) => ctx,
            run: async ({
              turnAdoptionLifecycle,
            }: {
              turnAdoptionLifecycle: { onAdopted: () => Promise<void> };
            }) => {
              // Core surfaces an adoption-hook failure by rejecting the run.
              await turnAdoptionLifecycle.onAdopted();
            },
          },
          session: { resolveStorePath: () => "/tmp/s.json", recordInboundSession: vi.fn() },
          reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
        } as never,
        client: { inboxes: { messages: { get: vi.fn(async () => message()) } } } as never,
        onTurnAdopted,
      }),
    ).rejects.toThrow("journal.complete failed");
    // The flag is set only after the hook resolves, so a failed completion still cleans up media.
    expect(rm).toHaveBeenCalledWith("/tmp/b.bin", { force: true });
  });

  it("denies an unauthorized hydrated sender without dispatch", async () => {
    const run = vi.fn();
    await dispatchAgentMailInboundEvent({
      cfg: {},
      account,
      record,
      channelRuntime: {
        inbound: { run },
      } as never,
      client: {
        inboxes: { messages: { get: vi.fn(async () => message({ from: "other@example.com" })) } },
      } as never,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("settles permanently unsafe hydrated messages without dispatch", async () => {
    const run = vi.fn();
    const warn = vi.fn();
    await expect(
      dispatchAgentMailInboundEvent({
        cfg: {},
        account,
        record,
        channelRuntime: { inbound: { run } } as never,
        client: {
          inboxes: { messages: { get: vi.fn(async () => message({ labels: ["spam"] })) } },
        } as never,
        log: { warn },
      }),
    ).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unsafe hydrated message"));
  });

  it("rejects a REST-listed outbound message without a received label", async () => {
    const run = vi.fn();
    await dispatchAgentMailInboundEvent({
      cfg: {},
      account,
      record,
      channelRuntime: { inbound: { run } } as never,
      client: {
        inboxes: { messages: { get: vi.fn(async () => message({ labels: ["sent"] })) } },
      } as never,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("retries a not-yet-projected received label within the window, then settles after it", async () => {
    const run = vi.fn();
    const client = {
      inboxes: { messages: { get: vi.fn(async () => message({ labels: ["sent"] })) } },
    } as never;
    // Within the window: retryable (throws) so the durable layer retries instead of dropping.
    await expect(
      dispatchAgentMailInboundEvent({
        cfg: {},
        account,
        record: { ...record, receivedAt: 1_000, arrivedAt: 1_000 },
        channelRuntime: { inbound: { run } } as never,
        client,
        now: () => 1_000 + 60_000,
      }),
    ).rejects.toBeInstanceOf(AgentMailLabelPendingError);
    expect(run).not.toHaveBeenCalled();

    // Past the window: settle (drop) with an explanatory warning.
    const warn = vi.fn();
    await expect(
      dispatchAgentMailInboundEvent({
        cfg: {},
        account,
        record: { ...record, receivedAt: 1_000, arrivedAt: 1_000 },
        channelRuntime: { inbound: { run } } as never,
        client,
        log: { warn },
        now: () => 1_000 + 10 * 60_000,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("without a received label"));
    expect(run).not.toHaveBeenCalled();
  });

  it("retries a recent hydration 404 instead of permanently losing the message", async () => {
    const notFound = new AgentMailError({ message: "not found", statusCode: 404 });
    await expect(
      dispatchAgentMailInboundEvent({
        cfg: {},
        account,
        record: { ...record, receivedAt: 1_000 },
        channelRuntime: { inbound: { run: vi.fn() } } as never,
        client: {
          inboxes: {
            messages: {
              get: vi.fn(async () => {
                throw notFound;
              }),
            },
          },
        } as never,
        now: () => 1_000 + 60_000,
      }),
    ).rejects.toBe(notFound);
  });

  it("settles an unavailable message after the bounded hydration retry window", async () => {
    const run = vi.fn();
    const warn = vi.fn();
    await expect(
      dispatchAgentMailInboundEvent({
        cfg: {},
        account,
        record,
        channelRuntime: { inbound: { run } } as never,
        client: {
          inboxes: {
            messages: {
              get: vi.fn(async () => {
                throw new AgentMailError({ message: "not found", statusCode: 404 });
              }),
            },
          },
        } as never,
        log: { warn },
        now: () => 10 * 60_000,
      }),
    ).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("hydration retry window"));
  });
});
