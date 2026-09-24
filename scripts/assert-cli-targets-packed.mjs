// Fails a release whose npm-pack tarball would omit any bundled AgentMail CLI target.
//
// 0.2.1 shipped only vendor/agentmail/darwin-arm64/agentmail because the publish bypassed
// prepack (which runs `cli:prepare -- --all`), so the Linux/Windows CLI was missing and the
// CLI-backed skill failed with "Exec format error" off macOS arm64. This guard inspects the exact
// file list `npm pack` would publish and exits non-zero if any target is absent.
//
// Run it AFTER the full vendor tree is built (e.g. `npm run plugin:validate`). It packs with
// --ignore-scripts on purpose so it reports the on-disk tree that will actually ship, instead of
// re-running prepack and rebuilding the tree it is meant to check.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

let packTargets;
try {
  packTargets = await import(new URL("../dist/cli/pack-targets.js", import.meta.url));
} catch (error) {
  console.error(
    "pack:verify FAILED — could not load dist/cli/pack-targets.js. Run `npm run build` first.",
  );
  console.error(String(error));
  process.exit(1);
}
const { findMissingCliTargets, expectedCliVendorPaths } = packTargets;

const release = JSON.parse(
  readFileSync(new URL("../src/cli/agentmail-cli-release.json", import.meta.url), "utf8"),
);

function packedPaths() {
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  // `npm --json` writes JSON to stdout, but be tolerant of any leading banner text.
  const start = stdout.indexOf("[");
  const parsed = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return (entry?.files ?? []).map((file) => file.path);
}

const expected = expectedCliVendorPaths(release);
const missing = findMissingCliTargets(packedPaths(), release);

if (missing.length > 0) {
  console.error(
    `pack:verify FAILED — the package would ship ${expected.length - missing.length}/${expected.length} AgentMail CLI targets.`,
  );
  console.error("Missing bundled CLI executables:");
  for (const path of missing) {
    console.error(`  - ${path}`);
  }
  console.error(
    "\nBuild the complete vendor tree before packing: `npm run plugin:validate` (runs `cli:prepare -- --all`).",
  );
  console.error("Never publish with lifecycle scripts disabled (--ignore-scripts).");
  process.exit(1);
}

console.log(
  `pack:verify OK — all ${expected.length} AgentMail CLI targets are vendored in the package.`,
);
