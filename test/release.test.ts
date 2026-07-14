import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { parse, join } from "node:path";

async function makeReleaseTempDir(): Promise<string> {
  const releaseRoot = join(process.cwd(), "dist", "release");
  await mkdir(releaseRoot, { recursive: true });
  return mkdtemp(join(releaseRoot, ".tmp-akua-release-"));
}

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

  test("derives the GitHub Actions matrix from the release target contract", async () => {
    const release = await import("../scripts/release") as Record<string, unknown>;
    const releaseMatrix = release.releaseMatrix as () => { include: Array<{ target: string; runner: string }> };

    expect(releaseMatrix()).toEqual({
      include: [
        { target: "darwin-arm64", runner: "macos-15" },
        { target: "darwin-x64", runner: "macos-15-intel" },
        { target: "linux-arm64", runner: "ubuntu-24.04-arm" },
        { target: "linux-x64", runner: "ubuntu-24.04" },
        { target: "windows-x64", runner: "windows-2025" },
      ],
    });
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

  test("plans uploads for only release assets missing from an identical existing subset", async () => {
    const release = await import("../scripts/release") as Record<string, unknown>;
    expect(typeof release.planReleaseUploads).toBe("function");
    if (typeof release.planReleaseUploads !== "function") {
      return;
    }
    const planReleaseUploads = release.planReleaseUploads as (
      candidateDir: string,
      existingDir: string,
      version: string,
    ) => Promise<string[]>;
    const releaseAssetNames = release.releaseAssetNames as (version: string) => string[];
    const root = await makeReleaseTempDir();

    try {
      const candidateDir = join(root, "candidate");
      const existingDir = join(root, "existing");
      const assetNames = releaseAssetNames("1.2.3");
      await mkdir(candidateDir);
      await mkdir(existingDir);
      for (const name of assetNames) {
        await writeFile(join(candidateDir, name), `candidate ${name}\n`);
      }
      await copyFile(join(candidateDir, assetNames[0]), join(existingDir, assetNames[0]));
      await copyFile(join(candidateDir, assetNames[4]), join(existingDir, assetNames[4]));

      await expect(planReleaseUploads(candidateDir, existingDir, "1.2.3")).resolves.toEqual(
        assetNames.filter((_, index) => index !== 0 && index !== 4).map((name) => join(candidateDir, name)),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an existing release asset that differs from the candidate", async () => {
    const release = await import("../scripts/release") as Record<string, unknown>;
    expect(typeof release.planReleaseUploads).toBe("function");
    if (typeof release.planReleaseUploads !== "function") {
      return;
    }
    const planReleaseUploads = release.planReleaseUploads as (
      candidateDir: string,
      existingDir: string,
      version: string,
    ) => Promise<string[]>;
    const releaseAssetNames = release.releaseAssetNames as (version: string) => string[];
    const root = await makeReleaseTempDir();

    try {
      const candidateDir = join(root, "candidate");
      const existingDir = join(root, "existing");
      const assetNames = releaseAssetNames("1.2.3");
      await mkdir(candidateDir);
      await mkdir(existingDir);
      for (const name of assetNames) {
        await writeFile(join(candidateDir, name), `candidate ${name}\n`);
      }
      await writeFile(join(existingDir, assetNames[0]), "different bytes\n");

      await expect(planReleaseUploads(candidateDir, existingDir, "1.2.3"))
        .rejects.toThrow(`Existing release asset does not match candidate: ${assetNames[0]}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    const root = await makeReleaseTempDir();

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

  test("packages byte-identical release assets across repeated builds", async () => {
    const release = await import("../scripts/release") as Record<string, unknown>;
    const targets = release.RELEASE_TARGETS as Array<{ id: string }>;
    const releaseAssetNames = release.releaseAssetNames as (version: string) => string[];
    const packageExistingExecutables = release.packageExistingExecutables as (input: {
      version: string;
      outputDir: string;
      binaries: Record<string, string>;
    }) => Promise<void>;
    const root = await makeReleaseTempDir();

    try {
      const source = join(root, "akua-fixture");
      const firstOutputDir = join(root, "first");
      const secondOutputDir = join(root, "second");
      const binaries = Object.fromEntries(targets.map((target) => [target.id, source]));
      await writeFile(source, "#!/bin/sh\necho akua fixture\n");
      await chmod(source, 0o755);

      await packageExistingExecutables({ version: "1.2.3", outputDir: firstOutputDir, binaries });
      await Bun.sleep(2100);
      await packageExistingExecutables({ version: "1.2.3", outputDir: secondOutputDir, binaries });

      for (const name of releaseAssetNames("1.2.3")) {
        const [first, second] = await Promise.all([
          readFile(join(firstOutputDir, name)),
          readFile(join(secondOutputDir, name)),
        ]);
        if (!second.equals(first)) {
          throw new Error(`Repeated release packaging changed ${name}`);
        }
      }
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
    const root = await makeReleaseTempDir();

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

  test("rejects release output directories that could erase the checkout or filesystem root", async () => {
    const release = await import("../scripts/release") as Record<string, unknown>;
    const assertSafeOutputDirectory = release.assertSafeOutputDirectory as (outputDir: string) => Promise<void>;

    await expect(assertSafeOutputDirectory(process.cwd())).rejects.toThrow("Unsafe release output directory");
    await expect(assertSafeOutputDirectory(parse(process.cwd()).root))
      .rejects.toThrow("Unsafe release output directory");
    await expect(assertSafeOutputDirectory(join(process.cwd(), "src")))
      .rejects.toThrow("Unsafe release output directory");
    await expect(assertSafeOutputDirectory(join(process.cwd(), "docs")))
      .rejects.toThrow("Unsafe release output directory");
    await expect(assertSafeOutputDirectory(join(process.cwd(), "dist", "js")))
      .rejects.toThrow("Unsafe release output directory");
    await expect(assertSafeOutputDirectory(join(process.cwd(), "dist", "release")))
      .resolves.toBeUndefined();
  });

  test("rejects release output paths beneath a symlinked ancestor", async () => {
    const release = await import("../scripts/release") as Record<string, unknown>;
    const assertSafeOutputDirectory = release.assertSafeOutputDirectory as (outputDir: string) => Promise<void>;
    const root = await makeReleaseTempDir();
    const target = await mkdtemp(join(process.cwd(), ".tmp-akua-release-target-"));
    const linkedDirectory = join(root, "linked-output");

    try {
      await symlink(target, linkedDirectory, "dir");
      await expect(assertSafeOutputDirectory(join(linkedDirectory, "release")))
        .rejects.toThrow("symlink");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  test("verification rejects a Homebrew manifest that does not match verified assets", async () => {
    const release = await import("../scripts/release") as Record<string, unknown>;
    const targets = release.RELEASE_TARGETS as Array<{ id: string }>;
    const packageExistingExecutables = release.packageExistingExecutables as (input: {
      version: string;
      outputDir: string;
      binaries: Record<string, string>;
    }) => Promise<void>;
    const verifyReleaseDirectory = release.verifyReleaseDirectory as (outputDir: string, version: string) => Promise<void>;
    const root = await makeReleaseTempDir();

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
      const manifestPath = join(outputDir, "akua-v1.2.3-homebrew.json");
      const homebrew = JSON.parse(await readFile(manifestPath, "utf8"));
      homebrew.platforms.linux_intel.sha256 = "0".repeat(64);
      await writeFile(manifestPath, `${JSON.stringify(homebrew, null, 2)}\n`);

      await expect(verifyReleaseDirectory(outputDir, "1.2.3")).rejects.toThrow("Homebrew manifest mismatch");
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

  test("extracts Windows zip archives with native PowerShell", async () => {
    const release = await import("../scripts/release") as Record<string, unknown>;
    const archiveExtractCommand = release.archiveExtractCommand as (
      archive: "tar.gz" | "zip",
      archivePath: string,
      installRoot: string,
      platform: NodeJS.Platform,
    ) => string[];

    expect(archiveExtractCommand("zip", "D:\\a\\Robin's build\\akua.zip", "C:\\install dir", "win32")).toEqual([
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive -LiteralPath 'D:\\a\\Robin''s build\\akua.zip' -DestinationPath 'C:\\install dir'",
    ]);
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
    const root = await makeReleaseTempDir();

    try {
      const source = join(root, "akua-fixture");
      const outputDir = join(root, "release");
      await writeFile(
        source,
        "#!/bin/sh\ncase \"$1\" in\n  --version) echo '{\"status\":\"ok\",\"data\":{\"version\":\"1.2.3\"}}' ;;\n  --help) echo 'Usage: akua' ;;\n  commands) echo 'commands[1]' ;;\n  *) exit 2 ;;\nesac\n",
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

  test("rejects an install-smoke executable whose longer version contains the expected version", async () => {
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
    const root = await makeReleaseTempDir();

    try {
      const source = join(root, "akua-fixture");
      const outputDir = join(root, "release");
      await writeFile(
        source,
        "#!/bin/sh\ncase \"$1\" in\n  --version) echo '{\"status\":\"ok\",\"data\":{\"version\":\"11.2.3\"}}' ;;\n  --help) echo 'Usage: akua' ;;\n  commands) echo 'commands[1]' ;;\n  *) exit 2 ;;\nesac\n",
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
      })).rejects.toThrow("unexpected version");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
