import { describe, expect, it, vi } from "vitest";

// Capture what our resolver passes to the SDK builder without depending on the route's internals.
const buildChannelOutboundSessionRoute = vi.hoisted(() =>
  vi.fn((args: Record<string, unknown>) => ({ built: args })),
);
vi.mock("openclaw/plugin-sdk/channel-core", () => ({ buildChannelOutboundSessionRoute }));

import { buildAgentMailConversationId } from "./inbound.js";
import { resolveAgentMailOutboundSessionRoute } from "./outbound-route.js";

const INBOX = "agent@agentmail.to";
const cfg = { channels: { agentmail: { apiKey: "key", inboxId: INBOX } } } as never;

function lastCall() {
  return buildChannelOutboundSessionRoute.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe("resolveAgentMailOutboundSessionRoute", () => {
  it("keys the session by the same inbox:thread conversation id the inbound turn uses", () => {
    resolveAgentMailOutboundSessionRoute({
      cfg,
      agentId: "agent-1",
      accountId: "default",
      target: "message:msg_1",
      threadId: "thread_1",
    });
    const args = lastCall();
    const conversationId = buildAgentMailConversationId(INBOX, "thread_1");
    expect(conversationId).toBe("agent@agentmail.to:thread:thread_1");
    expect(args.peer).toEqual({ kind: "direct", id: conversationId });
    expect(args.from).toBe(`agentmail:${conversationId}`);
    expect(args.to).toBe("message:msg_1");
    expect(args.threadId).toBe("thread_1");
    expect(args.chatType).toBe("direct");
    expect(args.recipientSessionExact).toBe(true);
  });

  it("coerces a numeric threadId to the string conversation id", () => {
    resolveAgentMailOutboundSessionRoute({
      cfg,
      agentId: "agent-1",
      accountId: "default",
      target: "message:msg_2",
      threadId: 42,
    });
    const args = lastCall();
    expect(args.peer).toEqual({ kind: "direct", id: buildAgentMailConversationId(INBOX, "42") });
    expect(args.threadId).toBe("42");
  });

  it("falls back to the message target when no thread is available", () => {
    resolveAgentMailOutboundSessionRoute({
      cfg,
      agentId: "agent-1",
      accountId: "default",
      target: "message:msg_3",
      threadId: null,
    });
    const args = lastCall();
    expect(args.peer).toEqual({ kind: "direct", id: "message:msg_3" });
    expect(args.from).toBe("agentmail:message:msg_3");
    expect("threadId" in args).toBe(false);
  });

  it("prefers the resolved target over the raw target", () => {
    resolveAgentMailOutboundSessionRoute({
      cfg,
      agentId: "agent-1",
      accountId: "default",
      target: "message:raw",
      resolvedTarget: { to: "message:resolved" },
      threadId: "thread_9",
    });
    expect(lastCall().to).toBe("message:resolved");
  });

  it("returns null for a non-AgentMail target without calling the SDK builder", () => {
    buildChannelOutboundSessionRoute.mockClear();
    const route = resolveAgentMailOutboundSessionRoute({
      cfg,
      agentId: "agent-1",
      accountId: "default",
      target: "person@example.com",
      threadId: "thread_1",
    });
    expect(route).toBeNull();
    expect(buildChannelOutboundSessionRoute).not.toHaveBeenCalled();
  });
});
