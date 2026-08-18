import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

async function text(path: string): Promise<string> {
  return readFile(path, "utf8").catch(() => "");
}

describe("distribution documentation", () => {
  test("README documents Homebrew as the primary install channel", async () => {
    const readme = await text("README.md");

    expect(readme).toContain("brew install akua-dev/tap/akua");
    expect(readme).toContain("brew upgrade akua");
    expect(readme).not.toMatch(/npm (?:install|i)|bun add|npx .*@akua-dev\/cli/);
  });

  test("README points to docs/install.md instead of inlining GitHub Release steps", async () => {
    const readme = await text("README.md");

    expect(readme).toContain("[manual install](docs/install.md)");
    expect(readme).not.toContain("https://github.com/akua-dev/cli/releases/download/");
    expect(readme).not.toContain("akua-v0.10.1-darwin-arm64.tar.gz");
    expect(readme).not.toContain("akua-v0.10.1-windows-x64.zip");
    expect(readme).not.toContain("checksums.txt");
    expect(readme).not.toContain("sha256sum");
    expect(readme).not.toContain("Get-FileHash");
  });

  test("docs/install.md documents the checksummed GitHub Release fallback", async () => {
    const install = await text("docs/install.md");

    expect(install).toContain("https://github.com/akua-dev/cli/releases/download/");
    expect(install).toContain("akua-v0.10.1-darwin-arm64.tar.gz");
    expect(install).toContain("akua-v0.10.1-windows-x64.zip");
    expect(install).toContain("checksums.txt");
    expect(install).toContain("sha256sum");
    expect(install).toContain("Get-FileHash");
    expect(install).toContain("Homebrew");
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
      "operationId",
      "generated directly from Akua's public API",
      "akua workspaces list --input -",
      "akua machines create --input -",
      "provider-specific commands",
      "brew upgrade akua",
    ]) {
      expect(readme).toContain(value);
    }
    expect(readme).not.toContain("skills/akua/");
    expect(readme).not.toContain("akua-dev/skills");
    expect(readme).toContain("Generated commands accept one JSON object");
    expect(readme).not.toContain("generic executor is not yet wired");
    expect(readme).not.toContain("agent-skills-standard-following");
    expect(readme).not.toContain("skills add akua-dev/skills");
  });

  test("README treats the underlying framework as an implementation detail", async () => {
    const readme = await text("README.md");

    expect(readme).not.toMatch(/\bEffect\b/);
    expect(readme).toContain("humans, CI, and agents");
  });

  test("README stays user-facing and defers repo development to CONTRIBUTING.md", async () => {
    const readme = await text("README.md");

    expect(readme).toContain("docs.akua.dev");
    expect(readme).toContain("Contributing to this repo? See [CONTRIBUTING.md](CONTRIBUTING.md).");
    expect(readme).not.toContain("mise run spec:fetch");
    expect(readme).not.toContain("mise run generate");
    expect(readme).not.toContain("mise run generate:check");
    expect(readme).not.toContain("mise run release:package");
    expect(readme).not.toContain("mise run release:smoke");
    expect(readme).not.toContain("mise install");
    expect(readme).not.toContain("Release Please");
    expect(readme).not.toContain("HOMEBREW_TAP_TOKEN");
  });

  test("CONTRIBUTING documents generation, testing, and release mechanics", async () => {
    const contributing = await text("CONTRIBUTING.md");

    for (const value of [
      "mise install",
      "mise run check",
      "mise run spec:fetch",
      "mise run generate",
      "mise run generate:check",
      "bun test",
      "mise run release:package",
      "mise run release:verify",
      "mise run release:smoke",
      "Release Please",
      "HOMEBREW_TAP_TOKEN",
      "src/generated/commands.gen.ts",
      "docs/architecture.md",
      "AGENTS.md",
    ]) {
      expect(contributing).toContain(value);
    }
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
