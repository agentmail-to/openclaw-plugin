import { rm } from "node:fs/promises";
import { AgentMailError, type AgentMail, type AgentMailClient } from "agentmail";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { htmlToMarkdown, markdownToText } from "openclaw/plugin-sdk/web-content-extractor";
import type { AgentMailLog } from "./log.js";
import { createAgentMailClient } from "./client.js";
import { isAgentMailSenderAllowed, parseSingleFromMailbox } from "./mailbox.js";
import { AgentMailMediaPolicyError, loadAgentMailInboundAttachments } from "./media.js";
import type { AgentMailIngressRecord, ResolvedAgentMailAccount } from "./types.js";

const CHANNEL_ID = "agentmail";
export const HYDRATION_NOT_FOUND_RETRY_WINDOW_MS = 5 * 60_000;

// AgentMail message labels the channel gates on. "received" marks authentic inbound mail; the
// rejected set marks provider-flagged mail that must never reach the agent.
export const AGENTMAIL_RECEIVED_LABEL = "received";
const AGENTMAIL_REJECTED_LABELS = ["spam", "blocked", "unauthenticated"];

/**
 * Thrown when a hydrated message has not yet gained its `received` label. Carries a marker the
 * ingress retry loop recognizes so the retry stays inside the bounded hydration window (like a 404),
 * instead of settling the durable row and dropping the message on a label-projection race.
 */
export class AgentMailLabelPendingError extends Error {
  readonly hydrationPending = true;
  constructor(messageId: string) {
    super(`AgentMail message ${messageId} has no received label yet`);
    this.name = "AgentMailLabelPendingError";
  }
}

export type AgentMailChannelRuntime = Pick<
  PluginRuntime["channel"],
  "inbound" | "reply" | "routing" | "session"
>;

/**
 * The per-thread conversation id used to key an agent session. Inbound turns and the outbound
 * message-tool session route MUST derive it identically so a reply resolves the same session the
 * inbound turn runs in.
 */
export function buildAgentMailConversationId(inboxId: string, threadId: string): string {
  return `${inboxId}:thread:${threadId}`;
}

/**
 * The agent session key for an AgentMail conversation. Both the inbound turn and the outbound
 * message-tool route derive it through this one function so they resolve the SAME session.
 *
 * dmScope is FORCED to per-account-channel-peer: email threads must stay isolated even under the
 * default global scope ("main"), which would otherwise collapse every direct peer to
 * `agent:<id>:main`. This matches the runtime's own buildAgentSessionKey (the same pure function),
 * so inbound and outbound produce identical keys.
 */
export function buildAgentMailSessionKey(params: {
  agentId: string;
  accountId?: string | null;
  conversationId: string;
}): string {
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: CHANNEL_ID,
    accountId: params.accountId,
    peer: { kind: "direct", id: params.conversationId },
    dmScope: "per-account-channel-peer",
  });
}

export function resolveAgentMailMessageText(message: AgentMail.Message): string {
  // AgentMail strips quoted reply/forward history in the extracted fields. Prefer those fields
  // so an email thread does not re-inject its accumulated transcript into every agent turn.
  const extractedText = message.extractedText?.trim();
  if (extractedText) {
    return extractedText;
  }
  const extractedHtml = message.extractedHtml?.trim();
  const extractedHtmlText = extractedHtml
    ? markdownToText(htmlToMarkdown(extractedHtml).text).trim()
    : "";
  if (extractedHtmlText) {
    return extractedHtmlText;
  }
  const text = message.text?.trim();
  if (text) {
    return text;
  }
  const html = message.html?.trim();
  const htmlText = html ? markdownToText(htmlToMarkdown(html).text).trim() : "";
  return htmlText || message.subject?.trim() || "";
}

function messageLabels(message: AgentMail.Message): string[] {
  // Guard against a malformed hydrated payload: a missing/non-array `labels` would otherwise throw
  // in .map/.some, fail every dispatch attempt, and eventually poison-drop a valid message.
  return Array.isArray(message.labels)
    ? message.labels.map((label) => String(label).toLocaleLowerCase("en-US"))
    : [];
}

function hasRejectedLabel(message: AgentMail.Message): boolean {
  return messageLabels(message).some((label) => AGENTMAIL_REJECTED_LABELS.includes(label));
}

function hasReceivedLabel(message: AgentMail.Message): boolean {
  return messageLabels(message).includes(AGENTMAIL_RECEIVED_LABEL);
}

