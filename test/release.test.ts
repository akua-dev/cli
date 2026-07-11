import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

test("release packaging has a dedicated implementation module", async () => {
  expect(await Bun.file("scripts/release.ts").exists()).toBe(true);
});

describe("release target contract", () => {
  test("exposes local package, verify, and smoke tasks without publishing a package", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const mise = await readFile("mise.toml", "utf8");

    expect(packageJson.scripts["release:package"]).toContain("scripts/release.ts package");
    expect(packageJson.scripts["release:verify"]).toContain("scripts/release.ts verify");
    expect(packageJson.scripts["release:smoke"]).toContain("scripts/release.ts smoke");
    expect(JSON.stringify(packageJson.scripts)).not.toContain("publish");
    expect(mise).toContain('[tasks."release:package"]');
    expect(mise).toContain('[tasks."release:smoke"]');
  });

  test("defines the five tested Bun targets in stable order", async () => {
    const release = await import("../scripts/release") as Record<string, unknown>;

    expect(release.RELEASE_TARGETS).toEqual([
      {
        id: "darwin-arm64",
        bunTarget: "bun-darwin-arm64",
        os: "darwin",
        arch: "arm64",
        archive: "tar.gz",
        executable: "akua",
        runner: "macos-15",
        homebrew: { os: "macos", arch: "arm" },
      },
      {
        id: "darwin-x64",
        bunTarget: "bun-darwin-x64",
        os: "darwin",
        arch: "x64",
        archive: "tar.gz",
        executable: "akua",
        runner: "macos-15-intel",
        homebrew: { os: "macos", arch: "intel" },
      },
      {
        id: "linux-arm64",
        bunTarget: "bun-linux-arm64",
        os: "linux",
        arch: "arm64",
        archive: "tar.gz",
        executable: "akua",
        runner: "ubuntu-24.04-arm",
        homebrew: { os: "linux", arch: "arm" },
      },
      {
        id: "linux-x64",
        bunTarget: "bun-linux-x64-baseline",
        os: "linux",
        arch: "x64",
        archive: "tar.gz",
        executable: "akua",
        runner: "ubuntu-24.04",
        homebrew: { os: "linux", arch: "intel" },
      },
      {
        id: "windows-x64",
        bunTarget: "bun-windows-x64-baseline",
        os: "windows",
        arch: "x64",
        archive: "zip",
        executable: "akua.exe",
        runner: "windows-2025",
      },
    ]);
  });

  test("derives versioned archive and checksum names", async () => {
    const release = await import("../scripts/release") as Record<string, unknown>;
    const targets = release.RELEASE_TARGETS as Array<{ id: string; archive: string }>;
    const artifactName = release.artifactName as (version: string, target: { id: string; archive: string }) => string;

    expect(targets.map((target) => artifactName("1.2.3", target))).toEqual([
      "akua-v1.2.3-darwin-arm64.tar.gz",
      "akua-v1.2.3-darwin-x64.tar.gz",
      "akua-v1.2.3-linux-arm64.tar.gz",
      "akua-v1.2.3-linux-x64.tar.gz",
      "akua-v1.2.3-windows-x64.zip",
    ]);
  });

  test("renders standard SHA-256 checksum lines", async () => {
    const release = await import("../scripts/release") as Record<string, unknown>;
    const sha256 = release.sha256 as (bytes: Uint8Array) => string;
    const checksumLine = release.checksumLine as (name: string, digest: string) => string;
    const bytes = new TextEncoder().encode("akua\n");
    const digest = createHash("sha256").update(bytes).digest("hex");

    expect(sha256(bytes)).toBe(digest);
    expect(checksumLine("akua-v1.2.3-linux-x64.tar.gz", digest)).toBe(
      `${digest}  akua-v1.2.3-linux-x64.tar.gz\n`,
    );
  });

  test("packages executable-only archives, manifests, and matching checksums", async () => {
    const release = await import("../scripts/release") as Record<string, unknown>;
    const targets = release.RELEASE_TARGETS as Array<{ id: string }>;
    const packageExistingExecutables = release.packageExistingExecutables as (input: {
      version: string;
      outputDir: string;
      binaries: Record<string, string>;
    }) => Promise<void>;
    const verifyReleaseDirectory = release.verifyReleaseDirectory as (outputDir: string, version: string) => Promise<void>;
    const root = await mkdtemp(join(process.cwd(), ".tmp-akua-release-"));

    try {
      const source = join(root, "akua-fixture");
      const outputDir = join(root, "release");
      await writeFile(source, "#!/bin/sh\necho akua fixture\n");
      await chmod(source, 0o755);
      await packageExistingExecutables({
        version: "1.2.3",
        outputDir,
        binaries: Object.fromEntries(targets.map((target) => [target.id, source])),
      });

      await expect(verifyReleaseDirectory(outputDir, "1.2.3")).resolves.toBeUndefined();
      const manifest = JSON.parse(await readFile(join(outputDir, "akua-v1.2.3-manifest.json"), "utf8"));
      expect(manifest).toMatchObject({
        schema_version: 1,
        executable: "akua",
        version: "1.2.3",
        checksums: "checksums.txt",
        homebrew_manifest: "akua-v1.2.3-homebrew.json",
      });
      expect(manifest.assets).toHaveLength(5);
      expect(manifest.assets.map((asset: { target: string }) => asset.target)).toEqual(targets.map((target) => target.id));

      const homebrew = JSON.parse(await readFile(join(outputDir, "akua-v1.2.3-homebrew.json"), "utf8"));
      expect(homebrew).toMatchObject({
        schema_version: 1,
        formula: "akua",
        version: "1.2.3",
        release: "https://github.com/akua-dev/cli/releases/tag/v1.2.3",
      });
      expect(Object.keys(homebrew.platforms)).toEqual(["macos_arm", "macos_intel", "linux_arm", "linux_intel"]);
      expect(homebrew.platforms.linux_intel.url).toBe(
        "https://github.com/akua-dev/cli/releases/download/v1.2.3/akua-v1.2.3-linux-x64.tar.gz",
      );

      const extractDir = join(root, "extract");
      await mkdir(extractDir);
      const proc = Bun.spawn({
        cmd: ["tar", "-xzf", join(outputDir, "akua-v1.2.3-linux-x64.tar.gz"), "-C", extractDir],
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(exitCode).toBe(0);
      expect((await stat(join(extractDir, "akua"))).mode & 0o777).toBe(0o755);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("verification rejects an archive changed after checksumming", async () => {
    const release = await import("../scripts/release") as Record<string, unknown>;
    const targets = release.RELEASE_TARGETS as Array<{ id: string }>;
    const packageExistingExecutables = release.packageExistingExecutables as (input: {
      version: string;
      outputDir: string;
      binaries: Record<string, string>;
    }) => Promise<void>;
    const verifyReleaseDirectory = release.verifyReleaseDirectory as (outputDir: string, version: string) => Promise<void>;
    const root = await mkdtemp(join(process.cwd(), ".tmp-akua-release-"));

    try {
      const source = join(root, "akua-fixture");
      const outputDir = join(root, "release");
      await writeFile(source, "#!/bin/sh\necho akua fixture\n");
      await chmod(source, 0o755);
      await packageExistingExecutables({
        version: "1.2.3",
        outputDir,
        binaries: Object.fromEntries(targets.map((target) => [target.id, source])),
      });
      await writeFile(join(outputDir, "akua-v1.2.3-linux-x64.tar.gz"), "tampered");

      await expect(verifyReleaseDirectory(outputDir, "1.2.3")).rejects.toThrow("checksum mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("maps supported native hosts to release target IDs", async () => {
    const release = await import("../scripts/release") as Record<string, unknown>;
    const hostTargetId = release.hostTargetId as (platform: string, arch: string) => string;

    expect(hostTargetId("darwin", "arm64")).toBe("darwin-arm64");
    expect(hostTargetId("darwin", "x64")).toBe("darwin-x64");
    expect(hostTargetId("linux", "arm64")).toBe("linux-arm64");
    expect(hostTargetId("linux", "x64")).toBe("linux-x64");
    expect(hostTargetId("win32", "x64")).toBe("windows-x64");
    expect(() => hostTargetId("win32", "arm64")).toThrow("Unsupported release host");
  });

  test("extracts and executes all install-smoke commands for the native artifact", async () => {
    const release = await import("../scripts/release") as Record<string, unknown>;
    const targets = release.RELEASE_TARGETS as Array<{ id: string }>;
    const hostTargetId = release.hostTargetId as (platform: string, arch: string) => string;
    const packageExistingExecutables = release.packageExistingExecutables as (input: {
      version: string;
      outputDir: string;
      binaries: Record<string, string>;
    }) => Promise<void>;
    const smokeReleaseArtifact = release.smokeReleaseArtifact as (input: {
      version: string;
      outputDir: string;
      targetId: string;
    }) => Promise<void>;
    const root = await mkdtemp(join(process.cwd(), ".tmp-akua-release-"));

    try {
      const source = join(root, "akua-fixture");
      const outputDir = join(root, "release");
      await writeFile(
        source,
        "#!/bin/sh\ncase \"$1\" in\n  --version) echo 'akua 1.2.3' ;;\n  --help) echo 'Usage: akua' ;;\n  commands) echo 'commands[1]' ;;\n  *) exit 2 ;;\nesac\n",
      );
      await chmod(source, 0o755);
      await packageExistingExecutables({
        version: "1.2.3",
        outputDir,
        binaries: Object.fromEntries(targets.map((target) => [target.id, source])),
      });

      await expect(smokeReleaseArtifact({
        version: "1.2.3",
        outputDir,
        targetId: hostTargetId(process.platform, process.arch),
      })).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
