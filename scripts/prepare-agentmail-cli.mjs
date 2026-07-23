import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const release = JSON.parse(
  readFileSync(new URL("../src/cli/agentmail-cli-release.json", import.meta.url), "utf8"),
);
const vendorRoot = join(root, ...release.vendorDirectory.split("/"));
const versionPath = join(vendorRoot, "VERSION");
const allTargets = Object.keys(release.assets).sort();

function currentTarget() {
  const key = `${process.platform}-${process.arch}`;
  if (!release.assets[key]) {
    throw new Error(`AgentMail CLI ${release.version} has no packaged target for ${key}.`);
  }
  return key;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

function extract(archive, destination, executableName) {
  mkdirSync(destination, { recursive: true });
  if (!archive.endsWith(".tar.gz")) {
    const entries = unzipSync(new Uint8Array(readFileSync(archive)));
    const executable = entries[executableName];
    if (!executable) {
      throw new Error(`${basename(archive)} did not contain ${executableName} at its root.`);
    }
    writeFileSync(join(destination, executableName), executable);
    return;
  }
  const result = spawnSync("tar", ["-xzf", archive, "-C", destination], {
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Failed to extract ${basename(archive)} (exit ${result.status}).`);
  }
}

async function prepareTarget(target, temporaryRoot) {
  const metadata = release.assets[target];
  const executableName = metadata.executableName;
  const destination = join(vendorRoot, target, executableName);
  if (existsSync(destination)) {
    console.log(`AgentMail CLI ${release.version} already prepared for ${target}.`);
    return;
  }

  const archivePath = join(temporaryRoot, metadata.archive);
  const url =
    `https://github.com/${release.repository}/releases/download/` +
    `v${release.version}/${metadata.archive}`;
  console.log(`Downloading AgentMail CLI ${release.version} for ${target}...`);
  await download(url, archivePath);

  const actualChecksum = sha256(archivePath);
  if (actualChecksum !== metadata.sha256) {
    throw new Error(
      `Checksum mismatch for ${metadata.archive}: expected ${metadata.sha256}, got ${actualChecksum}.`,
    );
  }

  const extractRoot = join(temporaryRoot, target);
  extract(archivePath, extractRoot, executableName);
  const extractedExecutable = join(extractRoot, executableName);
  if (!existsSync(extractedExecutable)) {
    throw new Error(`${metadata.archive} did not contain ${executableName} at its root.`);
  }

  mkdirSync(dirname(destination), { recursive: true });
  const stagedDestination = `${destination}.tmp-${process.pid}`;
  copyFileSync(extractedExecutable, stagedDestination);
  if (!target.startsWith("win32-")) {
    chmodSync(stagedDestination, 0o755);
  }
  renameSync(stagedDestination, destination);
}

const existingVersion = existsSync(versionPath)
  ? readFileSync(versionPath, "utf8").trim()
  : undefined;
if (existingVersion !== release.version && existsSync(vendorRoot)) {
  rmSync(vendorRoot, { recursive: true, force: true });
}
mkdirSync(vendorRoot, { recursive: true });
// A marker represents a fully successful preparation run, not merely a selected release. Remove
// any prior marker while verifying/filling the requested target set and restore it atomically below.
rmSync(versionPath, { force: true });

const targets = process.argv.includes("--all") ? allTargets : [currentTarget()];
const temporaryRoot = mkdtempSync(join(tmpdir(), "agentmail-cli-prepare-"));

try {
  for (const target of targets) {
    await prepareTarget(target, temporaryRoot);
  }

  const licensePath = join(vendorRoot, "LICENSE");
  if (!existsSync(licensePath)) {
    await download(
      `https://raw.githubusercontent.com/${release.repository}/v${release.version}/LICENSE`,
      licensePath,
    );
  }
  // Commit the version marker only after the requested binaries and license are complete. If any
  // preparation step fails, the absent marker forces the next run to rebuild the partial directory.
  const stagedVersionPath = `${versionPath}.tmp-${process.pid}`;
  writeFileSync(stagedVersionPath, `${release.version}\n`);
  renameSync(stagedVersionPath, versionPath);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log(
  `Prepared AgentMail CLI ${release.version} for ${targets.length} target${targets.length === 1 ? "" : "s"}.`,
);
