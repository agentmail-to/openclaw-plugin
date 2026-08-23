import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import release from "./agentmail-cli-release.json" with { type: "json" };

export type AgentMailCliTarget = {
  directory: string;
  executableName: "agentmail" | "agentmail.exe";
};

export const AGENTMAIL_CLI_ENDPOINT_OPTIONS = ["base-url", "environment"] as const;
export const AGENTMAIL_CLI_RESTRICTED_OPTIONS = [
  "api-key",
  ...AGENTMAIL_CLI_ENDPOINT_OPTIONS,
] as const;

const restrictedOptions = new Set<string>(AGENTMAIL_CLI_RESTRICTED_OPTIONS);
const restrictedEnvironmentKeys = new Set([
  "AGENTMAIL_API_KEY",
  "AGENTMAIL_BASE_URL",
  "AGENTMAIL_CUSTOM_HEADERS",
  "AGENTMAIL_ENVIRONMENT",
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]);

function parseOptionToken(token: string): { name: string } | null {
  const option = /^-+(.+)$/.exec(token)?.[1];
  if (!option) {
    return null;
  }
  const equalsAt = option.indexOf("=");
  return {
    name: (equalsAt < 0 ? option : option.slice(0, equalsAt)).toLowerCase(),
  };
}

export function resolveAgentMailCliVendorPath(...segments: string[]): string {
  return fileURLToPath(
    new URL(`../../${release.vendorDirectory}/${segments.join("/")}`, import.meta.url),
  );
}

export function resolveAgentMailCliTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): AgentMailCliTarget {
  const directory = `${platform}-${arch}`;
  const asset = release.assets[directory as keyof typeof release.assets];
  if (!asset) {
    throw new Error(`The bundled AgentMail CLI does not support ${platform}/${arch}.`);
  }
  if (asset.executableName !== "agentmail" && asset.executableName !== "agentmail.exe") {
    throw new Error(`The bundled AgentMail CLI metadata is invalid for ${platform}/${arch}.`);
  }

  return {
    directory,
    executableName: asset.executableName,
  };
}

export function resolveAgentMailCliExecutable(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  const target = resolveAgentMailCliTarget(platform, arch);
  return resolveAgentMailCliVendorPath(target.directory, target.executableName);
}

export function withConfiguredBaseUrl(
  args: readonly string[],
  baseUrl: string | undefined,
): string[] {
  for (const arg of args) {
    const option = parseOptionToken(arg);
    if (option && restrictedOptions.has(option.name)) {
      throw new Error(
        "AgentMail API credential and endpoint overrides are restricted to operator-controlled configuration.",
      );
    }
  }
  return baseUrl ? ["--base-url", baseUrl, ...args] : [...args];
}

export function sanitizeAgentMailCliEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...source };
  for (const key of Object.keys(sanitized)) {
    if (restrictedEnvironmentKeys.has(key.toUpperCase())) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

export function buildAgentMailCliEnvironment(
  source: NodeJS.ProcessEnv,
  apiKey?: string,
): NodeJS.ProcessEnv {
  const env = sanitizeAgentMailCliEnvironment(source);
  if (apiKey) {
    env.AGENTMAIL_API_KEY = apiKey;
  }
  return env;
}

export function agentMailCliSignalExitCode(signal: NodeJS.Signals): number {
  const signalNumber = osConstants.signals[signal];
  return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}

export async function runAgentMailCli(
  args: readonly string[],
  options: {
    executable?: string;
    env?: NodeJS.ProcessEnv;
    apiKey?: string;
  } = {},
): Promise<number> {
  const executable = options.executable ?? resolveAgentMailCliExecutable();

  try {
    accessSync(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  } catch {
    throw new Error(
      `The bundled AgentMail CLI executable is missing or not executable at ${executable}. ` +
        "Reinstall the AgentMail plugin from its published package.",
    );
  }

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env: buildAgentMailCliEnvironment(options.env ?? process.env, options.apiKey),
      stdio: "inherit",
      windowsHide: false,
    });

    child.once("error", (error) => {
      reject(
        new Error(`Failed to start the bundled AgentMail CLI: ${error.message}`, {
          cause: error,
        }),
      );
    });
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve(agentMailCliSignalExitCode(signal));
        return;
      }
      resolve(code ?? 1);
    });
  });
}
