// Fails if a package would omit any bundled AgentMail CLI target or be too large to publish to
// ClawHub.
//
// Usage:
//   npm run pack:verify                         checks the file list `npm pack` would publish now
//   npm run pack:verify -- path/to/package.tgz  checks an already-built tarball, such as the exact
//                                               file about to be uploaded to ClawHub or npm
//
// 0.2.1 shipped only vendor/agentmail/darwin-arm64/agentmail because the release skipped prepack,
// so plugin:validate never ran. Checking the tarball you are about to upload catches that no matter
// how it was built. Without an argument it packs with --ignore-scripts so it reports the tree on
// disk instead of rebuilding it; run it after `npm run plugin:validate`.
//
// ClawHub's publish endpoint fails on packages much over 20 MiB unpacked, well below its advertised
// 50 MiB (see CLAWHUB_PUBLISHABLE_UNPACKED_BYTES). With one ~12 MiB executable per CLI target, the
// size check is what stops a new target or a larger CLI release from producing an unpublishable
// package.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

let packTargets;
try {
  packTargets = await import(new URL("../dist/cli/pack-targets.js", import.meta.url));
} catch (error) {
  console.error(
    "pack:verify FAILED: could not load dist/cli/pack-targets.js. Run `npm run build` first.",
  );
  console.error(String(error));
  process.exit(1);
}
const {
  CLAWHUB_PUBLISHABLE_UNPACKED_BYTES,
  expectedCliVendorPaths,
  findMissingCliTargets,
  listTarballEntries,
  parseNpmPackEntries,
  unpackedBytes,
} = packTargets;

const release = JSON.parse(
  readFileSync(new URL("../src/cli/agentmail-cli-release.json", import.meta.url), "utf8"),
);

const tarball = process.argv[2];

function packedEntries() {
  if (tarball) {
    return listTarballEntries(readFileSync(tarball));
  }
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    // npm is npm.cmd on Windows, which only launches through a shell. The arguments are fixed.
    shell: process.platform === "win32",
  });
  return parseNpmPackEntries(stdout);
}

const source = tarball ? tarball : "the npm pack file list";
const entries = packedEntries();
const expected = expectedCliVendorPaths(release);
const missing = findMissingCliTargets(
  entries.map((entry) => entry.path),
  release,
);
const size = unpackedBytes(entries);
const mebibytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

if (missing.length > 0) {
  console.error(
    `pack:verify FAILED: ${source} has ${expected.length - missing.length}/${expected.length} AgentMail CLI targets.`,
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

if (size > CLAWHUB_PUBLISHABLE_UNPACKED_BYTES) {
  console.error(
    `pack:verify FAILED: ${source} is ${mebibytes(size)} unpacked; ClawHub cannot publish packages over ${mebibytes(CLAWHUB_PUBLISHABLE_UNPACKED_BYTES)}.`,
  );
  console.error(
    "Bundle fewer CLI targets in src/cli/agentmail-cli-release.json or reduce the executable size.",
  );
  process.exit(1);
}

console.log(
  `pack:verify OK: ${expected.length === 1 ? "the bundled AgentMail CLI target is" : `all ${expected.length} AgentMail CLI targets are`} in ${source} ` +
    `(${mebibytes(size)} of the ${mebibytes(CLAWHUB_PUBLISHABLE_UNPACKED_BYTES)} ClawHub publish limit).`,
);
