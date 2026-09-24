// Pure helpers for asserting an `npm pack` tarball vendors every bundled AgentMail CLI target.
//
// The plugin ships the AgentMail CLI for all platforms under `vendor/agentmail/<target>/…`, but
// that tree is only assembled when `prepack` runs `cli:prepare -- --all` during pack/publish.
// A build that skips lifecycle scripts (or a host-only `plugin:build`) vendors just the current
// platform, and `npm pack` still succeeds silently — which is how 0.2.1 shipped with only
// `vendor/agentmail/darwin-arm64/agentmail`. `scripts/assert-cli-targets-packed.mjs` uses the
// functions below to turn that silent gap into a hard failure.

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
