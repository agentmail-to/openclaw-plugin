import { buildPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { buildSecretInputSchema, type SecretInput } from "openclaw/plugin-sdk/secret-input";
import { z } from "openclaw/plugin-sdk/zod";

export type AgentMailCliConfig = {
  apiKey?: SecretInput;
  baseUrl?: string;
};

const SecretInputSchema = buildSecretInputSchema();

const AgentMailCliConfigSchema = z
  .object({
    apiKey: SecretInputSchema.optional(),
    baseUrl: z
      .string()
      .url()
      .optional()
      .describe("Optional AgentMail API base URL override for the bundled CLI."),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(300)
      .optional()
      .describe(
        "Deprecated tool setting retained for upgrade compatibility; the bundled CLI ignores it.",
      ),
    maxRetries: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe(
        "Deprecated tool setting retained for upgrade compatibility; the bundled CLI ignores it.",
      ),
  })
  .strict();

export const agentMailCliConfigSchema = buildPluginConfigSchema(
  AgentMailCliConfigSchema,
  {
    uiHints: {
      apiKey: {
        label: "AgentMail CLI API Key",
        sensitive: true,
        help: "Operator-controlled credential passed only to the bundled AgentMail CLI.",
      },
      baseUrl: { label: "AgentMail CLI Base URL" },
    },
  },
);
export const agentMailCliConfigJsonSchema: Record<string, unknown> =
  agentMailCliConfigSchema.jsonSchema!;

export function parseAgentMailCliConfig(value: unknown): AgentMailCliConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const config = value as Record<string, unknown>;
  const baseUrl = config.baseUrl;
  return {
    ...(typeof config.apiKey === "string" ||
    (config.apiKey !== null && typeof config.apiKey === "object")
      ? { apiKey: config.apiKey as SecretInput }
      : {}),
    ...(typeof baseUrl === "string" && baseUrl.trim()
      ? { baseUrl: baseUrl.trim() }
      : {}),
  };
}
