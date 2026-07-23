import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
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
    new URL(`../../vendor/agentmail/${target.directory}/${target.executableName}`, import.meta.url),
  );
}

export function withConfiguredBaseUrl(
  args: readonly string[],
  baseUrl: string | undefined,
): string[] {
  if (args.some((arg) => arg === "--base-url" || arg.startsWith("--base-url="))) {
    throw new Error(
      "AgentMail API endpoint overrides are restricted to the operator-controlled plugin config.",
    );
  }
  return baseUrl ? ["--base-url", baseUrl, ...args] : [...args];
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
      env: options.env ?? process.env,
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
        reject(new Error(`The bundled AgentMail CLI exited after receiving ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}
