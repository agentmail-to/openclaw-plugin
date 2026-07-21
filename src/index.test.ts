import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";

const sdk = vi.hoisted(() => {
  const messages = {
    list: vi.fn(),
    search: vi.fn(),
    get: vi.fn(),
    send: vi.fn(),
    reply: vi.fn(),
    forward: vi.fn(),
    update: vi.fn(),
  };
  const inboxes = {
    list: vi.fn(),
    create: vi.fn(),
    messages,
  };

  return {
    constructor: vi.fn(),
    inboxes,
    messages,
  };
});

vi.mock("agentmail", () => ({
  AgentMailClient: class MockAgentMailClient {
    readonly inboxes = sdk.inboxes;

    constructor(options?: unknown) {
      sdk.constructor(options);
    }
  },
}));

import entry from "./index.js";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
};

function registerTools(pluginConfig: Record<string, unknown> = {}): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  const register = entry.register as unknown as (api: {
    pluginConfig: Record<string, unknown>;
    registerTool: (tool: RegisteredTool) => void;
  }) => void;

  register({
    pluginConfig,
    registerTool(tool) {
      registered.push(tool);
    },
  });

  return registered;
}

function findTool(name: string, config?: Record<string, unknown>): RegisteredTool {
  const found = registerTools(config).find((tool) => tool.name === name);
  if (!found) {
    throw new Error(`Tool not registered: ${name}`);
  }
  return found;
}

describe("agentmail", () => {
  beforeEach(() => {
    vi.stubEnv("AGENTMAIL_API_KEY", "am_test");
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("declares all AgentMail tool metadata", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((tool) => tool.name)).toEqual([
      "agentmail_list_inboxes",
      "agentmail_create_inbox",
      "agentmail_list_messages",
      "agentmail_search_messages",
      "agentmail_get_message",
      "agentmail_send_message",
      "agentmail_reply_to_message",
      "agentmail_forward_message",
      "agentmail_update_message_labels",
    ]);
  });

  it("uses the API key and optional plugin client settings", async () => {
    sdk.inboxes.list.mockResolvedValue({ count: 0, inboxes: [] });
    const signal = new AbortController().signal;
    const tool = findTool("agentmail_list_inboxes", {
      baseUrl: "https://example.test/v0",
      timeoutSeconds: 15,
      maxRetries: 0,
    });

    await tool.execute("call-1", { limit: 5 }, signal);

    expect(sdk.constructor).toHaveBeenCalledWith({
      apiKey: "am_test",
      baseUrl: "https://example.test/v0",
      timeoutInSeconds: 15,
      maxRetries: 0,
    });
    expect(sdk.inboxes.list).toHaveBeenCalledWith(
      { limit: 5 },
      { abortSignal: signal },
    );
  });

  it("sends a message with idempotency and cancellation options", async () => {
    sdk.messages.send.mockResolvedValue({ messageId: "msg_1", threadId: "thr_1" });
    const signal = new AbortController().signal;
    const tool = findTool("agentmail_send_message");

    await tool.execute(
      "call-2",
      {
        inboxId: "agent@agentmail.to",
        to: ["person@example.com"],
        subject: "Hello",
        text: "Plain text",
        idempotencyKey: "send-123",
      },
      signal,
    );

    expect(sdk.messages.send).toHaveBeenCalledWith(
      "agent@agentmail.to",
      {
        to: ["person@example.com"],
        subject: "Hello",
        text: "Plain text",
      },
      { abortSignal: signal, idempotencyKey: "send-123" },
    );
  });

  it("converts message filter timestamps to Date values", async () => {
    sdk.messages.list.mockResolvedValue({ count: 0, messages: [] });
    const tool = findTool("agentmail_list_messages");

    await tool.execute("call-3", {
      inboxId: "agent@agentmail.to",
      before: "2026-07-21T12:00:00.000Z",
      after: "2026-07-20T12:00:00.000Z",
    });

    expect(sdk.messages.list).toHaveBeenCalledWith(
      "agent@agentmail.to",
      {
        before: new Date("2026-07-21T12:00:00.000Z"),
        after: new Date("2026-07-20T12:00:00.000Z"),
      },
      {},
    );
  });

  it("requires a configured API key before making a request", async () => {
    vi.stubEnv("AGENTMAIL_API_KEY", "   ");
    const tool = findTool("agentmail_list_inboxes");

    await expect(tool.execute("call-4", {})).rejects.toThrow(
      "Set the AGENTMAIL_API_KEY environment variable",
    );
    expect(sdk.constructor).not.toHaveBeenCalled();
  });

  it("requires at least one message label change", async () => {
    const tool = findTool("agentmail_update_message_labels");

    await expect(
      tool.execute("call-5", {
        inboxId: "agent@agentmail.to",
        messageId: "msg_1",
      }),
    ).rejects.toThrow("Provide addLabels or removeLabels");
    expect(sdk.messages.update).not.toHaveBeenCalled();
  });
});
