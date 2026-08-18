import { describe, expect, test } from "@effect/vitest";
import { readFile } from "node:fs/promises";

async function text(path: string): Promise<string> {
  return readFile(path, "utf8").catch(() => "");
}

describe("distribution documentation", () => {
  test("README documents only the implemented GitHub Release and Homebrew channels", async () => {
    const readme = await text("README.md");

    expect(readme).toContain("brew install akua-dev/tap/akua");
    expect(readme).toContain("https://github.com/akua-dev/cli/releases/download/");
    expect(readme).toContain("akua-v0.9.0-darwin-arm64.tar.gz");
    expect(readme).toContain("akua-v0.9.0-windows-x64.zip");
    expect(readme).toContain("checksums.txt");
    expect(readme).toContain("sha256sum");
    expect(readme).toContain("Get-FileHash");
    expect(readme).not.toMatch(/npm (?:install|i)|bun add|npx .*@akua-dev\/cli/);
  });

  test("README explains auth, adaptive output, generated API status, and upgrades honestly", async () => {
    const readme = await text("README.md");

    for (const value of [
      "AKUA_API_TOKEN",
      "akua auth login",
      "akua auth login --no-browser",
      "akua auth status",
      "akua auth logout",
      "~/.config/akua/config.json",
      "0700",
      "0600",
      "unknown config keys",
      "AGENT=true",
      "AGENT=<name>",
      "non-TTY",
      "mise run spec:fetch",
      "mise run generate",
      "mise run generate:check",
      "operationId",
      "generated typed Effect API",
      "akua workspaces list --input -",
      "akua machines create --input -",
      "provider-specific commands",
      "brew upgrade akua",
    ]) {
      expect(readme).toContain(value);
    }
    expect(readme).not.toContain("skills/akua/");
    expect(readme).not.toContain("akua-dev/skills");
    expect(readme).toContain("Generated API commands execute");
    expect(readme).not.toContain("generic executor is not yet wired");
    expect(readme).not.toContain("agent-skills-standard-following");
    expect(readme).not.toContain("skills add akua-dev/skills");
  });

  test("architecture records device authentication and all generated API artifacts", async () => {
    const architecture = await text("docs/architecture.md");

    for (const value of [
      "src/generated/commands.gen.ts",
      "src/generated/openapi-api.gen.ts",
      "src/generated/public-operation-executor.gen.ts",
      "Browser/device login",
      "akua auth login --no-browser",
      "--input -",
      "provider-specific command",
    ]) {
      expect(architecture).toContain(value);
    }
  });

  test("AGENTS records durable release and Effect-only development rules", async () => {
    const agents = await text("AGENTS.md");

    expect(agents).toContain("scripts/release.ts");
    expect(agents).toContain("akua-dev/homebrew-tap");
    expect(agents).toContain("skills/effect-v4/SKILL.md");
    expect(agents).toContain("## Maintaining this file");
  });
});
