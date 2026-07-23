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
