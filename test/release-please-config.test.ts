import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface ReleasePleaseConfig {
  packages?: Record<string, {
    "release-type"?: string;
    "package-name"?: string;
    "changelog-path"?: string;
  }>;
}

describe("release-please configuration", () => {
  test("configures the root Bun CLI package without publish automation", () => {
    const config = JSON.parse(readFileSync("release-please-config.json", "utf8")) as ReleasePleaseConfig;

    expect(config.packages?.["."]).toEqual({
      "release-type": "node",
      "package-name": "@akua-dev/cli",
      "changelog-path": "CHANGELOG.md",
    });
    expect(JSON.stringify(config)).not.toContain("npm");
    expect(JSON.stringify(config)).not.toContain("publish");
  });

  test("bootstraps from the latest existing repository release", () => {
    const manifest = JSON.parse(readFileSync(".release-please-manifest.json", "utf8")) as Record<string, string>;

    expect(manifest).toEqual({ ".": "0.6.1" });
  });
});
