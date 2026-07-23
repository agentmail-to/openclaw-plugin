import {
  definePluginEntry,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { agentMailPlugin } from "./channel/channel-plugin-api.js";
import { setAgentMailRuntime } from "./channel/api.js";
import toolEntry from "./tools/index.js";

// One runtime entry must own both surfaces. Multiple `openclaw.extensions` entries are a plugin
// pack and receive distinct runtime identities; listing the tool and channel entries separately
// caused the shared manifest id to resolve to the first (tool-only) runtime at gateway startup.
const entry: OpenClawPluginDefinition = definePluginEntry({
  id: "agentmail",
  name: "AgentMail",
  description:
    "AgentMail for OpenClaw: email tools plus a durable, allowlisted, reply-only email channel.",
  configSchema: toolEntry.configSchema,
  register(api) {
    if (api.registrationMode === "cli-metadata") {
      return;
    }
    if (api.registrationMode === "tool-discovery") {
      toolEntry.register(api);
      return;
    }
    api.registerChannel({ plugin: agentMailPlugin as never });
    setAgentMailRuntime(api.runtime);
    if (api.registrationMode === "full" || api.registrationMode === "discovery") {
      toolEntry.register(api);
    }
  },
});

export default entry;
