import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import {
  DEFAULT_ACCOUNT_ID,
  listCombinedAccountIds,
  resolveAccountEntry,
  resolveListedDefaultAccountId,
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { AGENTMAIL_MEDIA_DEFAULT_MB } from "./config-schema.js";
import { normalizeMailbox } from "./mailbox.js";
import {
  type AgentMailChannelConfig,
  type ResolvedAgentMailAccount,
  resolveAgentMailIngressMode,
} from "./types.js";

const CHANNEL_ID = "agentmail";
const DEFAULT_WEBHOOK_PATH = "/webhooks/agentmail";

function getChannelConfig(cfg: OpenClawConfig): AgentMailChannelConfig | undefined {
  return cfg.channels?.[CHANNEL_ID] as AgentMailChannelConfig | undefined;
}

function hasBaseAccount(channel: AgentMailChannelConfig | undefined): boolean {
  return Boolean(
    channel?.inboxId || hasConfiguredSecretInput(channel?.apiKey) || process.env.AGENTMAIL_API_KEY,
  );
}

export function listAgentMailAccountIds(cfg: OpenClawConfig): string[] {
  const channel = getChannelConfig(cfg);
  return listCombinedAccountIds({
    // Normalize to canonical ids so the listed set matches what resolveAgentMailAccount produces;
    // otherwise a non-canonical key (e.g. "sales/us") would be listed raw but resolved as "sales-us"
    // and appear unconfigured. collectAgentMailAccountIdWarnings surfaces such keys to the operator.
    configuredAccountIds: Object.keys(channel?.accounts ?? {}).map(
      (key) => normalizeOptionalAccountId(key) ?? key,
    ),
    implicitAccountId: hasBaseAccount(channel) ? DEFAULT_ACCOUNT_ID : undefined,
  });
}

/**
 * Warnings for account keys the SDK cannot resolve back to their config. The account map is looked
 * up case-insensitively but NOT slug-normalized, so a non-canonical key silently resolves as an
 * unconfigured account. Also flags two keys that collapse to the same canonical id.
 */
export function collectAgentMailAccountIdWarnings(cfg: OpenClawConfig): string[] {
  const channel = getChannelConfig(cfg);
  const warnings: string[] = [];
  const canonicalToRaw = new Map<string, string>();
  for (const rawKey of Object.keys(channel?.accounts ?? {})) {
    const canonical = normalizeOptionalAccountId(rawKey) ?? DEFAULT_ACCOUNT_ID;
    if (canonical !== rawKey) {
      warnings.push(
        `- AgentMail: account id ${JSON.stringify(rawKey)} is not canonical; rename it to ${JSON.stringify(canonical)} or it resolves as unconfigured.`,
      );
    }
    const existing = canonicalToRaw.get(canonical);
    if (existing) {
      warnings.push(
        `- AgentMail: account ids ${JSON.stringify(existing)} and ${JSON.stringify(rawKey)} both normalize to ${JSON.stringify(canonical)}; use distinct canonical ids.`,
      );
    } else {
      canonicalToRaw.set(canonical, rawKey);
    }
  }
  return warnings;
}

export function resolveDefaultAgentMailAccountId(cfg: OpenClawConfig): string {
  const channel = getChannelConfig(cfg);
  return resolveListedDefaultAccountId({
    accountIds: listAgentMailAccountIds(cfg),
    configuredDefaultAccountId: normalizeOptionalAccountId(channel?.defaultAccount),
  });
}

function resolveSecret(params: { value: unknown; path: string; fallback?: string }): string {
  // `??` only catches null/undefined, so a configured empty/whitespace string (e.g. apiKey: "")
  // would suppress the env fallback and make the account look unconfigured. Treat it as absent.
  const hasValue =
    params.value !== undefined &&
    params.value !== null &&
    !(typeof params.value === "string" && params.value.trim() === "");
  return (
    normalizeResolvedSecretInputString({
      value: hasValue ? params.value : params.fallback,
      path: params.path,
    }) ?? ""
  );
}

export function resolveAgentMailAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedAgentMailAccount {
  const channel = getChannelConfig(cfg) ?? {};
  const id = normalizeOptionalAccountId(accountId) ?? resolveDefaultAgentMailAccountId(cfg);
  const account = resolveAccountEntry(channel.accounts, id);
  const defaultAccount = id === DEFAULT_ACCOUNT_ID;
  const merged = resolveMergedAccountConfig<Record<string, unknown> & AgentMailChannelConfig>({
    channelConfig: { ...channel },
    accounts: channel.accounts,
    accountId: id,
    // A top-level path belongs to the implicit default account. Named accounts get their own
    // account-derived default unless they explicitly override webhookPath. They must also NOT
    // inherit the top-level inboxId: two accounts resolving to the same mailbox would start
    // separate consumers over separate durable journals, bypassing dedupe and double-replying.
    omitKeys: defaultAccount
      ? ["defaultAccount"]
      : ["defaultAccount", "webhookPath", "inboxId"],
  });
  const fieldPath = (field: "apiKey" | "webhookSecret") =>
    defaultAccount ? `channels.agentmail.${field}` : `channels.agentmail.accounts.${id}.${field}`;
  const allowFrom = normalizeStringEntries(
    (Array.isArray(merged.allowFrom)
      ? merged.allowFrom
      : typeof merged.allowFrom === "string"
        ? merged.allowFrom.split(",")
        : []
    ).map((entry) => normalizeMailbox(String(entry))),
  );
  const mediaMaxMb =
    typeof merged.mediaMaxMb === "number" && Number.isFinite(merged.mediaMaxMb)
      ? merged.mediaMaxMb
      : AGENTMAIL_MEDIA_DEFAULT_MB;
  const configuredPath = merged.webhookPath?.trim();
  const apiVal = resolveSecret({
    value: merged.apiKey,
    fallback: defaultAccount ? process.env.AGENTMAIL_API_KEY : undefined,
    path: fieldPath("apiKey"),
  });
  const hookVal = resolveSecret({
    value: merged.webhookSecret,
    fallback: defaultAccount ? process.env.AGENTMAIL_WEBHOOK_SECRET : undefined,
    path: fieldPath("webhookSecret"),
  });
  return {
    accountId: id,
    enabled: channel.enabled !== false && account?.enabled !== false,
    apiKey: apiVal,
    inboxId: merged.inboxId?.trim() ?? "",
    webhookSecret: hookVal,
    webhookPath:
      configuredPath ||
      (defaultAccount ? DEFAULT_WEBHOOK_PATH : `${DEFAULT_WEBHOOK_PATH}/${encodeURIComponent(id)}`),
    dmPolicy: merged.dmPolicy ?? "allowlist",
    allowFrom,
    mediaMaxBytes: Math.max(1, Math.floor(mediaMaxMb * 1024 * 1024)),
  };
}

export function isAgentMailAccountConfigured(account: ResolvedAgentMailAccount): boolean {
  return Boolean(account.apiKey && account.inboxId);
}

/**
 * Returns the id of an earlier-sorted account that also targets this account's inbox, or null when
 * the inbox is unique. Two accounts consuming one inbox would open separate durable journals (keyed
 * by accountId) and both process — and reply to — the same message. The earliest account owns the
 * inbox; later duplicates defer so exactly one consumer runs.
 */
export function findConflictingAgentMailInboxOwner(
  cfg: OpenClawConfig,
  account: ResolvedAgentMailAccount,
): string | null {
  if (!account.inboxId) {
    return null;
  }
  for (const otherId of listAgentMailAccountIds(cfg)) {
    const other = resolveAgentMailAccount(cfg, otherId);
    // Compare canonical (resolved) ids with a strict byte order — never localeCompare, whose ties
    // between distinct ids could let both accounts believe they are the owner and double-reply.
    if (other.accountId === account.accountId || other.accountId >= account.accountId) {
      continue;
    }
    // Only an enabled AND fully-configured account can own the inbox; an enabled-but-unconfigured
    // account must not block the real consumer and silently disable inbound mail.
    if (
      other.enabled &&
      isAgentMailAccountConfigured(other) &&
      other.inboxId === account.inboxId
    ) {
      return other.accountId;
    }
  }
  return null;
}

export function inspectAgentMailAccount(cfg: OpenClawConfig, accountId?: string | null) {
  const account = resolveAgentMailAccount(cfg, accountId);
  return {
    enabled: account.enabled,
    configured: isAgentMailAccountConfigured(account),
    inboxId: account.inboxId,
    ingressMode: resolveAgentMailIngressMode(account),
    webhookPath: account.webhookPath,
  };
}