async function hydrateMessage(params: {
  account: ResolvedAgentMailAccount;
  record: AgentMailIngressRecord;
  client: AgentMailClient;
}): Promise<AgentMail.Message> {
  const message = await params.client.inboxes.messages.get(
    params.account.inboxId,
    params.record.messageId,
  );
  return message;
}

export async function dispatchAgentMailInboundEvent(params: {
  cfg: OpenClawConfig;
  account: ResolvedAgentMailAccount;
  record: AgentMailIngressRecord;
  channelRuntime: AgentMailChannelRuntime;
  client?: AgentMailClient;
  log?: AgentMailLog;
  onTurnAdopted?: () => void | Promise<void>;
  now?: () => number;
}): Promise<void> {
  const client = params.client ?? createAgentMailClient(params.account);
  let message: AgentMail.Message;
  try {
    message = await hydrateMessage({
      account: params.account,
      record: params.record,
      client,
    });
  } catch (error) {
    if (error instanceof AgentMailError && error.statusCode === 404) {
      // Measure from local ingestion, not the (possibly back-dated) email timestamp, so delayed
      // mail is not discarded on its first 404 while the provider's REST projection catches up.
      const arrivedAt = params.record.arrivedAt ?? params.record.receivedAt;
      const ageMs = Math.max(0, (params.now?.() ?? Date.now()) - arrivedAt);
      if (ageMs >= HYDRATION_NOT_FOUND_RETRY_WINDOW_MS) {
        params.log?.warn?.(
          `AgentMail ignored unavailable message ${params.record.messageId} after the hydration retry window`,
        );
        return;
      }
      // A receive event can race the provider's REST projection. Keep the durable row pending
      // during a bounded window; treating the first 404 as deletion can permanently lose mail.
      throw error;
    }
    throw error;
  }
  if (
    message.inboxId !== params.account.inboxId ||
    message.messageId !== params.record.messageId ||
    hasRejectedLabel(message)
  ) {
    // Terminal: a wrong inbox/message or an explicitly rejected (spam/blocked/unauthenticated)
    // message will never become deliverable, so settle the durable row.
    params.log?.warn?.(
      `AgentMail rejected mismatched or unsafe hydrated message ${params.record.messageId}`,
    );
    return;
  }
  if (!hasReceivedLabel(message)) {
    // The "received" label can lag the message's REST projection. Treat its absence as retryable
    // within the bounded hydration window rather than completing the row and silently dropping mail
    // on a timing race; settle only once the window elapses.
    const arrivedAt = params.record.arrivedAt ?? params.record.receivedAt;
    const ageMs = Math.max(0, (params.now?.() ?? Date.now()) - arrivedAt);
    if (ageMs >= HYDRATION_NOT_FOUND_RETRY_WINDOW_MS) {
      params.log?.warn?.(
        `AgentMail settled message ${message.messageId} without a received label after the hydration retry window`,
      );
      return;
    }
    throw new AgentMailLabelPendingError(params.record.messageId);
  }
  const sender = parseSingleFromMailbox(message.from);
  if (!sender) {
    params.log?.warn?.(
      `AgentMail rejected message ${message.messageId} with an ambiguous From mailbox`,
    );
    return;
  }
  // Authoritative sender authorization: a default-deny allowlist (dmPolicy defaults to "allowlist",
  // empty allowFrom denies everyone). The rejected-label check above is anti-spoofing defense in
  // depth (SPF/DKIM/DMARC failures land as "unauthenticated"); it never widens authorization.
  if (
    !isAgentMailSenderAllowed({
      policy: params.account.dmPolicy,
      allowFrom: params.account.allowFrom,
      sender: sender.address,
    })
  ) {
    params.log?.warn?.(`AgentMail sender ${sender.address} is not authorized`);
    return;
  }

  let inboundMedia;
  let attachmentsOmitted = false;
  try {
    inboundMedia = await loadAgentMailInboundAttachments({
      client,
      inboxId: params.account.inboxId,
      messageId: message.messageId,
      attachments: message.attachments ?? [],
      maxBytes: params.account.mediaMaxBytes,
    });
  } catch (error) {
    if (error instanceof AgentMailMediaPolicyError) {
      params.log?.warn?.(
        `AgentMail omitted attachments from message ${message.messageId}: ${error.message}`,
      );
      inboundMedia = { paths: [], types: [] };
      attachmentsOmitted = true;
    } else {
      throw error;
    }
  }
  const content =
    resolveAgentMailMessageText(message) ||
    (inboundMedia.paths.length > 0 ? "[Email with attachments]" : "");
  const attachmentNotice = attachmentsOmitted
    ? "[Attachments omitted because they exceed the configured media limit]"
    : "";
  const body = [content, attachmentNotice].filter(Boolean).join("\n\n");
  if (!body) {
    params.log?.warn?.(`AgentMail ignored empty message ${message.messageId}`);
    return;
  }
  const conversationId = buildAgentMailConversationId(params.account.inboxId, message.threadId);
  const route = params.channelRuntime.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer: { kind: "direct", id: conversationId },
  });
  const sessionKey = buildAgentMailSessionKey({
    agentId: route.agentId,
    accountId: params.account.accountId,
    conversationId,
  });

  let turnAdopted = false;
  // Wrap the lifecycle hook so we can observe adoption locally (for media cleanup) while still
  // forwarding to the ingress lifecycle. onTurnAdopted is read by core but absent from the SDK's
  // param type, so it is spread in the same way the surrounding code passes it.
  const lifecycle = {
    onTurnAdopted: async () => {
      turnAdopted = true;
      await params.onTurnAdopted?.();
    },
  };
  const runPromise = params.channelRuntime.inbound.run({
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    raw: message,
    ...lifecycle,
    adapter: {
      ingest: (raw) => ({
        id: raw.messageId,
        timestamp: raw.timestamp.getTime(),
        rawText: body,
        textForAgent: body,
        textForCommands: body,
        raw,
      }),
      resolveTurn: async (input) => {
        const target = `message:${message.messageId}`;
        const ctxPayload = params.channelRuntime.inbound.buildContext({
          channel: CHANNEL_ID,
          accountId: params.account.accountId,
          timestamp: input.timestamp,
          from: `agentmail:${sender.address}`,
          sender: { id: sender.address, name: sender.name ?? sender.address },
          conversation: {
            kind: "direct",
            id: conversationId,
            label: message.subject || sender.address,
          },
          route: {
            agentId: route.agentId,
            accountId: params.account.accountId,
            routeSessionKey: sessionKey,
            dispatchSessionKey: sessionKey,
          },
          reply: { to: target, replyToId: message.messageId },
          message: {
            rawBody: input.rawText,
            commandBody: input.textForCommands,
            bodyForAgent: input.textForAgent,
          },
          extra: {
            MessageSid: message.messageId,
            MessageThreadId: message.threadId,
            MediaPath: inboundMedia.paths[0],
            MediaPaths: inboundMedia.paths,
            MediaType: inboundMedia.types[0],
            MediaTypes: inboundMedia.types,
          },
        });
        const storePath = params.channelRuntime.session.resolveStorePath(
          params.cfg.session?.store,
          {
            agentId: route.agentId,
          },
        );
        return {
          cfg: params.cfg,
          channel: CHANNEL_ID,
          accountId: params.account.accountId,
          agentId: route.agentId,
          routeSessionKey: sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: params.channelRuntime.session.recordInboundSession,
          dispatchReplyWithBufferedBlockDispatcher:
            params.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
          delivery: {
            durable: () => ({
              to: target,
              replyToId: message.messageId,
              threadId: message.threadId,
              requiredCapabilities: {
                text: true,
                media: inboundMedia.paths.length > 0,
                payload: true,
                replyTo: true,
                thread: true,
                messageSendingHooks: true,
                reconcileUnknownSend: true,
              },
            }),
            deliver: async () => {
              throw new Error("AgentMail requires durable reply delivery");
            },
          },
          // AgentMail owns one durable atomic reply. Message-tool delivery is best-effort and
          // cannot carry the queue id used for the provider idempotency key.
          replyOptions: { disableBlockStreaming: true, sourceReplyDeliveryMode: "automatic" },
        };
      },
    },
  });
  try {
    await runPromise;
  } catch (error) {
    if (!turnAdopted && inboundMedia.paths.length > 0) {
      // The turn never adopted, so core did not take ownership of these freshly-saved attachment
      // files. Remove them so a durable retry (which re-downloads a clean set) does not leak one
      // copy per attempt.
      await Promise.allSettled(inboundMedia.paths.map((path) => rm(path, { force: true })));
    }
    throw error;
  }
}
