// Pure helpers for asserting a package vendors every bundled AgentMail CLI target and fits on
// ClawHub.
//
// `prepack` (plugin:validate) already fails when the on-disk vendor tree is incomplete, but 0.2.1
// shipped with only `vendor/agentmail/darwin-arm64/agentmail` because the release skipped
// lifecycle scripts. `scripts/assert-cli-targets-packed.mjs` uses these helpers to check what is
// actually in the package: the `npm pack` file list, or a built .tgz passed on the command line.
import { gunzipSync } from "node:zlib";

export interface CliReleaseAsset {
  executableName: string;
}

export interface CliRelease {
  vendorDirectory: string;
  assets: Record<string, CliReleaseAsset>;
}

/** One regular file in a package, as `npm pack` lists it or a .tgz contains it. */
export interface PackEntry {
  path: string;
  size: number;
}

/**
 * Largest package, as total file bytes, this plugin publishes to ClawHub. ClawHub advertises a
 * 50 MiB unpacked limit, but its publish endpoint parses the package inside a 64 MiB Convex action
 * at roughly tarball + 2x unpacked peak memory. A 35.7 MiB package returned a bare 500 on every
 * attempt, and the largest package ClawHub had accepted was about 24 MB. Each bundled CLI
 * executable is roughly 12 MiB, so one target fits.
 */
export const CLAWHUB_PUBLISHABLE_UNPACKED_BYTES = 20 * 1024 * 1024;

/** Normalizes an `npm pack` file path to a forward-slash, package-root-relative form. */
export function normalizePackPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^package\//, "");
}

/**
 * Vendor path (as it appears in an `npm pack` file list) of the bundled CLI executable for every
 * target declared in `release`, sorted for stable output.
 */
export function expectedCliVendorPaths(release: CliRelease): string[] {
  const vendorDirectory = release.vendorDirectory.replace(/\/+$/, "");
  return Object.entries(release.assets)
    .map(([target, asset]) => `${vendorDirectory}/${target}/${asset.executableName}`)
    .sort();
}

/**
 * The CLI target executables declared in `release` that are absent from `packedPaths` (the file
 * list of an `npm pack --dry-run --json` run). An empty array means the pack vendors every target.
 */
export function findMissingCliTargets(
  packedPaths: Iterable<string>,
  release: CliRelease,
): string[] {
  const packed = new Set<string>();
  for (const path of packedPaths) {
    packed.add(normalizePackPath(path));
  }
  return expectedCliVendorPaths(release).filter((path) => !packed.has(path));
}

function firstPackResult(parsed: unknown): unknown {
  if (Array.isArray(parsed)) {
    return parsed[0];
  }
  if (parsed && typeof parsed === "object") {
    // npm 12 keys results by package name; a bare result object carries `files` itself.
    return "files" in parsed ? parsed : Object.values(parsed)[0];
  }
  return undefined;
}

/**
 * File paths and sizes from `npm pack --dry-run --json` stdout. Tolerates leading non-JSON text and
 * accepts the array npm 11 prints, the object keyed by package name npm 12 prints, or a single
 * result object.
 */
export function parseNpmPackEntries(stdout: string): PackEntry[] {
  const starts = ["[", "{"].map((token) => stdout.indexOf(token)).filter((index) => index >= 0);
  const json = starts.length > 0 ? stdout.slice(Math.min(...starts)) : stdout;
  const parsed: unknown = JSON.parse(json);
  const result = firstPackResult(parsed) as { files?: PackEntry[] } | undefined;
  return (result?.files ?? []).map(({ path, size }) => ({ path, size }));
}

function readTarField(header: Uint8Array, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end));
}

/**
 * Regular files in an `npm pack` .tgz with package-root-relative paths, read the way ClawHub reads
 * a ClawPack. Directories are skipped; any other entry type fails, since ClawHub rejects it too.
 */
export function listTarballEntries(tgz: Uint8Array): PackEntry[] {
  const tar = gunzipSync(tgz);
  const entries: PackEntry[] = [];
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = readTarField(header, 0, 100);
    const prefix = readTarField(header, 345, 155);
    const size = Number.parseInt(readTarField(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    if (type === "0" || type === "\0") {
      entries.push({ path: normalizePackPath(prefix ? `${prefix}/${name}` : name), size });
    } else if (type !== "5") {
      throw new Error(`Unsupported tar entry type "${type}" for ${name}.`);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** Total bytes of `entries`, the figure ClawHub's package size limits apply to. */
export function unpackedBytes(entries: Iterable<PackEntry>): number {
  let total = 0;
  for (const entry of entries) {
    total += entry.size;
  }
  return total;
}
