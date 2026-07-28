import { AgentMailError, type AgentMailClient } from "agentmail";
import type {
  ChannelMessageSendPayloadContext,
  ChannelMessageSendTextContext,
  ChannelMessageUnknownSendContext,
  ChannelMessageUnknownSendReconciliationResult,
} from "openclaw/plugin-sdk/channel-outbound";
import { LocalMediaAccessError } from "openclaw/plugin-sdk/web-media";
import { errorText } from "./log.js";
import { resolveAgentMailAccount } from "./accounts.js";
import { createAgentMailClient } from "./client.js";
import { sha256Hex } from "./digest.js";
import { isAgentMailSenderAllowed, parseSingleFromMailbox } from "./mailbox.js";
import { AgentMailMediaPolicyError, loadAgentMailOutboundAttachments } from "./media.js";
import { agentMailInboxIdsEqual } from "./received-message.js";
import { HYDRATION_NOT_FOUND_RETRY_WINDOW_MS } from "./inbound.js";

// A media-size policy violation is genuinely terminal: the same payload will always exceed the
// limit, so retrying the reply is pointless.
function isTerminalMediaPolicyFailure(error: unknown): error is AgentMailMediaPolicyError {
  return error instanceof AgentMailMediaPolicyError;
}

// Host-local attachment access failures during reconciliation are NOT terminal. The unknown-send
// recovery context drops the mediaAccess/mediaLocalRoots/mediaReadFile handles, so a file:// URL
// that the original (fully-provisioned) send could read now raises a local-access error. The normal
// queue retry retains those handles, so these must be reported retryable rather than dropped.
function isHostLocalMediaFailure(error: unknown): boolean {
  if (error instanceof LocalMediaAccessError) {
    return true;
  }
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EISDIR" || code === "ENOTDIR";
}

// A 404 while re-hydrating the triggering message means it was deleted; the reply can never be sent,
// so fail fast instead of consuming the bounded retry budget before dead-lettering.
function isDeletedTriggerFailure(error: unknown, recoveryAgeMs: number): boolean {
  return (
    error instanceof AgentMailError &&
    error.statusCode === 404 &&
    recoveryAgeMs >= HYDRATION_NOT_FOUND_RETRY_WINDOW_MS
  );
}

// Transient failures during reconciliation (provider 5xx/throttling or network) resolve on their
// own; report them retryable so the durable queue keeps trying instead of escaping the reconciler as
// an unhandled throw. 404 is intentionally excluded (handled as a terminal deletion above).
function isTransientReplyFailure(error: unknown): boolean {
  if (error instanceof AgentMailError) {
    const status = error.statusCode;
    return (
      status === undefined ||
      status === 408 ||
      status === 429 ||
      (typeof status === "number" && status >= 500)
    );
  }
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "EAI_AGAIN" ||
    code === "EPIPE"
  );
}

const TARGET_PREFIX = "message:";
// AgentMail expires idempotency keys 24 hours after a completed send. Stop one hour early because
// an unknown completion time cannot safely prove that another retry will still reuse the key.
const AGENTMAIL_UNKNOWN_SEND_MAX_AGE_MS = 23 * 60 * 60 * 1000;

