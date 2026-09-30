// Pure helpers for asserting a package vendors every bundled AgentMail CLI target.
//
// `prepack` (plugin:validate) already fails when the on-disk vendor tree is incomplete, but 0.2.1
// shipped with only `vendor/agentmail/darwin-arm64/agentmail` because the release skipped
// lifecycle scripts. `scripts/assert-cli-targets-packed.mjs` uses these helpers to check what is
// actually in the package: the `npm pack` file list, or a built .tgz passed on the command line.

export interface CliReleaseAsset {
  executableName: string;
}

export interface CliRelease {
  vendorDirectory: string;
  assets: Record<string, CliReleaseAsset>;
}

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

/**
 * File paths from `npm pack --dry-run --json` stdout. Tolerates leading non-JSON text and accepts
 * either the array npm prints or a single entry object.
 */
export function parseNpmPackFiles(stdout: string): string[] {
  const start = stdout.indexOf("[");
  const parsed: unknown = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
  const entry = (Array.isArray(parsed) ? parsed[0] : parsed) as
    | { files?: { path: string }[] }
    | undefined;
  return (entry?.files ?? []).map((file) => file.path);
}
