import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";

const AGENTMAIL_CHANNEL_DATA_KEY = "agentmail";
const TRIGGER_ARRIVED_AT_KEY = "triggerArrivedAt";

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Persist local inbound timing with the durable reply so restart reconciliation can classify 404s. */
export function withAgentMailTriggerArrival(
  payload: ReplyPayload,
  triggerArrivedAt: number,
): ReplyPayload {
  const channelData = payload.channelData ?? {};
  const currentAgentMailData = channelData[AGENTMAIL_CHANNEL_DATA_KEY];
  const agentMailData =
    currentAgentMailData && typeof currentAgentMailData === "object"
      ? currentAgentMailData
      : {};
  return {
    ...payload,
    channelData: {
      ...channelData,
      [AGENTMAIL_CHANNEL_DATA_KEY]: {
        ...agentMailData,
        [TRIGGER_ARRIVED_AT_KEY]: triggerArrivedAt,
      },
    },
  };
}

/** Read local inbound timing from a persisted reply, falling back for pre-migration queue rows. */
export function resolveAgentMailTriggerArrival(
  payload: ReplyPayload,
  fallbackAt: number,
): number {
  const agentMailData = payload.channelData?.[AGENTMAIL_CHANNEL_DATA_KEY];
  if (!agentMailData || typeof agentMailData !== "object") {
    return fallbackAt;
  }
  const triggerArrivedAt = (agentMailData as Record<string, unknown>)[TRIGGER_ARRIVED_AT_KEY];
  return validTimestamp(triggerArrivedAt) ? triggerArrivedAt : fallbackAt;
}