function hasInvalidMessageIdCharacter(messageId: string): boolean {
  for (const character of messageId) {
    const code = character.codePointAt(0) ?? 0;
    if (character.trim() === "" || code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

export function normalizeAgentMailTarget(value: string | null | undefined): string | null {
  const target = value?.trim();
  if (!target?.startsWith(TARGET_PREFIX)) {
    return null;
  }
  const messageId = target.slice(TARGET_PREFIX.length).trim();
  return messageId && !hasInvalidMessageIdCharacter(messageId)
    ? `${TARGET_PREFIX}${messageId}`
    : null;
}

export function parseAgentMailMessageTarget(value: string): string {
  const normalized = normalizeAgentMailTarget(value);
  if (!normalized) {
    throw new Error(
      "AgentMail target must be message:<messageId>; new threads and recipients are not supported.",
    );
  }
  return normalized.slice(TARGET_PREFIX.length);
}

function idempotencyKey(queueId: string): string {
  const hash = sha256Hex(`agentmail-reply\n${queueId}`);
  return `openclaw-agentmail-${hash}`;
}

type AgentMailSendContext = Pick<
  ChannelMessageSendTextContext,
  | "cfg"
  | "to"
  | "text"
  | "accountId"
  | "replyToId"
  | "replyToIdSource"
  | "deliveryQueueId"
  | "onPlatformSendDispatch"
> &
  Partial<
    Pick<
      ChannelMessageSendPayloadContext,
      "payload" | "mediaUrl" | "mediaAccess" | "mediaLocalRoots" | "mediaReadFile"
    >
  >;

function assertTriggeringMessageBoundary(
  ctx: Pick<AgentMailSendContext, "replyToId" | "replyToIdSource">,
  triggeringMessageId: string,
): void {
  if (ctx.replyToIdSource !== "implicit" || ctx.replyToId !== triggeringMessageId) {
    throw new Error(
      "AgentMail replies must remain bound to the triggering message for the active inbound turn.",
    );
  }
}

function collectMediaUrls(ctx: AgentMailSendContext): string[] {
  if (!ctx.payload) {
    return [];
  }
  return [
    ...new Set(
      [ctx.mediaUrl, ctx.payload.mediaUrl, ...(ctx.payload.mediaUrls ?? [])]
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

async function sendBoundAgentMailReply(
  ctx: AgentMailSendContext,
  triggeringMessageId: string,
  options: { client?: AgentMailClient },
) {
  const account = resolveAgentMailAccount(ctx.cfg, ctx.accountId);
  if (!ctx.deliveryQueueId) {
    throw new Error("AgentMail replies require a durable OpenClaw delivery queue ID.");
  }
  const client = options.client ?? createAgentMailClient(account);
  // The provider otherwise prefers the original Reply-To header over From. Re-hydrate the
  // triggering message and explicitly bind `to` to the same authoritative sender we authorize
  // inbound, preventing an allowlisted sender from redirecting the agent reply.
  const triggeringMessage = await client.inboxes.messages.get(account.inboxId, triggeringMessageId);
  if (
    !agentMailInboxIdsEqual(triggeringMessage.inboxId, account.inboxId) ||
    triggeringMessage.messageId !== triggeringMessageId
  ) {
    throw new Error("AgentMail reply target did not hydrate to the configured inbox and message.");
  }
  const sender =
    typeof triggeringMessage.from === "string"
      ? parseSingleFromMailbox(triggeringMessage.from)
      : null;
  if (
    !sender ||
    !isAgentMailSenderAllowed({
      policy: account.dmPolicy,
      allowFrom: account.allowFrom,
      sender: sender.address,
    })
  ) {
    throw new Error("AgentMail reply recipient is not an authorized triggering sender.");
  }

  const mediaUrls = collectMediaUrls(ctx);
  const attachments = await loadAgentMailOutboundAttachments({
    mediaUrls,
    maxBytes: account.mediaMaxBytes,
    ...(ctx.mediaAccess ? { mediaAccess: ctx.mediaAccess } : {}),
    ...(ctx.mediaLocalRoots ? { mediaLocalRoots: ctx.mediaLocalRoots } : {}),
    ...(ctx.mediaReadFile ? { mediaReadFile: ctx.mediaReadFile } : {}),
  });
  const text = (ctx.payload?.text ?? ctx.text)?.trim() || undefined;
  if (!text && attachments.length === 0) {
    throw new Error("AgentMail reply must contain text or at least one attachment.");
  }
  await ctx.onPlatformSendDispatch?.();
  const result = await client.inboxes.messages.reply(
    account.inboxId,
    triggeringMessageId,
    {
      ...(text ? { text } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      to: [sender.address],
      replyAll: false,
    },
    { idempotencyKey: idempotencyKey(ctx.deliveryQueueId) },
  );
  return {
    channel: "agentmail" as const,
    messageId: result.messageId,
    chatId: result.threadId,
    receipt: {
      primaryPlatformMessageId: result.messageId,
      platformMessageIds: [result.messageId],
      parts: [
        {
          platformMessageId: result.messageId,
          kind: attachments.length > 0 ? ("media" as const) : ("text" as const),
          index: 0,
          threadId: result.threadId,
          replyToId: triggeringMessageId,
        },
      ],
      threadId: result.threadId,
      replyToId: triggeringMessageId,
      sentAt: Date.now(),
    },
  };
}

export async function sendAgentMailReply(
  ctx: AgentMailSendContext,
  options: { client?: AgentMailClient } = {},
) {
  const triggeringMessageId = parseAgentMailMessageTarget(ctx.to);
  assertTriggeringMessageBoundary(ctx, triggeringMessageId);
  return await sendBoundAgentMailReply(ctx, triggeringMessageId, options);
}

/**
 * Repeats an uncertain reply with the same queue-derived AgentMail idempotency key. AgentMail
 * returns the original reply for a committed key, so this both reconciles and completes recovery.
 */
export async function reconcileAgentMailUnknownSend(
  ctx: ChannelMessageUnknownSendContext,
  options: { client?: AgentMailClient; now?: () => number } = {},
): Promise<ChannelMessageUnknownSendReconciliationResult> {
  if (ctx.payloads.length !== 1 || (ctx.renderedBatchPlan?.items.length ?? 1) !== 1) {
    return {
      status: "unresolved",
      error: "AgentMail reconciliation requires exactly one atomic reply payload",
      retryable: false,
    };
  }
  const payload = ctx.payloads[0];
  if (!payload) {
    return { status: "not_sent" };
  }
  const rendered = ctx.renderedBatchPlan?.items[0];
  const normalizedTarget = normalizeAgentMailTarget(ctx.to);
  if (!normalizedTarget) {
    return {
      status: "unresolved",
      error:
        "AgentMail target must be message:<messageId>; new threads and recipients are not supported.",
      retryable: false,
    };
  }
  const triggeringMessageId = normalizedTarget.slice(TARGET_PREFIX.length);
  if (ctx.effectiveReplyToId !== triggeringMessageId) {
    return {
      status: "unresolved",
      error: "AgentMail recovery target is not bound to its triggering message",
      retryable: false,
    };
  }
  const recoveryReferenceAt = ctx.platformSendStartedAt ?? ctx.enqueuedAt;
  const recoveryAgeMs = Math.max(0, (options.now?.() ?? Date.now()) - recoveryReferenceAt);
  if (recoveryAgeMs >= AGENTMAIL_UNKNOWN_SEND_MAX_AGE_MS) {
    return {
      status: "unresolved",
      error: "AgentMail recovery is too close to the provider idempotency-key expiry",
      retryable: false,
    };
  }
  // A rendered plan is authoritative even when its media list is empty: capability filtering may
  // intentionally have removed media that still appears on the original queued payload.
  const mediaUrls = (rendered
    ? [...rendered.mediaUrls]
    : [payload.mediaUrl, ...(payload.mediaUrls ?? [])]
  ).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const text = rendered?.text ?? payload.text ?? "";
  const recoveredPayload = { ...payload, text };
  delete recoveredPayload.mediaUrl;
  delete recoveredPayload.mediaUrls;
  if (mediaUrls.length > 0) {
    recoveredPayload.mediaUrls = mediaUrls;
  }
  if (!text.trim() && mediaUrls.length === 0) {
    // The recovered reply has neither text nor media. sendBoundAgentMailReply would reject this as a
    // hard error; during reconciliation it simply means nothing was ever sendable, so report a
    // structured verdict instead of letting the guard throw out of the reconciler.
    return { status: "not_sent" };
  }
  let result;
  try {
    result = await sendBoundAgentMailReply(
      {
        cfg: ctx.cfg,
        to: ctx.to,
        text,
        accountId: ctx.accountId,
        deliveryQueueId: ctx.queueId,
        payload: recoveredPayload,
        // The unknown-send reconciliation context does not carry local media-access handles in this
        // SDK, so outbound attachments here are recovered from their URLs with default access.
      },
      triggeringMessageId,
      options,
    );
  } catch (error) {
    if (isTerminalMediaPolicyFailure(error)) {
      return { status: "unresolved", error: error.message, retryable: false };
    }
    if (isDeletedTriggerFailure(error, recoveryAgeMs)) {
      // A 404 that persists beyond the provider projection window is treated as deletion.
      return { status: "unresolved", error: errorText(error), retryable: false };
    }
    // Host-local media access (dropped recovery handles) and transient hydration/provider failures
    // both resolve on a later attempt, so keep the queue retrying rather than throwing out.
    if (
      isHostLocalMediaFailure(error) ||
      isTransientReplyFailure(error) ||
      (error instanceof AgentMailError && error.statusCode === 404)
    ) {
      return { status: "unresolved", error: errorText(error), retryable: true };
    }
    throw error;
  }
  return { status: "sent", messageId: result.messageId, receipt: result.receipt };
}
