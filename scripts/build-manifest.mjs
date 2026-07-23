// Generates openclaw.plugin.json for the combined AgentMail plugin (CLI-backed skill + channel
// extension). The stock `openclaw plugins build` codegen only understands tool-plugin metadata,
// while this plugin intentionally exposes the evolving AgentMail API through its bundled CLI.
// This script owns the manifest so the CLI config, plugin skill, and channel declarations remain
// one installable unit.
//
// Usage:
//   node scripts/build-manifest.mjs            # write openclaw.plugin.json
//   node scripts/build-manifest.mjs --check    # fail if the on-disk manifest is out of date
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentMailCliConfigJsonSchema } from "../dist/cli/config.js";
import { AgentMailChannelConfigSchema } from "../dist/channel/src/config-schema.js";

const MANIFEST_PATH = fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url));

const DESCRIPTION =
  "AgentMail for OpenClaw: a CLI-backed skill plus a durable, allowlisted, reply-only email channel.";

const manifest = {
  id: "agentmail",
  name: "AgentMail",
  description: DESCRIPTION,
  version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
  configSchema: agentMailCliConfigJsonSchema,
  activation: { onStartup: true },
  channels: ["agentmail"],
  skills: ["./skills"],
  // The Plugin Inspector emits a `channel-env-vars` deprecation warning whenever this field is
  // present (it is unconditional — a setup entry does NOT suppress it). We keep it anyway: on our
  // supported OpenClaw range (peerDependency floor >=2026.7.2-beta.3, currently the newest published
  // release) `channelEnvVars` is still the only source OpenClaw reads to detect the channel as
  // configured from AGENTMAIL_API_KEY in the environment (isStaticallyChannelConfigured) and to
  // advertise expected env-shell keys. No setup-metadata replacement path has shipped in any release
  // yet, so dropping this would regress env-driven setup with no upside.
  // Remove this field (which clears the warning) only once our minimum supported OpenClaw version
  // reads channel env names from the newer setup model instead — then also raise the floor to match.
  channelEnvVars: {
    agentmail: ["AGENTMAIL_API_KEY", "AGENTMAIL_WEBHOOK_SECRET"],
  },
  channelConfigs: {
    agentmail: {
      schema: AgentMailChannelConfigSchema.schema,
      label: "AgentMail",
      description: DESCRIPTION,
      uiHints: AgentMailChannelConfigSchema.uiHints,
    },
  },
};

const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = readFileSync(MANIFEST_PATH, "utf8");
  if (current !== serialized) {
    console.error("openclaw.plugin.json is out of date. Run: npm run plugin:build");
    process.exit(1);
  }
  console.log("openclaw.plugin.json is up to date.");
} else {
  writeFileSync(MANIFEST_PATH, serialized);
  console.log(`Wrote ${MANIFEST_PATH}`);
}
