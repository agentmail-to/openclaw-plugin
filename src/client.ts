import { AgentMailClient } from "agentmail";
import { Type, type Static } from "typebox";

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

export function createAgentMailClient(config: AgentMailConfig): AgentMailClient {
  const apiKey = process.env.AGENTMAIL_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      "AgentMail is not configured. Set the AGENTMAIL_API_KEY environment variable and restart OpenClaw.",
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
