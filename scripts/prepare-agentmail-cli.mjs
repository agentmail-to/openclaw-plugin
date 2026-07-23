import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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
const vendorParent = dirname(vendorRoot);
const versionPath = join(vendorRoot, "VERSION");
const preparationLock = `${vendorRoot}.prepare-lock`;
const allTargets = Object.keys(release.assets).sort();
const INCOMPLETE_LOCK_GRACE_MS = 30_000;

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function acquirePreparationLock() {
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // `wx` makes ownership acquisition atomic. The token prevents this process from deleting a
      // replacement lock during cleanup.
      writeFileSync(preparationLock, `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return owner.token;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    let existing;
    try {
      existing = JSON.parse(readFileSync(preparationLock, "utf8"));
    } catch {
      // A writer can be between exclusive creation and its synchronous write. Do not steal a
      // fresh unreadable lock; an interrupted/incomplete marker becomes recoverable after grace.
      let ageMs;
      try {
        ageMs = Date.now() - statSync(preparationLock).mtimeMs;
      } catch (error) {
        if (error?.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (ageMs < INCOMPLETE_LOCK_GRACE_MS) {
        throw new Error(
          `Another AgentMail CLI preparation is already using ${preparationLock}.`,
        );
      }
    }
    if (processIsRunning(existing?.pid)) {
      throw new Error(
        `Another AgentMail CLI preparation (pid ${existing.pid}) is already using ${preparationLock}.`,
      );
    }

    // Rename the exact stale marker out of the lock path before deletion. A competing recovery can
    // then win acquisition without either process deleting the other's new lock.
    const staleLock = `${preparationLock}.stale-${process.pid}-${randomUUID()}`;
    try {
      renameSync(preparationLock, staleLock);
      rmSync(staleLock, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  throw new Error(`Could not acquire AgentMail CLI preparation lock ${preparationLock}.`);
}

function releasePreparationLock(token) {
  try {
    const owner = JSON.parse(readFileSync(preparationLock, "utf8"));
    if (owner?.pid === process.pid && owner?.token === token) {
      rmSync(preparationLock, { force: true });
    }
  } catch {
    // Best effort. A missing or replaced lock belongs to no work this process may clean up.
  }
}

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

async function prepareTarget(target, temporaryRoot, destinationRoot) {
  const metadata = release.assets[target];
  const executableName = metadata.executableName;
  const destination = join(destinationRoot, target, executableName);
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

async function main() {
  mkdirSync(vendorParent, { recursive: true });
  const preparationLockToken = acquirePreparationLock();

  let temporaryRoot;
  let stagingParent;
  const backupRoot = `${vendorRoot}.backup-${process.pid}`;

  try {
    const targets = process.argv.includes("--all") ? allTargets : [currentTarget()];
    temporaryRoot = mkdtempSync(join(tmpdir(), "agentmail-cli-prepare-"));
    stagingParent = mkdtempSync(join(vendorParent, ".agentmail-cli-stage-"));
    const stagedVendorRoot = join(stagingParent, basename(vendorRoot));
    const existingVersion = existsSync(versionPath)
      ? readFileSync(versionPath, "utf8").trim()
      : undefined;
    const requestedTreeIsComplete =
      existingVersion === release.version &&
      existsSync(join(vendorRoot, "LICENSE")) &&
      targets.every((target) => {
        const metadata = release.assets[target];
        return existsSync(join(vendorRoot, target, metadata.executableName));
      });
    if (requestedTreeIsComplete) {
      for (const target of targets) {
        console.log(`AgentMail CLI ${release.version} already prepared for ${target}.`);
      }
    } else {
      // Build a complete replacement tree beside the live one. A failed download, checksum,
      // extraction, or LICENSE fetch leaves the currently installed tree untouched.
      if (existingVersion === release.version && existsSync(vendorRoot)) {
        cpSync(vendorRoot, stagedVendorRoot, { recursive: true });
      } else {
        mkdirSync(stagedVendorRoot, { recursive: true });
      }

      for (const target of targets) {
        await prepareTarget(target, temporaryRoot, stagedVendorRoot);
      }

      const licensePath = join(stagedVendorRoot, "LICENSE");
      if (!existsSync(licensePath)) {
        const downloadedLicense = join(temporaryRoot, "LICENSE");
        await download(
          `https://raw.githubusercontent.com/${release.repository}/v${release.version}/LICENSE`,
          downloadedLicense,
        );
        copyFileSync(downloadedLicense, licensePath);
      }
      // The marker lives only in the staged tree and therefore becomes visible with the complete
      // requested tree, never before its binaries and license.
      writeFileSync(join(stagedVendorRoot, "VERSION"), `${release.version}\n`);

      let originalMoved = false;
      try {
        if (existsSync(vendorRoot)) {
          renameSync(vendorRoot, backupRoot);
          originalMoved = true;
        }
        renameSync(stagedVendorRoot, vendorRoot);
      } catch (error) {
        if (originalMoved && !existsSync(vendorRoot) && existsSync(backupRoot)) {
          renameSync(backupRoot, vendorRoot);
        }
        throw error;
      }
      if (originalMoved) {
        rmSync(backupRoot, { recursive: true, force: true });
      }
    }

    console.log(
      `Prepared AgentMail CLI ${release.version} for ${targets.length} target${targets.length === 1 ? "" : "s"}.`,
    );
  } finally {
    if (temporaryRoot) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
    if (stagingParent) {
      rmSync(stagingParent, { recursive: true, force: true });
    }
    releasePreparationLock(preparationLockToken);
  }
}

await main();
