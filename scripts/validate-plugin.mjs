// Real OpenClaw host validation: link-install the built plugin and confirm the host actually loads
// its AgentMail channel and CLI command, then execute the packaged CLI. This catches invalid
// manifest/schema/command shapes and missing executables that a pure staleness check cannot.
// Kept separate from `plugin:check` (manifest staleness).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const openclaw = fileURLToPath(new URL("../node_modules/.bin/openclaw", import.meta.url));
const cliRunner = await import(new URL("../dist/cli/runner.js", import.meta.url));

// Run against an isolated, disposable state dir so validation (invoked from prepack during
// `npm pack`/`npm publish`) never touches the maintainer's real OpenClaw installation or its
// persistent plugin state.
const stateDir = mkdtempSync(join(tmpdir(), "agentmail-plugin-validate-"));
const childEnv = {
  ...process.env,
  AGENTMAIL_API_KEY: process.env.AGENTMAIL_API_KEY || "am_plugin_validation",
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_DIR: stateDir,
  OPENCLAW_HOME: stateDir,
  PATH: `${dirname(openclaw)}${delimiter}${process.env.PATH || ""}`,
};

function run(args) {
  return execFileSync(openclaw, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });
}

process.on("exit", () => {
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function fail(message, detail) {
  console.error(`\nplugin:validate FAILED — ${message}`);
  if (detail) {
    console.error(detail);
  }
  process.exit(1);
}

try {
  run(["plugins", "install", "--link", ".", "--force"]);
} catch (error) {
  fail("openclaw could not install the linked plugin", error.stdout || error.stderr || String(error));
}

let inspect = "";
try {
  inspect = run(["plugins", "inspect", "agentmail", "--runtime"]);
} catch (error) {
  fail("openclaw could not inspect the installed plugin", error.stdout || error.stderr || String(error));
}

if (!/Status:\s*loaded/.test(inspect)) {
  fail("plugin did not load in the host runtime", inspect);
}
if (!/channel:\s*agentmail/.test(inspect)) {
  fail("plugin manifest did not register the agentmail channel", inspect);
}
if (!/CLI commands:\s*[\s\S]*\bagentmail\b/.test(inspect)) {
  fail("plugin runtime did not register the agentmail CLI command", inspect);
}
if (/agentmail_list_inboxes/.test(inspect)) {
  fail("plugin still registered the retired fixed AgentMail tool surface", inspect);
}

const expectedCliVersion = readFileSync(
  cliRunner.resolveAgentMailCliVendorPath("VERSION"),
  "utf8",
).trim();
let cliHelp = "";
try {
  cliHelp = execFileSync(cliRunner.resolveAgentMailCliExecutable(), ["--help"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: cliRunner.sanitizeAgentMailCliEnvironment(childEnv),
  });
} catch (error) {
  fail(
    "could not inspect the bundled AgentMail CLI global options",
    error.stdout || error.stderr || String(error),
  );
}
const endpointOptions = cliHelp
  .split("\n")
  .filter((line) => /(base URL|environment for API requests)/i.test(line))
  .flatMap((line) =>
    [...line.matchAll(/(?:^|[\s,])-+([a-z][a-z0-9-]*)\b/gi)].map((match) =>
      match[1].toLowerCase(),
    ),
  )
  .sort();
const guardedEndpointOptions = [...cliRunner.AGENTMAIL_CLI_ENDPOINT_OPTIONS].sort();
if (JSON.stringify(endpointOptions) !== JSON.stringify(guardedEndpointOptions)) {
  fail(
    "bundled AgentMail CLI endpoint options no longer match the passthrough guard",
    `CLI: ${endpointOptions.join(", ") || "(none)"}; guard: ${guardedEndpointOptions.join(", ")}`,
  );
}
for (const option of endpointOptions) {
  for (const prefix of ["-", "--", "---"]) {
    for (const args of [
      [`${prefix}${option}`, "untrusted", "inboxes", "list"],
      [`${prefix}${option}=untrusted`, "inboxes", "list"],
    ]) {
      try {
        cliRunner.withConfiguredBaseUrl(args, undefined);
        fail(`endpoint guard accepted ${args[0]}`);
      } catch (error) {
        if (!String(error).includes("endpoint overrides are restricted")) {
          throw error;
        }
      }
    }
  }
}
let cliVersion = "";
try {
  cliVersion = run(["agentmail", "--", "--version"]);
} catch (error) {
  fail(
    "openclaw could not execute the bundled AgentMail CLI",
    error.stdout || error.stderr || String(error),
  );
}
if (!cliVersion.includes(expectedCliVersion)) {
  fail(
    `bundled AgentMail CLI version did not match ${expectedCliVersion}`,
    cliVersion,
  );
}

let skills = "";
try {
  skills = run(["skills", "list", "--eligible"]);
} catch (error) {
  fail(
    "openclaw could not list eligible skills",
    error.stdout || error.stderr || String(error),
  );
}
if (!/\bagentmail\b/i.test(skills)) {
  fail("plugin did not expose its AgentMail CLI skill", skills);
}

// Surface any load diagnostics the host reports for this plugin.
try {
  const doctor = run(["plugins", "doctor"]);
  const agentmailIssue = doctor
    .split("\n")
    .find((line) => /agentmail/i.test(line) && /(error|fail|invalid)/i.test(line));
  if (agentmailIssue) {
    fail("openclaw doctor reported an issue", agentmailIssue);
  }
} catch {
  // doctor is best-effort; the inspect assertions above are the authoritative gate.
}

console.log(
  `plugin:validate OK — host loaded the AgentMail channel and AgentMail CLI ${expectedCliVersion}.`,
);
