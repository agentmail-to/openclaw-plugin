import {
  definePluginEntry,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { setAgentMailRuntime } from "./channel/api.js";
import { agentMailPlugin } from "./channel/channel-plugin-api.js";
import cliEntry from "./cli/index.js";

// One runtime entry must own both surfaces. Multiple `openclaw.extensions` entries form a plugin
// pack and receive distinct runtime identities; the host can then select the CLI-only runtime at
// gateway startup and never start the channel worker.
const entry: OpenClawPluginDefinition = definePluginEntry({
  id: "agentmail",
  name: "AgentMail",
  description:
    "AgentMail for OpenClaw: a CLI-backed skill plus a durable, allowlisted, reply-only email channel.",
  configSchema: cliEntry.configSchema,
  register(api) {
    if (api.registrationMode === "tool-discovery") {
      return;
    }
    if (api.registrationMode !== "cli-metadata") {
      api.registerChannel({ plugin: agentMailPlugin as never });
      setAgentMailRuntime(api.runtime);
    }
    if (
      api.registrationMode === "full" ||
      api.registrationMode === "discovery" ||
      api.registrationMode === "cli-metadata"
    ) {
      cliEntry.register?.(api);
    }
  },
});

export default entry;
