import {
  AllowFromListSchema,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
// Use the SDK's own zod instance so schemas built here are assignable to SDK helpers
// (buildChannelConfigSchema); mixing a second zod copy triggers structural type mismatches.
import { z } from "openclaw/plugin-sdk/zod";

// Per-message media buffer limits (MiB), co-located: the default applied when unset, and the
// documented upper bound the schema enforces.
export const AGENTMAIL_MEDIA_DEFAULT_MB = 20;
export const AGENTMAIL_MEDIA_MAX_MB = 100;

const SecretInputSchema = buildSecretInputSchema();

const AgentMailAccountConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    apiKey: SecretInputSchema.optional(),
    inboxId: z.string().min(1).optional(),
    webhookSecret: SecretInputSchema.optional(),
    webhookPath: z.string().optional(),
    dmPolicy: z.enum(["allowlist", "open", "disabled"]).optional(),
    allowFrom: AllowFromListSchema,
    // Bounded so a typo cannot request an impractically large per-message buffer. 100 MiB comfortably
    // exceeds typical provider attachment limits; accounts.ts still floors this to finite integer bytes.
    mediaMaxMb: z.number().positive().max(AGENTMAIL_MEDIA_MAX_MB).optional(),
  })
  .strict();

const AgentMailConfigSchema = AgentMailAccountConfigSchema.safeExtend({
  accounts: z.record(z.string(), AgentMailAccountConfigSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  const requireOpenWildcard = (params: {
    dmPolicy: typeof value.dmPolicy;
    allowFrom: typeof value.allowFrom;
    path: Array<string | number>;
  }) => {
    if (params.dmPolicy === "open" && !params.allowFrom?.map(String).includes("*")) {
      ctx.addIssue({
        code: "custom",
        path: params.path,
        message: 'dmPolicy="open" requires allowFrom to include "*".',
      });
    }
  };

  requireOpenWildcard({
    dmPolicy: value.dmPolicy,
    allowFrom: value.allowFrom,
    path: ["allowFrom"],
  });
  for (const [accountId, account] of Object.entries(value.accounts ?? {})) {
    if (!account) {
      continue;
    }
    requireOpenWildcard({
      dmPolicy: account.dmPolicy ?? value.dmPolicy,
      allowFrom: account.allowFrom ?? value.allowFrom,
      path: ["accounts", accountId, "allowFrom"],
    });
  }
});

export const AgentMailChannelConfigSchema: ReturnType<typeof buildChannelConfigSchema> =
  buildChannelConfigSchema(AgentMailConfigSchema, {
  uiHints: {
    "": {
      label: "AgentMail",
      help: "Durable AgentMail channel with verified webhook or WebSocket ingress and reply-only delivery.",
    },
    apiKey: { label: "AgentMail API Key", sensitive: true },
    inboxId: { label: "AgentMail Inbox ID" },
    webhookSecret: {
      label: "AgentMail Webhook Secret",
      help: "When present, enables webhook ingress. Omit it to use WebSocket ingress.",
      sensitive: true,
    },
    webhookPath: { label: "AgentMail Webhook Path" },
    dmPolicy: {
      label: "AgentMail DM Policy",
      help: 'Defaults to "allowlist". Empty allowFrom denies every sender.',
    },
    allowFrom: {
      label: "AgentMail Allow From",
      help: 'Exact normalized mailbox addresses, or "*" only with dmPolicy="open".',
    },
    mediaMaxMb: { label: "AgentMail Media Limit (MiB)" },
  },
});
