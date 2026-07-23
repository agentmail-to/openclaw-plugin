import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import release from "./agentmail-cli-release.json" with { type: "json" };

export type AgentMailCliTarget = {
  directory: string;
  executableName: "agentmail" | "agentmail.exe";
};

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
  return fileURLToPath(
    new URL(
      `../../${release.vendorDirectory}/${target.directory}/${target.executableName}`,
      import.meta.url,
    ),
  );
}

export function withConfiguredBaseUrl(
  args: readonly string[],
  baseUrl: string | undefined,
): string[] {
  if (
    args.some(
      (arg) =>
        arg === "--base-url" ||
        arg.startsWith("--base-url=") ||
        arg === "--environment" ||
        arg.startsWith("--environment="),
    )
  ) {
    throw new Error(
      "AgentMail API endpoint overrides are restricted to the operator-controlled plugin config.",
    );
  }
  return baseUrl ? ["--base-url", baseUrl, ...args] : [...args];
}

export function sanitizeAgentMailCliEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...source };
  for (const key of Object.keys(sanitized)) {
    if (
      key.toLocaleUpperCase("en-US") === "AGENTMAIL_BASE_URL" ||
      key.toLocaleUpperCase("en-US") === "AGENTMAIL_ENVIRONMENT"
    ) {
      delete sanitized[key];
    }
  }
  return sanitized;
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
      env: sanitizeAgentMailCliEnvironment(options.env ?? process.env),
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
