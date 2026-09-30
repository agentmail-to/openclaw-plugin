import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type CliRelease,
  expectedCliVendorPaths,
  findMissingCliTargets,
  normalizePackPath,
  parseNpmPackFiles,
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
    // The Linux/Windows CLI a customer on those platforms actually needs.
    expect(missing).toContain("vendor/agentmail/linux-x64/agentmail");
    expect(missing).toContain("vendor/agentmail/win32-x64/agentmail.exe");
  });

  it("flags all targets when the vendor tree is absent entirely", () => {
    expect(findMissingCliTargets(["package.json", "README.md"], release)).toEqual(
      expectedCliVendorPaths(release),
    );
  });
});

describe("expectedCliVendorPaths", () => {
  it("uses the .exe executable name for Windows targets and the bare name elsewhere", () => {
    const paths = expectedCliVendorPaths(release);
    expect(paths).toContain("vendor/agentmail/win32-arm64/agentmail.exe");
    expect(paths).toContain("vendor/agentmail/darwin-x64/agentmail");
    expect(paths).toHaveLength(targetCount);
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

describe("parseNpmPackFiles", () => {
  const packJson = JSON.stringify([
    { name: "@agentmail/agentmail", files: [{ path: "package.json" }, { path: "dist/index.js" }] },
  ]);

  it("reads the file paths from npm pack --json output", () => {
    expect(parseNpmPackFiles(packJson)).toEqual(["package.json", "dist/index.js"]);
  });

  it("tolerates text printed before the JSON", () => {
    expect(parseNpmPackFiles(`> prepack notice\n${packJson}`)).toEqual([
      "package.json",
      "dist/index.js",
    ]);
  });

  it("returns an empty list when npm reports no files", () => {
    expect(parseNpmPackFiles("[{}]")).toEqual([]);
  });
});
