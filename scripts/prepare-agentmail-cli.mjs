import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  readFileSync(new URL("./agentmail-cli-release.json", import.meta.url), "utf8"),
);
const vendorRoot = join(root, "vendor", "agentmail");
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

function extract(archive, destination) {
  mkdirSync(destination, { recursive: true });
  const result = archive.endsWith(".tar.gz")
    ? spawnSync("tar", ["-xzf", archive, "-C", destination], { stdio: "inherit" })
    : process.platform === "win32"
      ? spawnSync(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            "Expand-Archive",
            "-LiteralPath",
            archive,
            "-DestinationPath",
            destination,
            "-Force",
          ],
          { stdio: "inherit" },
        )
      : spawnSync("unzip", ["-q", "-o", archive, "-d", destination], {
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
  const executableName = target.startsWith("win32-") ? "agentmail.exe" : "agentmail";
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
  extract(archivePath, extractRoot);
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
if (existingVersion && existingVersion !== release.version) {
  rmSync(vendorRoot, { recursive: true, force: true });
}
mkdirSync(vendorRoot, { recursive: true });
writeFileSync(versionPath, `${release.version}\n`);

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
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log(
  `Prepared AgentMail CLI ${release.version} for ${targets.length} target${targets.length === 1 ? "" : "s"}.`,
);
