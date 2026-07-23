// Generates openclaw.plugin.json for the combined AgentMail plugin (tool extension + channel
// extension). The stock `openclaw plugins build` codegen only understands tool-plugin metadata, so
// it cannot own a manifest that also declares a channel. This script derives the tool half from the
// compiled tool entry's metadata and merges the channel declarations (channels and channelConfigs)
// so both surfaces load from one manifest.
//
// Usage:
//   node scripts/build-manifest.mjs            # write openclaw.plugin.json
//   node scripts/build-manifest.mjs --check    # fail if the on-disk manifest is out of date
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import toolEntry from "../dist/tools/index.js";
import { AgentMailChannelConfigSchema } from "../dist/channel/src/config-schema.js";

const MANIFEST_PATH = fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url));

const DESCRIPTION =
  "AgentMail for OpenClaw: email tools plus a durable, allowlisted, reply-only email channel.";

const toolMetadata = getToolPluginMetadata(toolEntry);
if (!toolMetadata) {
  throw new Error("Tool plugin metadata is unavailable from ./dist/tools/index.js");
}

const manifest = {
  id: toolMetadata.id,
  name: toolMetadata.name,
  description: DESCRIPTION,
  version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
  configSchema: toolMetadata.configSchema,
  activation: toolMetadata.activation ?? { onStartup: true },
  channels: ["agentmail"],
  // Deliberately omit channelEnvVars. AGENTMAIL_API_KEY also configures the tools, while the
  // channel requires an inboxId; the host treats any declared non-empty env var as channel
  // presence and would otherwise surface an unconfigured phantom channel.
  channelConfigs: {
    agentmail: {
      schema: AgentMailChannelConfigSchema.schema,
      label: "AgentMail",
      description: DESCRIPTION,
      uiHints: AgentMailChannelConfigSchema.uiHints,
    },
  },
  contracts: {
    tools: toolMetadata.tools.map((tool) => tool.name),
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
