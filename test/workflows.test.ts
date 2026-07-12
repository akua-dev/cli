import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("distribution workflows", () => {
  test("the release workflow consumes the complete release target matrix", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");

    expect(workflow).toContain("bun scripts/release.ts matrix");
    expect(workflow).toContain("fromJSON(needs.package.outputs.matrix)");
  });

  test("CI packages once and install-smokes every runnable target natively", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");

    expect(workflow).toContain("package-release:");
    expect(workflow).toContain("install-smoke:");
    expect(workflow).toContain("bun scripts/release.ts matrix");
    expect(workflow).toContain("fromJSON(needs.package-release.outputs.matrix)");
    expect(workflow).toContain("bun scripts/release.ts smoke");
  });

  test("release inputs reach shell scripts only through quoted environment variables", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");

    expect(workflow).not.toContain('test "${{ inputs.tag }}"');
    expect(workflow).not.toContain('--version "${{ inputs.version }}"');
    expect(workflow).not.toContain('gh release upload "${{ inputs.tag }}"');
    expect(workflow).not.toContain('gh release download "${{ inputs.tag }}"');
    expect(workflow).toContain("TAG: ${{ inputs.tag }}");
    expect(workflow).toContain("VERSION: ${{ inputs.version }}");
    expect(workflow).toContain('test "$TAG" = "v$VERSION"');
  });

  test("release smoke runners are derived from the release target contract", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");

    expect(workflow).toContain("bun scripts/release.ts matrix");
    expect(workflow).toContain("fromJSON(needs.package.outputs.matrix)");
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
