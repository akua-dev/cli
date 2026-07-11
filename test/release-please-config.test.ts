import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface ReleasePleaseConfig {
  "include-component-in-tag"?: boolean;
  packages?: Record<string, {
    "release-type"?: string;
    "package-name"?: string;
    "changelog-path"?: string;
    "extra-files"?: Array<{
      type?: string;
      path?: string;
      jsonpath?: string;
    }>;
  }>;
}

describe("release-please configuration", () => {
  test("configures the root Bun CLI package without publish automation", () => {
    const config = JSON.parse(readFileSync("release-please-config.json", "utf8")) as ReleasePleaseConfig;

    expect(config.packages?.["."]).toEqual({
      "release-type": "node",
      "package-name": "@akua-dev/cli",
      "changelog-path": "CHANGELOG.md",
      "extra-files": [
        {
          type: "generic",
          path: "src/bin/akua.ts",
        },
        {
          type: "json",
          path: "skills/agent-skills-standard-following/skill-package.json",
          jsonpath: "$.version",
        },
      ],
    });
    expect(config["include-component-in-tag"]).toBe(false);
    expect(JSON.stringify(config)).not.toContain("npm");
    expect(JSON.stringify(config)).not.toContain("publish");
  });

  test("updates the CLI version reported by akua --version", () => {
    const cli = readFileSync("src/bin/akua.ts", "utf8");

    expect(cli).toMatch(/const VERSION = "\d+\.\d+\.\d+(?:[-+][^"]+)?"; \/\/ x-release-please-version/);
  });

  test("tracks the root package release version", () => {
    const manifest = JSON.parse(readFileSync(".release-please-manifest.json", "utf8")) as Record<string, string>;

    expect(Object.keys(manifest)).toEqual(["."]);
    expect(manifest["."]).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  });

  test("falls back to the job token when the optional release token is unavailable", () => {
    const workflow = readFileSync(".github/workflows/release-please.yml", "utf8");

    expect(workflow).toContain("token: ${{ secrets.RELEASE_PLEASE_TOKEN || github.token }}");
  });
});
