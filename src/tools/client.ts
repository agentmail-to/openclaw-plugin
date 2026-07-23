import { AgentMailClient } from "agentmail";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { Type, type Static } from "typebox";
import { resolveAgentMailAccount } from "../channel/src/accounts.js";

export const agentMailConfigSchema = Type.Object(
  {
    baseUrl: Type.Optional(
      Type.String({
        description: "Optional AgentMail API base URL override.",
        format: "uri",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Integer({
        description: "Maximum time to wait for an AgentMail API request.",
        minimum: 1,
        maximum: 300,
      }),
    ),
    maxRetries: Type.Optional(
      Type.Integer({
        description: "Number of times the AgentMail SDK retries a request.",
        minimum: 0,
        maximum: 10,
      }),
    ),
  },
  { additionalProperties: false },
);

export type AgentMailConfig = Static<typeof agentMailConfigSchema>;

export function createAgentMailClient(
  config: AgentMailConfig,
  hostConfig?: OpenClawConfig,
): AgentMailClient {
  // The channel and tools share one plugin. Prefer the resolved channel credential so a secret
  // entered through channel configuration works for both, while preserving tools-only env setup.
  const envApiKey = process.env.AGENTMAIL_API_KEY?.trim();
  let channelApiKey = "";
  let channelResolutionError: unknown;
  if (hostConfig) {
    try {
      channelApiKey = resolveAgentMailAccount(hostConfig).apiKey;
    } catch (error) {
      // Tool execution can receive the unresolved persisted config outside a gateway secret
      // snapshot. Keep the environment fallback reachable; if it is absent, preserve the precise
      // unresolved-secret diagnostic instead of replacing it with a generic configuration error.
      channelResolutionError = error;
    }
  }
  const apiKey = channelApiKey || envApiKey;

  if (!apiKey) {
    if (channelResolutionError) {
      throw channelResolutionError;
    }
    throw new Error(
      "AgentMail is not configured. Configure channels.agentmail.apiKey or set AGENTMAIL_API_KEY and restart OpenClaw.",
    );
  }

  return new AgentMailClient({
    apiKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.timeoutSeconds ? { timeoutInSeconds: config.timeoutSeconds } : {}),
    ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
  });
}

export function requestOptions(signal?: AbortSignal): { abortSignal?: AbortSignal } {
  return signal ? { abortSignal: signal } : {};
}
