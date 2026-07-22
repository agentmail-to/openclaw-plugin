// Real OpenClaw host validation: link-install the built plugin and confirm the host actually loads
// it with both capabilities (the AgentMail channel and all declared tools). This catches invalid
// manifest/contract/schema shapes that a pure staleness check cannot — they would otherwise only
// surface at user startup. Kept separate from `plugin:check` (manifest staleness).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const openclaw = fileURLToPath(new URL("../node_modules/.bin/openclaw", import.meta.url));

// Run against an isolated, disposable state dir so validation (invoked from prepack during
// `npm pack`/`npm publish`) never touches the maintainer's real OpenClaw installation or its
// persistent plugin state.
const stateDir = mkdtempSync(join(tmpdir(), "agentmail-plugin-validate-"));
const childEnv = {
  ...process.env,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_DIR: stateDir,
  OPENCLAW_HOME: stateDir,
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
const requiredTools = [
  "agentmail_list_inboxes",
  "agentmail_create_inbox",
  "agentmail_send_message",
  "agentmail_reply_to_message",
];
const missing = requiredTools.filter((tool) => !inspect.includes(tool));
if (missing.length > 0) {
  fail(`plugin did not register expected tools: ${missing.join(", ")}`, inspect);
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

console.log("plugin:validate OK — host loaded the AgentMail channel and tools.");
