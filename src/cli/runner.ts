import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";

type SupportedPlatform = "darwin" | "linux" | "win32";
type SupportedArch = "arm64" | "ia32" | "x64";

export type AgentMailCliTarget = {
  directory: string;
  executableName: "agentmail" | "agentmail.exe";
};

export function resolveAgentMailCliTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): AgentMailCliTarget {
  if (!["darwin", "linux", "win32"].includes(platform)) {
    throw new Error(`The bundled AgentMail CLI does not support platform ${platform}.`);
  }
  if (!["arm64", "ia32", "x64"].includes(arch)) {
    throw new Error(`The bundled AgentMail CLI does not support architecture ${arch}.`);
  }
  if (platform === "darwin" && arch === "ia32") {
    throw new Error("The bundled AgentMail CLI does not support darwin/ia32.");
  }

  return {
    directory: `${platform as SupportedPlatform}-${arch as SupportedArch}`,
    executableName: platform === "win32" ? "agentmail.exe" : "agentmail",
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
  if (
    !baseUrl ||
    args.includes("--base-url") ||
    args.some((arg) => arg.startsWith("--base-url="))
  ) {
    return [...args];
  }
  return ["--base-url", baseUrl, ...args];
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
