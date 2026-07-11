import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("distribution workflows", () => {
  test("the release workflow no longer publishes only Linux x64", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");

    for (const target of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64"]) {
      expect(workflow).toContain(target);
    }
  });

  test("CI packages once and install-smokes every runnable target natively", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");

    expect(workflow).toContain("package-release:");
    expect(workflow).toContain("install-smoke:");
    for (const runner of ["macos-15", "macos-15-intel", "ubuntu-24.04-arm", "ubuntu-24.04", "windows-2025"]) {
      expect(workflow).toContain(runner);
    }
    expect(workflow).toContain("bun scripts/release.ts smoke");
  });

  test("Release Please invokes artifact publication without relying on a tag event", async () => {
    const workflow = await readFile(".github/workflows/release-please.yml", "utf8");

    expect(workflow).toContain("release_created:");
    expect(workflow).toContain("tag_name:");
    expect(workflow).toContain("uses: ./.github/workflows/release.yml");
    expect(workflow).toContain("secrets: inherit");
  });

  test("release publication is verified before the tap dispatch", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");

    expect(workflow).toContain("workflow_call:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("gh release upload");
    expect(workflow).not.toContain("--clobber");
    expect(workflow).toContain("gh release download");
    expect(workflow).toContain("bun scripts/release.ts verify");
    expect(workflow).toContain("tap-update:");
    expect(workflow).toContain("needs: publish");
    expect(workflow).toContain("HOMEBREW_TAP_TOKEN");
    expect(workflow).toContain("repos/akua-dev/homebrew-tap/dispatches");
    expect(workflow).toContain("akua-cli-release-published");
    expect(workflow).not.toContain("force");
  });

  test("OpenAPI automation remains idempotent and restricted to generated inputs", async () => {
    const workflow = await readFile(".github/workflows/update-openapi.yml", "utf8");

    expect(workflow).toContain('path != "openapi/public.json" && path != "src/generated/commands.gen.ts"');
    expect(workflow).toContain("git diff --quiet -- openapi/public.json src/generated/commands.gen.ts");
    expect(workflow).toContain("if: steps.openapi-diff.outputs.changed == 'true'");
    expect(workflow).toContain("add-paths: |");
    expect(workflow).toContain("openapi/public.json\n            src/generated/commands.gen.ts");
  });
});
