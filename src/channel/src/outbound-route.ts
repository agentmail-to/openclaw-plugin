import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { listAgentMailAccountIds, resolveAgentMailAccount } from "./accounts.js";
import { buildAgentMailConversationId, buildAgentMailSessionKey } from "./inbound.js";
import { normalizeAgentMailTarget } from "./send.js";

type AgentMailOutboundSessionRoute = {
  sessionKey: string;
  baseSessionKey: string;
  recipientSessionExact: boolean;
  peer: { kind: "direct"; id: string };
  chatType: "direct";
  from: string;
  to: string;
};

/**
 * Resolves the session route for an outbound message-tool reply. Keys the session by the SAME
 * inbox:thread conversation id and forced dmScope the inbound turn uses (see buildAgentMailSessionKey),
 * so a reply resolves the isolated per-thread session the inbound turn runs in.
 *
 * The route is built directly rather than through the SDK's buildChannelOutboundSessionRoute, whose
 * base key applies `cfg.session.dmScope ?? "main"` — under the default scope that would collapse the
 * conversation to `agent:<id>:main`, discarding the per-thread isolation.
 *
 * Core supplies the active turn's threadId; when none is known the message target is used as the
 * conversation id (a would-be proactive send, which the reply adapter then rejects). Returns null
 * for a non-AgentMail target so core falls back to its default routing.
 *
 * Extracted from the channel definition so it can be unit-tested directly.
 */
export function resolveAgentMailOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target?: string;
  resolvedTarget?: { to: string };
  threadId?: string | number | null;
}): AgentMailOutboundSessionRoute | null {
  const target = normalizeAgentMailTarget(params.resolvedTarget?.to ?? params.target);
  if (!target) {
    return null;
  }
  // Only resolve an inbox-scoped conversation when the account is unambiguous: an explicit accountId,
  // or a single configured account. With multiple accounts and no accountId, resolving would silently
  // pick the default account's inbox and route to the wrong session — fall back to the message target.
  const hasExplicitAccount = params.accountId != null && String(params.accountId).trim() !== "";
  const inboxId =
    hasExplicitAccount || listAgentMailAccountIds(params.cfg).length <= 1
      ? resolveAgentMailAccount(params.cfg, params.accountId).inboxId
      : "";
  const threadId =
    params.threadId === undefined || params.threadId === null || params.threadId === ""
      ? undefined
      : String(params.threadId);
  // Thread is encoded in the conversation id (matching inbound), so the session key stays flat — no
  // separate route threadId that could add a divergent thread suffix.
  const conversationId =
    inboxId && threadId ? buildAgentMailConversationId(inboxId, threadId) : target;
  const sessionKey = buildAgentMailSessionKey({
    agentId: params.agentId,
    accountId: params.accountId,
    conversationId,
  });
  return {
    sessionKey,
    baseSessionKey: sessionKey,
    recipientSessionExact: true,
    peer: { kind: "direct", id: conversationId },
    chatType: "direct",
    from: `agentmail:${conversationId}`,
    to: target,
  };
}
