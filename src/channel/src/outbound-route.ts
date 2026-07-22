import { buildChannelOutboundSessionRoute } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentMailAccount } from "./accounts.js";
import { buildAgentMailConversationId } from "./inbound.js";
import { normalizeAgentMailTarget } from "./send.js";

const CHANNEL_ID = "agentmail";

/**
 * Resolves the session route for an outbound message-tool reply. Keys the session by inbox + thread
 * with the same shape the inbound turn uses (see buildAgentMailConversationId), so a message-tool
 * reply resolves the SAME session the inbound turn runs in instead of a divergent per-message
 * session. Core supplies the active turn's threadId; when none is known the message target is used
 * as a fallback (a would-be proactive send, which the reply adapter then rejects). Returns null for
 * a non-AgentMail target so core can fall back to its default routing.
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
}): ReturnType<typeof buildChannelOutboundSessionRoute> | null {
  const target = normalizeAgentMailTarget(params.resolvedTarget?.to ?? params.target);
  if (!target) {
    return null;
  }
  const inboxId = resolveAgentMailAccount(params.cfg, params.accountId).inboxId;
  const threadId =
    params.threadId === undefined || params.threadId === null || params.threadId === ""
      ? undefined
      : String(params.threadId);
  const conversationId =
    inboxId && threadId ? buildAgentMailConversationId(inboxId, threadId) : target;
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: CHANNEL_ID,
    accountId: params.accountId,
    recipientSessionExact: true,
    peer: { kind: "direct", id: conversationId },
    chatType: "direct",
    from: `agentmail:${conversationId}`,
    to: target,
    ...(threadId ? { threadId } : {}),
  });
}
