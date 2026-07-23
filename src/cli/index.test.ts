import { describe, expect, it, vi } from "vitest";
import { createAgentMailCliPlugin } from "./index.js";
import {
  resolveAgentMailCliTarget,
  withConfiguredBaseUrl,
} from "./runner.js";

describe("AgentMail CLI bridge", () => {
  it("maps supported Node targets to packaged executable directories", () => {
    expect(resolveAgentMailCliTarget("linux", "x64")).toEqual({
      directory: "linux-x64",
      executableName: "agentmail",
    });
    expect(resolveAgentMailCliTarget("darwin", "arm64")).toEqual({
      directory: "darwin-arm64",
      executableName: "agentmail",
    });
    expect(resolveAgentMailCliTarget("win32", "x64")).toEqual({
      directory: "win32-x64",
      executableName: "agentmail.exe",
    });
    expect(() => resolveAgentMailCliTarget("darwin", "ia32")).toThrow(
      "does not support darwin/ia32",
    );
  });

  it("adds the configured base URL unless the caller supplied one", () => {
    expect(withConfiguredBaseUrl(["inboxes", "list"], "https://example.test/v0")).toEqual([
      "--base-url",
      "https://example.test/v0",
      "inboxes",
      "list",
    ]);
    expect(
      withConfiguredBaseUrl(
        ["--base-url=https://override.test/v0", "inboxes", "list"],
        "https://example.test/v0",
      ),
    ).toEqual(["--base-url=https://override.test/v0", "inboxes", "list"]);
  });

  it("registers one passthrough command and invokes the bundled CLI runner", async () => {
    const runCli = vi.fn().mockResolvedValue(0);
    const plugin = createAgentMailCliPlugin(runCli);
    let registrar:
      | ((context: { program: FakeProgram }) => void | Promise<void>)
      | undefined;
    let registrationOptions: unknown;
    let action: ((args: string[]) => Promise<void>) | undefined;

    const command = {
      description: vi.fn().mockReturnThis(),
      helpOption: vi.fn().mockReturnThis(),
      allowUnknownOption: vi.fn().mockReturnThis(),
      allowExcessArguments: vi.fn().mockReturnThis(),
      action: vi.fn((handler: (args: string[]) => Promise<void>) => {
        action = handler;
        return command;
      }),
    };
    type FakeProgram = {
      command: (definition: string) => typeof command;
    };
    const program: FakeProgram = {
      command: vi.fn().mockReturnValue(command),
    };

    (plugin.register as unknown as (api: {
      pluginConfig: Record<string, unknown>;
      registerCli: (
        callback: (context: { program: FakeProgram }) => void | Promise<void>,
        options: unknown,
      ) => void;
    }) => void)({
      pluginConfig: { baseUrl: "https://example.test/v0" },
      registerCli(callback, options) {
        registrar = callback;
        registrationOptions = options;
      },
    });

    expect(registrationOptions).toEqual({
      commands: ["agentmail"],
      descriptors: [
        {
          name: "agentmail",
          description: "Run the bundled AgentMail CLI",
          hasSubcommands: false,
        },
      ],
    });

    await registrar?.({ program });
    expect(program.command).toHaveBeenCalledWith("agentmail [arguments...]");

    await action?.(["inboxes", "list", "--format", "json"]);
    expect(runCli).toHaveBeenCalledWith([
      "--base-url",
      "https://example.test/v0",
      "inboxes",
      "list",
      "--format",
      "json",
    ]);
  });
});
