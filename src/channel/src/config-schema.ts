import {
  AllowFromListSchema,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
// OpenClaw dropped the `openclaw/plugin-sdk/zod` re-export in 2026.8.1-beta.2 and now depends on
// the `zod` package directly, so plugins import it the same way. Schemas built here still have to
// come from the SAME zod copy the SDK helpers (buildChannelConfigSchema, buildSecretInputSchema)
// use, or structural type mismatches and per-copy registries break sensitive-path registration —
// that is why package.json pins zod to the exact version OpenClaw depends on, so npm hoists one copy.
import { z } from "zod";

// Per-message media buffer limits (MiB), co-located: the default applied when unset, and the
// documented upper bound the schema enforces.
export const AGENTMAIL_MEDIA_DEFAULT_MB = 20;
export const AGENTMAIL_MEDIA_MAX_MB = 100;
// One byte expressed in MiB. Preserve useful fractional limits (for example 0.5 MiB) while
// rejecting positive values that floor to a misleading one-byte runtime limit.
export const AGENTMAIL_MEDIA_MIN_MB = 1 / (1024 * 1024);

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
    mediaMaxMb: z
      .number()
      .min(AGENTMAIL_MEDIA_MIN_MB)
      .max(AGENTMAIL_MEDIA_MAX_MB)
      .optional(),
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
