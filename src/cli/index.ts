import {
  definePluginEntry,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  agentMailCliConfigSchema,
  parseAgentMailCliConfig,
} from "./config.js";
import {
  runAgentMailCli,
  withConfiguredBaseUrl,
} from "./runner.js";

type RunAgentMailCli = typeof runAgentMailCli;

export function createAgentMailCliPlugin(
  runCli: RunAgentMailCli = runAgentMailCli,
): OpenClawPluginDefinition {
  return definePluginEntry({
    id: "agentmail",
    name: "AgentMail",
    description: "Run the bundled AgentMail CLI through OpenClaw.",
    configSchema: agentMailCliConfigSchema,
    register(api) {
      const config = parseAgentMailCliConfig(api.pluginConfig);

      api.registerCli(
        ({ program }) => {
          program
            .command("agentmail [arguments...]")
            .description("Run the bundled AgentMail CLI (use -- before AgentMail arguments)")
            .helpOption(false)
            .allowUnknownOption(true)
            .allowExcessArguments(true)
            .action(async (args: string[]) => {
              const exitCode = await runCli(withConfiguredBaseUrl(args, config.baseUrl));
              if (exitCode !== 0) {
                process.exitCode = exitCode;
              }
            });
        },
        {
          commands: ["agentmail"],
          descriptors: [
            {
              name: "agentmail",
              description: "Run the bundled AgentMail CLI",
              hasSubcommands: false,
            },
          ],
        },
      );
    },
  });
}

const agentMailCliPlugin: OpenClawPluginDefinition = createAgentMailCliPlugin();

export default agentMailCliPlugin;
