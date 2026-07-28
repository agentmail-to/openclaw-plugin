import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
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
  currentSessionKey?: string;
  target?: string;
  resolvedTarget?: { to: string };
  threadId?: string | number | null;
}): AgentMailOutboundSessionRoute | null {
  const target = normalizeAgentMailTarget(params.resolvedTarget?.to ?? params.target);
  if (!target) {
    return null;
  }
  const hasExplicitAccount = params.accountId != null && String(params.accountId).trim() !== "";
  const parsedCurrentSession = parseAgentSessionKey(params.currentSessionKey);
  const currentRouteParts = parsedCurrentSession?.rest.split(":") ?? [];
  const inferredAccountId =
    parsedCurrentSession?.agentId === params.agentId.toLowerCase() &&
    currentRouteParts[0] === "agentmail" &&
    currentRouteParts[2] === "direct"
      ? currentRouteParts[1]
      : undefined;
  const effectiveAccountId = hasExplicitAccount ? params.accountId : inferredAccountId;
  if (!effectiveAccountId && listAgentMailAccountIds(params.cfg).length > 1) {
    // Without an account id, a multi-account route cannot be tied safely to the named account that
    // owns the active inbound session. Decline rather than fabricating a recipient-exact route
    // under the configured default account.
    return null;
  }
  // Resolve the account so the session key uses the same canonical accountId the inbound turn uses
  // (a raw or undefined params.accountId would otherwise diverge, breaking continuity for a single
  // named account). The account is explicit, uniquely configured, or inferred from the active
  // inbound session; ambiguous multi-account sends are declined above.
  const resolved = resolveAgentMailAccount(params.cfg, effectiveAccountId);
  const inboxId = resolved.inboxId;
  const threadId =
    params.threadId === undefined || params.threadId === null || params.threadId === ""
      ? undefined
      : String(params.threadId);
  // Thread is encoded in the conversation id (matching inbound), so the session key stays flat — no
  // separate route threadId that could add a divergent thread suffix.
  const conversationId =
    inboxId && threadId ? buildAgentMailConversationId(inboxId, threadId) : target;
  if (
    inferredAccountId &&
    currentRouteParts.slice(3).join(":") !== conversationId
  ) {
    // A current session from another AgentMail thread is not evidence for this target's account.
    return null;
  }
  const sessionKey = buildAgentMailSessionKey({
    agentId: params.agentId,
    accountId: resolved.accountId,
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
