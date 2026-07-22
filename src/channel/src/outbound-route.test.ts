import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { describe, expect, it } from "vitest";
import { buildAgentMailConversationId, buildAgentMailSessionKey } from "./inbound.js";
import { resolveAgentMailOutboundSessionRoute } from "./outbound-route.js";

const INBOX = "agent@agentmail.to";
const cfg = { channels: { agentmail: { apiKey: "key", inboxId: INBOX } } } as never;

describe("resolveAgentMailOutboundSessionRoute", () => {
  it("keys the session by the same inbox:thread key the inbound turn uses", () => {
    const route = resolveAgentMailOutboundSessionRoute({
      cfg,
      agentId: "agent-1",
      accountId: "default",
      target: "message:msg_1",
      threadId: "thread_1",
    });
    const conversationId = buildAgentMailConversationId(INBOX, "thread_1");
    expect(route?.peer).toEqual({ kind: "direct", id: conversationId });
    // Identical to the key the inbound turn derives for the same conversation.
    expect(route?.sessionKey).toBe(
      buildAgentMailSessionKey({ agentId: "agent-1", accountId: "default", conversationId }),
    );
    expect(route?.baseSessionKey).toBe(route?.sessionKey);
    expect(route?.from).toBe(`agentmail:${conversationId}`);
    expect(route?.to).toBe("message:msg_1");
    expect(route?.chatType).toBe("direct");
    expect(route?.recipientSessionExact).toBe(true);
  });

  it("forces per-thread isolation instead of collapsing to the main scope", () => {
    const route = resolveAgentMailOutboundSessionRoute({
      cfg,
      agentId: "agent-1",
      accountId: "default",
      target: "message:msg_1",
      threadId: "thread_1",
    });
    const conversationId = buildAgentMailConversationId(INBOX, "thread_1");
    // The default global scope ("main") would collapse the peer to agent:<id>:main; the route must
    // NOT resolve that key, otherwise every thread shares one session (finding #1).
    const mainScopeKey = buildAgentSessionKey({
      agentId: "agent-1",
      channel: "agentmail",
      accountId: "default",
      peer: { kind: "direct", id: conversationId },
      dmScope: "main",
    });
    expect(route?.sessionKey).not.toBe(mainScopeKey);
  });

  it("isolates distinct threads into distinct sessions", () => {
    const routeA = resolveAgentMailOutboundSessionRoute({
      cfg,
      agentId: "agent-1",
      accountId: "default",
      target: "message:a",
      threadId: "thread_a",
    });
    const routeB = resolveAgentMailOutboundSessionRoute({
      cfg,
      agentId: "agent-1",
      accountId: "default",
      target: "message:b",
      threadId: "thread_b",
    });
    expect(routeA?.sessionKey).not.toBe(routeB?.sessionKey);
  });

  it("coerces a numeric threadId to the string conversation id", () => {
    const route = resolveAgentMailOutboundSessionRoute({
      cfg,
      agentId: "agent-1",
      accountId: "default",
      target: "message:msg_2",
      threadId: 42,
    });
    expect(route?.peer.id).toBe(buildAgentMailConversationId(INBOX, "42"));
  });

  it("falls back to the message target when no thread is available", () => {
    const route = resolveAgentMailOutboundSessionRoute({
      cfg,
      agentId: "agent-1",
      accountId: "default",
      target: "message:msg_3",
      threadId: null,
    });
    expect(route?.peer).toEqual({ kind: "direct", id: "message:msg_3" });
    expect(route?.from).toBe("agentmail:message:msg_3");
  });

  it("prefers the resolved target over the raw target", () => {
    const route = resolveAgentMailOutboundSessionRoute({
      cfg,
      agentId: "agent-1",
      accountId: "default",
      target: "message:raw",
      resolvedTarget: { to: "message:resolved" },
      threadId: "thread_9",
    });
    expect(route?.to).toBe("message:resolved");
  });

  it("returns null for a non-AgentMail target", () => {
    expect(
      resolveAgentMailOutboundSessionRoute({
        cfg,
        agentId: "agent-1",
        accountId: "default",
        target: "person@example.com",
        threadId: "thread_1",
      }),
    ).toBeNull();
  });
});
