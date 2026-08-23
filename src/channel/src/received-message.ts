import type { AgentMail } from "agentmail";

export const AGENTMAIL_RECEIVED_LABEL = "received";
// Email timestamps are sender-authored and may have arbitrary clock skew. Keep their contribution
// to durable retention bounded so malformed dates cannot pin tombstones for years.
export const AGENTMAIL_PROVIDER_FUTURE_SKEW_MAX_MS = 24 * 60 * 60 * 1000;

export function normalizeAgentMailInboxId(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export function agentMailInboxIdsEqual(left: string, right: string): boolean {
  return normalizeAgentMailInboxId(left) === normalizeAgentMailInboxId(right);
}

export function isValidAgentMailTimestampMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function resolveAgentMailTimestampMs(value: unknown): number | null {
  const timestampMs =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string" || typeof value === "number"
        ? new Date(value).getTime()
        : Number.NaN;
  return isValidAgentMailTimestampMs(timestampMs) ? timestampMs : null;
}

export function capAgentMailProviderTimestampForRetention(
  timestampMs: number,
  observedAtMs: number,
): number {
  return Math.min(timestampMs, observedAtMs + AGENTMAIL_PROVIDER_FUTURE_SKEW_MAX_MS);
}

export function isReceivedAgentMailMessage(
  message: AgentMail.MessageItem | AgentMail.Message,
  inboxId: string,
): boolean {
  if (!agentMailInboxIdsEqual(message.inboxId, inboxId)) {
    return false;
  }
  const labels = Array.isArray(message.labels) ? message.labels : [];
  return labels.some(
    (label) => String(label).toLocaleLowerCase("en-US") === AGENTMAIL_RECEIVED_LABEL,
  );
}

export function resolveReceivedAgentMailMessageTimestampMs(
  message: AgentMail.MessageItem | AgentMail.Message,
  inboxId: string,
): number | null {
  if (!isReceivedAgentMailMessage(message, inboxId)) {
    return null;
  }
  return resolveAgentMailTimestampMs(message.timestamp);
}
