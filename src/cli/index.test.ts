import { describe, expect, it, vi } from "vitest";
import { createAgentMailCliPlugin } from "./index.js";
import {
  agentMailCliSignalExitCode,
  buildAgentMailCliEnvironment,
  resolveAgentMailCliTarget,
  sanitizeAgentMailCliEnvironment,
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

  it("allows only operator-configured credentials and API base URL", () => {
    expect(withConfiguredBaseUrl(["inboxes", "list"], "https://example.test/v0")).toEqual([
      "--base-url",
      "https://example.test/v0",
      "inboxes",
      "list",
    ]);
    expect(withConfiguredBaseUrl(["inboxes", "list"], undefined)).toEqual([
      "inboxes",
      "list",
    ]);
    expect(() =>
      withConfiguredBaseUrl(
        ["--base-url=https://override.test/v0", "inboxes", "list"],
        "https://example.test/v0",
      ),
    ).toThrow("endpoint overrides are restricted");
    expect(() =>
      withConfiguredBaseUrl(
        ["inboxes", "list", "--base-url", "https://override.test/v0"],
        undefined,
      ),
    ).toThrow("endpoint overrides are restricted");
    expect(() =>
      withConfiguredBaseUrl(
        ["--environment", "development", "inboxes", "list"],
        undefined,
      ),
    ).toThrow("endpoint overrides are restricted");
    expect(() =>
      withConfiguredBaseUrl(
        ["--environment=development", "inboxes", "list"],
        "https://example.test/v0",
      ),
    ).toThrow("endpoint overrides are restricted");
    expect(() =>
      withConfiguredBaseUrl(
        ["-base-url", "https://override.test/v0", "inboxes", "list"],
        undefined,
      ),
    ).toThrow("endpoint overrides are restricted");
    expect(() =>
      withConfiguredBaseUrl(
        ["-environment=development", "inboxes", "list"],
        undefined,
      ),
    ).toThrow("endpoint overrides are restricted");
    expect(() =>
      withConfiguredBaseUrl(
        ["---base-url=https://override.test/v0", "inboxes", "list"],
        undefined,
      ),
    ).toThrow("endpoint overrides are restricted");
    expect(() =>
      withConfiguredBaseUrl(
        ["--api-key", "attacker-controlled", "inboxes", "list"],
        undefined,
      ),
    ).toThrow("credential and endpoint overrides are restricted");
    expect(() =>
      withConfiguredBaseUrl(
        ["-api-key=attacker-controlled", "inboxes", "list"],
        undefined,
      ),
    ).toThrow("credential and endpoint overrides are restricted");
    expect(() =>
      withConfiguredBaseUrl(
        ["--transform", "--base-url=literal-output", "inboxes", "list"],
        undefined,
      ),
    ).toThrow("endpoint overrides are restricted");
    expect(() =>
      withConfiguredBaseUrl(
        ["inboxes:messages", "send", "--subject", "--base-url=is restricted"],
        undefined,
      ),
    ).toThrow("endpoint overrides are restricted");
    expect(
      withConfiguredBaseUrl(
        ["inboxes:messages", "send", "--subject=--base-url-is-safe"],
        undefined,
      ),
    ).toEqual(["inboxes:messages", "send", "--subject=--base-url-is-safe"]);
  });

  it("removes inherited credentials, custom headers, and endpoint selectors", () => {
    expect(
      sanitizeAgentMailCliEnvironment({
        AGENTMAIL_API_KEY: "am_test",
        agentmail_custom_headers: '{"X-Secret":"leak"}',
        AGENTMAIL_BASE_URL: "https://attacker.example",
        agentmail_environment: "development",
        HTTPS_PROXY: "https://attacker.example",
        no_proxy: "api.agentmail.to",
        OTHER_VALUE: "kept",
      }),
    ).toEqual({
      OTHER_VALUE: "kept",
    });
    expect(
      buildAgentMailCliEnvironment(
        {
          AGENTMAIL_API_KEY: "am_attacker",
          AGENTMAIL_CUSTOM_HEADERS: '{"X-Secret":"leak"}',
        },
        "am_operator",
      ),
    ).toEqual({ AGENTMAIL_API_KEY: "am_operator" });
    expect(
      buildAgentMailCliEnvironment({
        AGENTMAIL_API_KEY: "am_attacker",
        AGENTMAIL_CUSTOM_HEADERS: '{"X-Secret":"leak"}',
      }),
    ).toEqual({});
  });

  it("maps terminating signals to conventional shell exit codes", () => {
    expect(agentMailCliSignalExitCode("SIGINT")).toBe(130);
    expect(agentMailCliSignalExitCode("SIGTERM")).toBe(143);
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
      config: {},
      pluginConfig: { apiKey: "am_operator", baseUrl: "https://example.test/v0" },
      registerCli(callback, options) {
        registrar = callback;
        registrationOptions = options;
      },
    });

    expect(registrationOptions).toEqual({
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
    expect(runCli).toHaveBeenCalledWith(
      [
        "--base-url",
        "https://example.test/v0",
        "inboxes",
        "list",
        "--format",
        "json",
      ],
      { apiKey: "am_operator" },
    );

    const priorExitCode = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    runCli.mockRejectedValueOnce(new Error("bundled CLI could not start"));
    await action?.(["inboxes", "list"]);
    expect(error).toHaveBeenCalledWith("bundled CLI could not start");
    expect(process.exitCode).toBe(1);
    process.exitCode = priorExitCode;
    error.mockRestore();
  });

  it("reports the required plugin config instead of running without a credential", async () => {
    const runCli = vi.fn().mockResolvedValue(0);
    const plugin = createAgentMailCliPlugin(runCli);
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
    (plugin.register as never)({
      config: {},
      pluginConfig: {},
      registerCli(callback: (context: { program: { command: () => typeof command } }) => void) {
        callback({ program: { command: () => command } });
      },
    });
    const priorExitCode = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await action?.(["inboxes", "list"]);

    expect(runCli).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "AgentMail CLI requires plugins.entries.agentmail.config.apiKey.",
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = priorExitCode;
    error.mockRestore();
  });
});
