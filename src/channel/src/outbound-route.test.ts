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

  it("uses the resolved account id for a single named account when accountId is omitted", () => {
    const namedCfg = {
      channels: {
        agentmail: { accounts: { support: { apiKey: "key", inboxId: "support@agentmail.to" } } },
      },
    } as never;
    const route = resolveAgentMailOutboundSessionRoute({
      cfg: namedCfg,
      agentId: "agent-1",
      accountId: undefined,
      target: "message:m",
      threadId: "t1",
    });
    // Matches the key the inbound turn for account "support" derives — not one keyed by a raw/
    // undefined accountId.
    expect(route?.sessionKey).toBe(
      buildAgentMailSessionKey({
        agentId: "agent-1",
        accountId: "support",
        conversationId: buildAgentMailConversationId("support@agentmail.to", "t1"),
      }),
    );
  });

  it("does not fabricate a default-account route when multiple accounts are ambiguous", () => {
    const multiCfg = {
      channels: {
        agentmail: {
          defaultAccount: "sales",
          accounts: {
            sales: { apiKey: "key", inboxId: "sales@agentmail.to" },
            support: { apiKey: "key", inboxId: "support@agentmail.to" },
          },
        },
      },
    } as never;

    expect(
      resolveAgentMailOutboundSessionRoute({
        cfg: multiCfg,
        agentId: "agent-1",
        accountId: undefined,
        target: "message:m",
        threadId: "t1",
      }),
    ).toBeNull();
  });

  it("infers a named account from the active inbound session when accountId is omitted", () => {
    const multiCfg = {
      channels: {
        agentmail: {
          defaultAccount: "sales",
          accounts: {
            sales: { apiKey: "key", inboxId: "sales@agentmail.to" },
            support: { apiKey: "key", inboxId: "support@agentmail.to" },
          },
        },
      },
    } as never;
    const conversationId = buildAgentMailConversationId("support@agentmail.to", "t1");
    const currentSessionKey = buildAgentMailSessionKey({
      agentId: "agent-1",
      accountId: "support",
      conversationId,
    });
    const route = resolveAgentMailOutboundSessionRoute({
      cfg: multiCfg,
      agentId: "agent-1",
      accountId: undefined,
      currentSessionKey,
      target: "message:m",
      threadId: "t1",
    });

    expect(route?.sessionKey).toBe(currentSessionKey);
    expect(route?.peer.id).toBe(conversationId);
  });

  it("compares mixed-case inbox and thread ids by their canonical session key", () => {
    const mixedCfg = {
      channels: {
        agentmail: {
          accounts: {
            support: { apiKey: "key", inboxId: "Support@AgentMail.to" },
          },
        },
      },
    } as never;
    const conversationId = buildAgentMailConversationId("Support@AgentMail.to", "Thread_X");
    const currentSessionKey = buildAgentMailSessionKey({
      agentId: "agent-1",
      accountId: "support",
      conversationId,
    });

    const route = resolveAgentMailOutboundSessionRoute({
      cfg: mixedCfg,
      agentId: "agent-1",
      currentSessionKey,
      target: "message:m",
      threadId: "Thread_X",
    });

    expect(route?.sessionKey).toBe(currentSessionKey);
  });

  it("uses the active inbound conversation when core supplies no thread id", () => {
    const conversationId = buildAgentMailConversationId(INBOX, "thread_1");
    const currentSessionKey = buildAgentMailSessionKey({
      agentId: "agent-1",
      accountId: "default",
      conversationId,
    });
    const route = resolveAgentMailOutboundSessionRoute({
      cfg,
      agentId: "agent-1",
      currentSessionKey,
      target: "message:msg_1",
    });

    expect(route?.sessionKey).toBe(currentSessionKey);
    expect(route?.peer.id).toBe(conversationId.toLowerCase());
  });

  it("does not let an unrelated active session override an explicit account", () => {
    const route = resolveAgentMailOutboundSessionRoute({
      cfg,
      agentId: "agent-1",
      accountId: "default",
      currentSessionKey: buildAgentMailSessionKey({
        agentId: "agent-1",
        accountId: "default",
        conversationId: buildAgentMailConversationId(INBOX, "other_thread"),
      }),
      target: "message:msg_1",
      threadId: "thread_1",
    });

    expect(route?.peer.id).toBe(buildAgentMailConversationId(INBOX, "thread_1"));
  });

  it("keeps per-thread isolation when a single-account session is on another thread", () => {
    const currentSessionKey = buildAgentMailSessionKey({
      agentId: "agent-1",
      accountId: "default",
      conversationId: buildAgentMailConversationId(INBOX, "other_thread"),
    });
    const route = resolveAgentMailOutboundSessionRoute({
      cfg,
      agentId: "agent-1",
      // No explicit accountId: the account is inferred from the active session.
      currentSessionKey,
      target: "message:msg_1",
      threadId: "thread_1",
    });

    // With one configured account the inference cannot pick a wrong inbox, so declining here would
    // hand routing back to core's `dmScope ?? "main"` and merge both threads into one session.
    const conversationId = buildAgentMailConversationId(INBOX, "thread_1");
    expect(route?.sessionKey).toBe(
      buildAgentMailSessionKey({ agentId: "agent-1", accountId: "default", conversationId }),
    );
    expect(route?.sessionKey).not.toBe(currentSessionKey);
  });

  it("ignores an active session whose account is no longer configured", () => {
    const staleSessionKey = buildAgentMailSessionKey({
      agentId: "agent-1",
      accountId: "removed",
      conversationId: buildAgentMailConversationId("removed@agentmail.to", "t1"),
    });
    const route = resolveAgentMailOutboundSessionRoute({
      cfg,
      agentId: "agent-1",
      currentSessionKey: staleSessionKey,
      target: "message:msg_1",
      threadId: "thread_1",
    });

    // Never resolve the removed account: it has no configured inboxId and no apiKey.
    expect(route?.sessionKey).toBe(
      buildAgentMailSessionKey({
        agentId: "agent-1",
        accountId: "default",
        conversationId: buildAgentMailConversationId(INBOX, "thread_1"),
      }),
    );
  });

  it("declines a removed-account session instead of bypassing the multi-account guard", () => {
    const multiCfg = {
      channels: {
        agentmail: {
          defaultAccount: "sales",
          accounts: {
            sales: { apiKey: "key", inboxId: "sales@agentmail.to" },
            support: { apiKey: "key", inboxId: "support@agentmail.to" },
          },
        },
      },
    } as never;

    expect(
      resolveAgentMailOutboundSessionRoute({
        cfg: multiCfg,
        agentId: "agent-1",
        currentSessionKey: buildAgentMailSessionKey({
          agentId: "agent-1",
          accountId: "removed",
          conversationId: buildAgentMailConversationId("removed@agentmail.to", "t1"),
        }),
        target: "message:msg_1",
      }),
    ).toBeNull();
  });

  it("declines an unrelated thread session only when the account is ambiguous", () => {
    const multiCfg = {
      channels: {
        agentmail: {
          defaultAccount: "sales",
          accounts: {
            sales: { apiKey: "key", inboxId: "sales@agentmail.to" },
            support: { apiKey: "key", inboxId: "support@agentmail.to" },
          },
        },
      },
    } as never;

    expect(
      resolveAgentMailOutboundSessionRoute({
        cfg: multiCfg,
        agentId: "agent-1",
        currentSessionKey: buildAgentMailSessionKey({
          agentId: "agent-1",
          accountId: "support",
          conversationId: buildAgentMailConversationId("support@agentmail.to", "other_thread"),
        }),
        target: "message:m",
        threadId: "t1",
      }),
    ).toBeNull();
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
