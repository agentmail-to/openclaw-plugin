import { buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";

export type AgentMailCliConfig = {
  baseUrl?: string;
};

export const agentMailCliConfigJsonSchema = {
  type: "object",
  properties: {
    baseUrl: {
      type: "string",
      description: "Optional AgentMail API base URL override for the bundled CLI.",
      format: "uri",
    },
    timeoutSeconds: {
      type: "integer",
      description:
        "Deprecated tool setting retained for upgrade compatibility; the bundled CLI ignores it.",
      minimum: 1,
      maximum: 300,
    },
    maxRetries: {
      type: "integer",
      description:
        "Deprecated tool setting retained for upgrade compatibility; the bundled CLI ignores it.",
      minimum: 0,
      maximum: 10,
    },
  },
  additionalProperties: false,
};

export const agentMailCliConfigSchema = buildJsonPluginConfigSchema(
  agentMailCliConfigJsonSchema as Parameters<typeof buildJsonPluginConfigSchema>[0],
);

export function parseAgentMailCliConfig(value: unknown): AgentMailCliConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const baseUrl = (value as Record<string, unknown>).baseUrl;
  return typeof baseUrl === "string" && baseUrl.trim()
    ? { baseUrl: baseUrl.trim() }
    : {};
}
