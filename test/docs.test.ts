import { describe, expect, test } from "bun:test";
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

  test("README explains auth, adaptive output, generated API status, upgrades, and the source skill honestly", async () => {
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
      "generic executor is not yet wired",
      "provider-specific commands",
      "skills/akua/SKILL.md",
      "brew upgrade akua",
    ]) {
      expect(readme).toContain(value);
    }
    expect(readme).toContain("private");
    expect(readme).toContain("skill name `akua`");
    expect(readme).toMatch(
      /API commands still report that execution\s+is not implemented\./,
    );
    expect(readme).not.toContain("Generated API commands execute");
    expect(readme).not.toContain("agent-skills-standard-following");
    expect(readme).not.toContain("skills add akua-dev/skills");
  });

  test("architecture records device authentication and both generated API artifacts without claiming execution", async () => {
    const architecture = await text("docs/architecture.md");

    for (const value of [
      "src/generated/commands.gen.ts",
      "src/generated/openapi-api.gen.ts",
      "Browser/device login",
      "akua auth login --no-browser",
      "generic executor is not yet wired",
      "provider-specific command",
    ]) {
      expect(architecture).toContain(value);
    }
  });

  test("AGENTS records durable release and cross-repository ownership rules", async () => {
    const agents = await text("AGENTS.md");

    expect(agents).toContain("scripts/release.ts");
    expect(agents).toContain("akua-dev/skills");
    expect(agents).toContain("akua-dev/homebrew-tap");
    expect(agents).toContain("## Maintaining this file");
  });
});
