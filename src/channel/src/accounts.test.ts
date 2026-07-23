import { afterEach, describe, expect, it } from "vitest";
import {
  collectAgentMailAccountIdWarnings,
  findConflictingAgentMailInboxOwner,
  listAgentMailAccountIds,
  resolveAgentMailAccount,
} from "./accounts.js";
import { AgentMailChannelConfigSchema } from "./config-schema.js";
import type { AgentMailChannelConfig } from "./types.js";

const paddedApi = " api-key ";
const apiVal = "api-key";
const paddedHook = " webhook-value ";
const hookVal = "webhook-value";
const sharedVal = "shared";

afterEach(() => {
  delete process.env.AGENTMAIL_API_KEY;
  delete process.env.AGENTMAIL_WEBHOOK_SECRET;
});

describe("AgentMail account config", () => {
  it("defaults to a deny-all allowlist and webhook mode when a secret is present", () => {
    const account = resolveAgentMailAccount({
      channels: {
        agentmail: {
          apiKey: paddedApi,
          inboxId: " Agent@AgentMail.TO ",
          webhookSecret: paddedHook,
        },
      },
    });

    expect(account).toMatchObject({
      accountId: "default",
      apiKey: apiVal,
      inboxId: "Agent@AgentMail.TO",
      webhookSecret: hookVal,
      webhookPath: "/webhooks/agentmail",
      dmPolicy: "allowlist",
      allowFrom: [],
      mediaMaxBytes: 20 * 1024 * 1024,
    });
  });

  it("uses WebSocket mode by omission and gives named accounts distinct paths", () => {
    const cfg = {
      channels: {
        agentmail: {
          apiKey: sharedVal,
          accounts: {
            support: { inboxId: "inbox_support" },
          },
        },
      },
    };
    expect(listAgentMailAccountIds(cfg)).toEqual(["default", "support"]);
    expect(resolveAgentMailAccount(cfg, "support")).toMatchObject({
      webhookSecret: "",
      webhookPath: "/webhooks/agentmail/support",
    });
  });

  it("does not inherit the default account webhook path into named accounts", () => {
    const cfg = {
      channels: {
        agentmail: {
          apiKey: sharedVal,
          webhookPath: "/webhooks/agentmail",
          accounts: {
            support: { inboxId: "inbox_support" },
            billing: { inboxId: "inbox_billing", webhookPath: "/mail/billing" },
          },
        },
      },
    };
    expect(resolveAgentMailAccount(cfg, "support").webhookPath).toBe("/webhooks/agentmail/support");
    expect(resolveAgentMailAccount(cfg, "billing").webhookPath).toBe("/mail/billing");
  });

  it("falls back to the env secret when the configured apiKey is empty", () => {
    process.env.AGENTMAIL_API_KEY = "am_env_key";
    const account = resolveAgentMailAccount({
      channels: { agentmail: { apiKey: "  ", inboxId: "inbox_1" } },
    });
    // An empty/whitespace configured apiKey must not suppress the env fallback.
    expect(account.apiKey).toBe("am_env_key");
  });

  it("does not let named accounts inherit the top-level inboxId", () => {
    const cfg = {
      channels: {
        agentmail: {
          apiKey: sharedVal,
          inboxId: "inbox_default",
          accounts: {
            support: { apiKey: sharedVal }, // no own inboxId
            billing: { inboxId: "inbox_billing" },
          },
        },
      },
    };
    // A named account without its own inboxId must resolve empty (unconfigured), never the
    // top-level mailbox — otherwise two accounts would consume the same inbox and double-reply.
    expect(resolveAgentMailAccount(cfg, "support").inboxId).toBe("");
    expect(resolveAgentMailAccount(cfg, "billing").inboxId).toBe("inbox_billing");
    // The implicit default account still owns the top-level inboxId.
    expect(resolveAgentMailAccount(cfg, "default").inboxId).toBe("inbox_default");
  });

  it("detects a conflicting inbox owner so only the earliest account consumes it", () => {
    const cfg = {
      channels: {
        agentmail: {
          apiKey: sharedVal,
          accounts: {
            alpha: { inboxId: "shared@agentmail.to" },
            beta: { inboxId: "shared@agentmail.to" },
            gamma: { inboxId: "unique@agentmail.to" },
          },
        },
      },
    };
    // beta shares alpha's inbox; alpha sorts earlier, so beta defers and alpha owns it.
    expect(findConflictingAgentMailInboxOwner(cfg, resolveAgentMailAccount(cfg, "beta"))).toBe(
      "alpha",
    );
    expect(
      findConflictingAgentMailInboxOwner(cfg, resolveAgentMailAccount(cfg, "alpha")),
    ).toBeNull();
    expect(
      findConflictingAgentMailInboxOwner(cfg, resolveAgentMailAccount(cfg, "gamma")),
    ).toBeNull();
  });

  it("does not let an unconfigured account own an inbox", () => {
    const cfg = {
      channels: {
        agentmail: {
          accounts: {
            alpha: { inboxId: "shared@agentmail.to" }, // enabled but no apiKey → unconfigured
            beta: { apiKey: sharedVal, inboxId: "shared@agentmail.to" },
          },
        },
      },
    };
    // alpha sorts earlier but is unconfigured, so it must not block beta.
    expect(findConflictingAgentMailInboxOwner(cfg, resolveAgentMailAccount(cfg, "beta"))).toBeNull();
  });

  it("warns about non-canonical and colliding account ids", () => {
    const warnings = collectAgentMailAccountIdWarnings({
      channels: {
        agentmail: {
          accounts: {
            "sales/us": { inboxId: "a@agentmail.to" },
            "sales-us": { inboxId: "b@agentmail.to" },
          },
        },
      },
    });
    expect(warnings.some((w) => w.includes('"sales/us"') && w.includes("not canonical"))).toBe(true);
    expect(warnings.some((w) => w.includes("normalize to"))).toBe(true);
  });

  it("lists account ids in canonical form", () => {
    const ids = listAgentMailAccountIds({
      channels: { agentmail: { accounts: { "Sales-US": { inboxId: "a@agentmail.to" } } } },
    });
    expect(ids).toContain("sales-us");
    expect(ids).not.toContain("Sales-US");
  });

  it("rejects an impractically large mediaMaxMb", () => {
    const runtime = AgentMailChannelConfigSchema.runtime;
    expect(runtime?.safeParse({ mediaMaxMb: 25 }).success).toBe(true);
    expect(runtime?.safeParse({ mediaMaxMb: 100_000 }).success).toBe(false);
  });

  it("requires an explicit wildcard for open access", () => {
    const runtime = AgentMailChannelConfigSchema.runtime;
    expect(runtime?.safeParse({ dmPolicy: "open", allowFrom: [] }).success).toBe(false);
    expect(runtime?.safeParse({ dmPolicy: "open", allowFrom: ["*"] }).success).toBe(true);
    expect(
      runtime?.safeParse({
        allowFrom: ["*"],
        accounts: { support: { dmPolicy: "open", inboxId: "inbox_support" } },
      }).success,
    ).toBe(true);
    expect(
      runtime?.safeParse({
        accounts: { support: { dmPolicy: "open", inboxId: "inbox_support" } },
      }).success,
    ).toBe(false);
  });

  it("does not materialize account defaults that shadow channel inheritance", () => {
    const result = AgentMailChannelConfigSchema.runtime?.safeParse({
      dmPolicy: "open",
      allowFrom: ["*"],
      mediaMaxMb: 50,
      accounts: { support: { inboxId: "inbox_support" } },
    });
    expect(result?.success).toBe(true);
    if (!result?.success) {
      throw new Error("expected AgentMail config to parse");
    }
    const parsed = result.data as AgentMailChannelConfig;
    expect(parsed?.accounts?.support).not.toHaveProperty("dmPolicy");
    expect(parsed?.accounts?.support).not.toHaveProperty("mediaMaxMb");
    expect(
      resolveAgentMailAccount({ channels: { agentmail: parsed } } as never, "support"),
    ).toMatchObject({ dmPolicy: "open", mediaMaxBytes: 50 * 1024 * 1024 });
  });
});
