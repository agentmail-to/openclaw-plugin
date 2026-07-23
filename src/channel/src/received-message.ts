import type { AgentMail } from "agentmail";

export const AGENTMAIL_RECEIVED_LABEL = "received";

export function normalizeAgentMailInboxId(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export function agentMailInboxIdsEqual(left: string, right: string): boolean {
  return normalizeAgentMailInboxId(left) === normalizeAgentMailInboxId(right);
}

export function resolveAgentMailTimestampMs(value: unknown): number | null {
  const timestampMs =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string" || typeof value === "number"
        ? new Date(value).getTime()
        : Number.NaN;
  return Number.isFinite(timestampMs) && timestampMs >= 0 ? timestampMs : null;
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
