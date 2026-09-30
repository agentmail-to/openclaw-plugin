import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CliRelease,
  expectedCliVendorPaths,
  findMissingCliTargets,
  listTarballEntries,
  normalizePackPath,
  parseNpmPackEntries,
  unpackedBytes,
} from "./pack-targets.js";

const release = JSON.parse(
  readFileSync(new URL("./agentmail-cli-release.json", import.meta.url), "utf8"),
) as CliRelease;

const targetCount = Object.keys(release.assets).length;

function fullPackFileList(): string[] {
  return [
    "package.json",
    "README.md",
    "dist/index.js",
    "vendor/agentmail/VERSION",
    ...expectedCliVendorPaths(release),
  ];
}

describe("findMissingCliTargets", () => {
  it("reports nothing missing when every CLI platform is vendored", () => {
    expect(findMissingCliTargets(fullPackFileList(), release)).toEqual([]);
  });

  it("flags every other target for a darwin-arm64-only pack (the 0.2.1 defect)", () => {
    const hostOnly = [
      "package.json",
      "vendor/agentmail/VERSION",
      "vendor/agentmail/darwin-arm64/agentmail",
    ];
    const missing = findMissingCliTargets(hostOnly, release);

    expect(missing).not.toContain("vendor/agentmail/darwin-arm64/agentmail");
    expect(missing).toHaveLength(targetCount - 1);
    // The Linux CLI a customer on those platforms actually needs.
    expect(missing).toContain("vendor/agentmail/linux-x64/agentmail");
    expect(missing).toContain("vendor/agentmail/linux-arm64/agentmail");
  });

  it("flags all targets when the vendor tree is absent entirely", () => {
    expect(findMissingCliTargets(["package.json", "README.md"], release)).toEqual(
      expectedCliVendorPaths(release),
    );
  });
});

describe("expectedCliVendorPaths", () => {
  it("lists one executable per declared target", () => {
    const paths = expectedCliVendorPaths(release);
    expect(paths).toContain("vendor/agentmail/darwin-arm64/agentmail");
    expect(paths).toHaveLength(targetCount);
  });

  it("uses each target's executable name, such as agentmail.exe on Windows", () => {
    const withWindows: CliRelease = {
      vendorDirectory: "vendor/agentmail/",
      assets: {
        "linux-x64": { executableName: "agentmail" },
        "win32-x64": { executableName: "agentmail.exe" },
      },
    };
    expect(expectedCliVendorPaths(withWindows)).toEqual([
      "vendor/agentmail/linux-x64/agentmail",
      "vendor/agentmail/win32-x64/agentmail.exe",
    ]);
  });
});

describe("normalizePackPath", () => {
  it("strips package/ and ./ prefixes and normalizes backslashes", () => {
    expect(normalizePackPath("package/vendor/agentmail/linux-x64/agentmail")).toBe(
      "vendor/agentmail/linux-x64/agentmail",
    );
    expect(normalizePackPath("./dist/index.js")).toBe("dist/index.js");
    expect(normalizePackPath("vendor\\agentmail\\win32-x64\\agentmail.exe")).toBe(
      "vendor/agentmail/win32-x64/agentmail.exe",
    );
  });
});

describe("parseNpmPackEntries", () => {
  const files = [
    { path: "package.json", size: 120, mode: 420 },
    { path: "dist/index.js", size: 3000, mode: 420 },
  ];
  const expected = [
    { path: "package.json", size: 120 },
    { path: "dist/index.js", size: 3000 },
  ];

  it("reads paths and sizes from the array npm 11 prints", () => {
    const packJson = JSON.stringify([{ name: "@agentmail/agentmail", files }]);
    expect(parseNpmPackEntries(packJson)).toEqual(expected);
  });

  it("reads paths and sizes from the object keyed by package name that npm 12 prints", () => {
    const packJson = JSON.stringify({
      "@agentmail/agentmail": { name: "@agentmail/agentmail", files },
    });
    expect(parseNpmPackEntries(packJson)).toEqual(expected);
  });

  it("tolerates text printed before the JSON", () => {
    const packJson = JSON.stringify({ "@agentmail/agentmail": { files } });
    expect(parseNpmPackEntries(`> prepack notice\n${packJson}`)).toEqual(expected);
  });

  it("returns an empty list when npm reports no files", () => {
    expect(parseNpmPackEntries("[{}]")).toEqual([]);
  });
});

describe("listTarballEntries", () => {
  it("lists every regular file of an npm pack tarball with its size", { timeout: 30_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "pack-targets-test-"));
    try {
      const source = join(root, "source");
      // Longer than the 100-byte ustar name field, so the path is split into prefix + name.
      const longPath = `vendor/${"a".repeat(60)}/${"b".repeat(60)}.txt`;
      mkdirSync(join(source, "vendor", "a".repeat(60)), { recursive: true });
      const packageJson = JSON.stringify({ name: "fixture", version: "1.0.0", files: ["vendor"] });
      writeFileSync(join(source, "package.json"), packageJson);
      writeFileSync(join(source, longPath), Buffer.alloc(1000, 1));
      execFileSync("npm", ["pack", source, "--ignore-scripts", "--pack-destination", root], {
        stdio: "ignore",
        shell: process.platform === "win32",
      });
      const tarball = readdirSync(root).find((file) => file.endsWith(".tgz"));

      const entries = listTarballEntries(readFileSync(join(root, tarball ?? "missing.tgz")));

      expect(entries).toEqual(
        expect.arrayContaining([
          { path: "package.json", size: Buffer.byteLength(packageJson) },
          { path: longPath, size: 1000 },
        ]),
      );
      expect(entries).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("unpackedBytes", () => {
  it("sums file sizes, the figure ClawHub's 50 MiB package limit applies to", () => {
    expect(
      unpackedBytes([
        { path: "package.json", size: 120 },
        { path: "vendor/agentmail/linux-x64/agentmail", size: 13_000_000 },
      ]),
    ).toBe(13_000_120);
  });
});
