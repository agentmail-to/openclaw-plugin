import {
  definePluginEntry,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
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
              try {
                if (!config.apiKey) {
                  throw new Error(
                    "AgentMail CLI requires plugins.entries.agentmail.config.apiKey.",
                  );
                }
                const resolved = await resolveConfiguredSecretInputString({
                  config: api.config,
                  env: process.env,
                  value: config.apiKey,
                  path: "plugins.entries.agentmail.config.apiKey",
                });
                if (!resolved.value) {
                  throw new Error(
                    resolved.unresolvedRefReason ??
                      "AgentMail CLI apiKey resolved to an empty value.",
                  );
                }
                const exitCode = await runCli(
                  withConfiguredBaseUrl(args, config.baseUrl),
                  { apiKey: resolved.value },
                );
                if (exitCode !== 0) {
                  process.exitCode = exitCode;
                }
              } catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
              }
            });
        },
        {
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
