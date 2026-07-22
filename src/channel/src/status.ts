import { createAgentMailClient } from "./client.js";
import { errorText } from "./log.js";
import {
  type AgentMailIngressMode,
  type ResolvedAgentMailAccount,
  resolveAgentMailIngressMode,
} from "./types.js";

export type AgentMailProbe = {
  ok: boolean;
  inboxId: string;
  ingressMode: AgentMailIngressMode;
  error?: string;
};

export async function probeAgentMailAccount(params: {
  account: ResolvedAgentMailAccount;
}): Promise<AgentMailProbe> {
  const ingressMode = resolveAgentMailIngressMode(params.account);
  try {
    await createAgentMailClient(params.account).inboxes.get(params.account.inboxId);
    return { ok: true, inboxId: params.account.inboxId, ingressMode };
  } catch (error) {
    return {
      ok: false,
      inboxId: params.account.inboxId,
      ingressMode,
      error: errorText(error),
    };
  }
}
