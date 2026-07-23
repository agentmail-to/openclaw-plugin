import { describe, expect, it, vi } from "vitest";
import entry from "./index.js";

function registrationApi(mode: "full" | "discovery" | "tool-discovery" | "cli-metadata") {
  return {
    registrationMode: mode,
    pluginConfig: {},
    runtime: {},
    registerChannel: vi.fn(),
    registerCli: vi.fn(),
  };
}

describe("combined AgentMail plugin entry", () => {
  it("registers the channel and CLI from one full runtime", () => {
    const api = registrationApi("full");
    entry.register(api as never);
    expect(api.registerChannel).toHaveBeenCalledOnce();
    expect(api.registerCli).toHaveBeenCalledOnce();
  });

  it("keeps channel work out of CLI metadata and tool discovery", () => {
    const cliApi = registrationApi("cli-metadata");
    entry.register(cliApi as never);
    expect(cliApi.registerChannel).not.toHaveBeenCalled();
    expect(cliApi.registerCli).toHaveBeenCalledOnce();

    const toolApi = registrationApi("tool-discovery");
    entry.register(toolApi as never);
    expect(toolApi.registerChannel).not.toHaveBeenCalled();
    expect(toolApi.registerCli).not.toHaveBeenCalled();
  });
});
