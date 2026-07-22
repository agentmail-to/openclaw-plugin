import { waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import type { AgentMailLog } from "./log.js";
import {
  collectAgentMailAccountIdWarnings,
  findConflictingAgentMailInboxOwner,
} from "./accounts.js";
import {
  createAgentMailCatchUpSession,
  createAgentMailCatchUpSupervisor,
  startAgentMailPeriodicCatchUp,
} from "./catch-up.js";
import { createAgentMailClient } from "./client.js";
import { waitForRetry } from "./retry.js";
import { createAgentMailDurableInboundReceiveJournal } from "./durable-receive.js";
import { dispatchAgentMailInboundEvent, type AgentMailChannelRuntime } from "./inbound.js";
import { processAgentMailIngress, replayPendingAgentMailIngress } from "./ingress.js";
import type { AgentMailIngressRecord, ResolvedAgentMailAccount } from "./types.js";
import { createAgentMailWebhookHandler, createAgentMailWebhookVerifier } from "./webhook.js";
import { startAgentMailWebSocket } from "./websocket.js";

type ActiveRoute = { path: string; unregister: () => void };

const activeRoutes = new Map<string, ActiveRoute>();
const routeOwners = new Map<string, string>();

// Single source of truth for AgentMail sender-authorization warnings, shared by gateway startup
// diagnostics and the channel security surface so the two never drift.
export function collectAgentMailSecurityWarnings(account: ResolvedAgentMailAccount): string[] {
  const warnings: string[] = [];
  if (account.dmPolicy === "allowlist" && account.allowFrom.length === 0) {
    warnings.push("- AgentMail: the default allowlist is empty, so every sender is denied.");
  }
  if (account.dmPolicy === "allowlist" && account.allowFrom.includes("*")) {
    warnings.push(
      '- AgentMail: dmPolicy="allowlist" ignores allowFrom=["*"] and still denies every sender; use dmPolicy="open" to allow all.',
    );
  }
  if (account.dmPolicy === "open" && !account.allowFrom.includes("*")) {
    warnings.push('- AgentMail: dmPolicy="open" requires allowFrom=["*"].');
  }
  return warnings;
}

export function collectAgentMailStartupWarnings(account: ResolvedAgentMailAccount): string[] {
  const warnings: string[] = [];
  if (!account.apiKey || !account.inboxId) {
    warnings.push("- AgentMail: apiKey and inboxId are required.");
  }
  warnings.push(...collectAgentMailSecurityWarnings(account));
  return warnings;
}

export async function startAgentMailGatewayAccount(params: {
  cfg: OpenClawConfig;
  account: ResolvedAgentMailAccount;
  channelRuntime: AgentMailChannelRuntime;
  abortSignal: AbortSignal;
  log?: AgentMailLog;
}): Promise<void> {
  if (!params.account.enabled) {
    return await waitUntilAbort(params.abortSignal);
  }
  const warnings = [
    ...collectAgentMailStartupWarnings(params.account),
    ...collectAgentMailAccountIdWarnings(params.cfg),
  ];
  for (const warning of warnings) {
    params.log?.warn?.(warning);
  }
  if (!params.account.apiKey || !params.account.inboxId) {
    return await waitUntilAbort(params.abortSignal);
  }
  const inboxOwner = findConflictingAgentMailInboxOwner(params.cfg, params.account);
  if (inboxOwner) {
    // Another account already owns this inbox. Do not start a second consumer over a separate
    // durable journal — both would process and reply to the same message. Idle until reconfigured.
    params.log?.warn?.(
      `- AgentMail: account ${params.account.accountId} shares inbox ${params.account.inboxId} with account ${inboxOwner}; not starting a duplicate consumer.`,
    );
    return await waitUntilAbort(params.abortSignal);
  }
  const client = createAgentMailClient(params.account);

  const journal = createAgentMailDurableInboundReceiveJournal({
    accountId: params.account.accountId,
    inboxId: params.account.inboxId,
  });
  const dispatch = async (
    record: AgentMailIngressRecord,
    lifecycle: { onTurnAdopted: () => Promise<void> },
  ) =>
    await dispatchAgentMailInboundEvent({
      cfg: params.cfg,
      account: params.account,
      record,
      channelRuntime: params.channelRuntime,
      client,
      log: params.log,
      onTurnAdopted: lifecycle.onTurnAdopted,
    });
  const receive = async (record: AgentMailIngressRecord) => {
    await processAgentMailIngress({
      journal,
      record,
      dispatch,
      abortSignal: params.abortSignal,
      log: params.log,
    });
  };
  await replayPendingAgentMailIngress({
    journal,
    dispatch,
    abortSignal: params.abortSignal,
    log: params.log,
  });

  const startWebSocket = () =>
    startAgentMailWebSocket({
      account: params.account,
      abortSignal: params.abortSignal,
      receive,
      log: params.log,
      client,
    });

  if (!params.account.webhookSecret) {
    params.log?.info?.(
      `Starting AgentMail WebSocket ingress for account ${params.account.accountId}`,
    );
    return await startWebSocket();
  }

  const verifier = createAgentMailWebhookVerifier(params.account.webhookSecret);
  if (!verifier) {
    // A malformed secret would otherwise throw from new Webhook() and abort startup with no ingress.
    params.log?.warn?.(
      `- AgentMail: webhook secret for account ${params.account.accountId} is invalid; falling back to WebSocket ingress.`,
    );
    return await startWebSocket();
  }

  const path = params.account.webhookPath.startsWith("/")
    ? params.account.webhookPath
    : `/${params.account.webhookPath}`;
  const owner = routeOwners.get(path);
  if (owner && owner !== params.account.accountId) {
    throw new Error(
      `AgentMail webhook path ${path} is already registered by account ${owner}; configure a distinct webhookPath.`,
    );
  }
  const previousRoute = activeRoutes.get(params.account.accountId);
  if (previousRoute) {
    previousRoute.unregister();
    if (routeOwners.get(previousRoute.path) === params.account.accountId) {
      routeOwners.delete(previousRoute.path);
    }
  }
  const catchUpSession = await createAgentMailCatchUpSession({
    account: params.account,
    client,
    log: params.log,
  });
  const catchUpSupervisor = createAgentMailCatchUpSupervisor({
    session: catchUpSession,
    receive,
    abortSignal: params.abortSignal,
    log: params.log,
  });
  const receiveWithRecovery = async (record: AgentMailIngressRecord) => {
    try {
      await receive(record);
    } catch (error) {
      // Provider retries remain useful, but REST recovery is the durable fallback if the provider
      // exhausts them while local admission is full or temporarily unavailable.
      catchUpSupervisor.request();
      throw error;
    }
  };
  const unregister = registerPluginHttpRoute({
    path,
    auth: "plugin",
    pluginId: "agentmail",
    accountId: params.account.accountId,
    handler: createAgentMailWebhookHandler({
      account: params.account,
      verifier,
      receive: receiveWithRecovery,
      log: params.log,
    }),
  });
  const activeRoute = { path, unregister };
  activeRoutes.set(params.account.accountId, activeRoute);
  routeOwners.set(path, params.account.accountId);
  params.log?.info?.(
    `Registered AgentMail webhook route ${path} for account ${params.account.accountId}`,
  );
  catchUpSupervisor.request();
  // Run periodic REST recovery in webhook mode too. Otherwise, once a capacity pause clears the
  // request, mail admitted after the pause would wait for the next provider webhook (or forever, if
  // provider retries have expired) before catch-up runs again.
  const periodicWorkers = startAgentMailPeriodicCatchUp({
    supervisor: catchUpSupervisor,
    abortSignal: params.abortSignal,
  });
  await waitUntilAbort(params.abortSignal, () => {
    // A replaced account invocation can abort later; it must not delete the newer registration.
    if (activeRoutes.get(params.account.accountId) === activeRoute) {
      unregister();
      activeRoutes.delete(params.account.accountId);
      if (routeOwners.get(path) === params.account.accountId) {
        routeOwners.delete(path);
      }
    }
  });
  await Promise.allSettled([...periodicWorkers, catchUpSupervisor.settle()]);
}
