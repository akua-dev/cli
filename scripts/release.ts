import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type ReleaseTargetId = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64" | "windows-x64";

export interface ReleaseTarget {
  id: ReleaseTargetId;
  bunTarget: string;
  os: "darwin" | "linux" | "windows";
  arch: "arm64" | "x64";
  archive: "tar.gz" | "zip";
  executable: "akua" | "akua.exe";
  runner: string;
  homebrew?: {
    os: "macos" | "linux";
    arch: "arm" | "intel";
  };
}

export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
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
] as const;

export function releaseMatrix(): { include: Array<{ target: ReleaseTargetId; runner: string }> } {
  return {
    include: RELEASE_TARGETS.map((target) => ({ target: target.id, runner: target.runner })),
  };
}

export function artifactName(version: string, target: Pick<ReleaseTarget, "id" | "archive">): string {
  return `akua-v${version}-${target.id}.${target.archive}`;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function checksumLine(name: string, digest: string): string {
  return `${digest}  ${name}\n`;
}

export interface ReleaseAsset {
  target: ReleaseTargetId;
  bun_target: string;
  os: ReleaseTarget["os"];
  arch: ReleaseTarget["arch"];
  archive: ReleaseTarget["archive"];
  executable: ReleaseTarget["executable"];
  file: string;
  checksum_file: string;
  sha256: string;
  size: number;
}

export interface ReleaseManifest {
  schema_version: 1;
  executable: "akua";
  version: string;
  checksums: "checksums.txt";
  homebrew_manifest: string;
  assets: ReleaseAsset[];
}

interface PackageExistingExecutablesInput {
  version: string;
  outputDir: string;
  binaries: Record<string, string>;
}

interface PackageReleaseInput {
  version: string;
  outputDir: string;
  entrypoint?: string;
}

const RELEASE_REPOSITORY = "akua-dev/cli";

export function validateVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
}

export function releaseManifestName(version: string): string {
  validateVersion(version);
  return `akua-v${version}-manifest.json`;
}

export function homebrewManifestName(version: string): string {
  validateVersion(version);
  return `akua-v${version}-homebrew.json`;
}

export function releaseAssetNames(version: string): string[] {
  validateVersion(version);
  const archives = RELEASE_TARGETS.map((target) => artifactName(version, target));
  return [
    ...archives,
    ...archives.map((archive) => `${archive}.sha256`),
    "checksums.txt",
    releaseManifestName(version),
    homebrewManifestName(version),
  ];
}

export async function assertSafeOutputDirectory(outputDirInput: string): Promise<void> {
  const outputDir = resolve(outputDirInput);
  const workspace = resolve(process.cwd());
  const releaseOutputRoot = join(workspace, "dist", "release");
  const releaseRelativePath = relative(releaseOutputRoot, outputDir);
  if (
    releaseRelativePath === ".." ||
    releaseRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(releaseRelativePath)
  ) {
    throw new Error(`Unsafe release output directory: ${outputDir}`);
  }

  let currentPath = workspace;
  for (const segment of relative(workspace, outputDir).split(sep)) {
    currentPath = join(currentPath, segment);
    try {
      if ((await lstat(currentPath)).isSymbolicLink()) {
        throw new Error(`Unsafe release output directory contains a symlink: ${currentPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        break;
      }
      throw error;
    }
  }
}

export async function packageExistingExecutables(input: PackageExistingExecutablesInput): Promise<void> {
  validateVersion(input.version);
  const outputDir = resolve(input.outputDir);
  await assertSafeOutputDirectory(outputDir);
  const stagingRoot = join(outputDir, ".staging");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  const assets: ReleaseAsset[] = [];
  try {
    for (const target of RELEASE_TARGETS) {
      const source = input.binaries[target.id];
      if (!source) {
        throw new Error(`Missing compiled executable for ${target.id}`);
      }

      const stagingDir = join(stagingRoot, target.id);
      const stagedExecutable = join(stagingDir, target.executable);
      const archive = artifactName(input.version, target);
      const archivePath = join(outputDir, archive);
      await mkdir(stagingDir, { recursive: true });
      await copyFile(source, stagedExecutable);
      if (target.os !== "windows") {
        await chmod(stagedExecutable, 0o755);
      }

      if (target.archive === "tar.gz") {
        await run(["tar", "-czf", archivePath, "-C", stagingDir, target.executable]);
      } else {
        await run(["zip", "-q", "-j", archivePath, stagedExecutable]);
      }

      const bytes = new Uint8Array(await readFile(archivePath));
      const digest = sha256(bytes);
      const checksumFile = `${archive}.sha256`;
      await writeFile(join(outputDir, checksumFile), checksumLine(archive, digest));
      assets.push({
        target: target.id,
        bun_target: target.bunTarget,
        os: target.os,
        arch: target.arch,
        archive: target.archive,
        executable: target.executable,
        file: archive,
        checksum_file: checksumFile,
        sha256: digest,
        size: bytes.byteLength,
      });
    }

    const manifest: ReleaseManifest = {
      schema_version: 1,
      executable: "akua",
      version: input.version,
      checksums: "checksums.txt",
      homebrew_manifest: homebrewManifestName(input.version),
      assets,
    };
    await writeFile(join(outputDir, "checksums.txt"), assets.map((asset) => checksumLine(asset.file, asset.sha256)).join(""));
    await writeFile(join(outputDir, releaseManifestName(input.version)), stableJson(manifest));
    await writeFile(join(outputDir, homebrewManifestName(input.version)), stableJson(createHomebrewManifest(input.version, assets)));
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  await verifyReleaseDirectory(outputDir, input.version);
}

export async function packageRelease(input: PackageReleaseInput): Promise<void> {
  validateVersion(input.version);
  const binaryRoot = await mkdtemp(join(tmpdir(), "akua-release-build-"));
  const binaries: Record<string, string> = {};
  try {
    for (const target of RELEASE_TARGETS) {
      const binaryPath = join(binaryRoot, target.id, target.executable);
      await mkdir(join(binaryRoot, target.id), { recursive: true });
      await run([
        "bun",
        "build",
        input.entrypoint ?? "src/bin/akua.ts",
        "--compile",
        `--target=${target.bunTarget}`,
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        `--outfile=${binaryPath}`,
      ]);
      binaries[target.id] = binaryPath;
    }
    await packageExistingExecutables({ version: input.version, outputDir: input.outputDir, binaries });
  } finally {
    await rm(binaryRoot, { recursive: true, force: true });
  }
}

export function hostTargetId(platform = process.platform, arch = process.arch): ReleaseTargetId {
  const normalizedPlatform = platform === "win32" ? "windows" : platform;
  const id = `${normalizedPlatform}-${arch}`;
  const target = RELEASE_TARGETS.find((candidate) => candidate.id === id);
  if (!target) {
    throw new Error(`Unsupported release host: ${platform}-${arch}`);
  }
  return target.id;
}

export async function smokeReleaseArtifact(input: {
  version: string;
  outputDir: string;
  targetId: string;
}): Promise<void> {
  validateVersion(input.version);
  const target = RELEASE_TARGETS.find((candidate) => candidate.id === input.targetId);
  if (!target) {
    throw new Error(`Unknown release target: ${input.targetId}`);
  }
  const installRoot = await mkdtemp(join(tmpdir(), "akua-release-smoke-"));
  try {
    const archivePath = resolve(input.outputDir, artifactName(input.version, target));
    if (target.archive === "zip" && process.platform !== "win32") {
      await run(["unzip", "-q", archivePath, "-d", installRoot]);
    } else {
      await run(["tar", "-xf", archivePath, "-C", installRoot]);
    }
    const executable = join(installRoot, target.executable);
    if (target.os !== "windows") {
      await chmod(executable, 0o755);
    }

    const versionOutput = await run([executable, "--version"], { AKUA_OUTPUT: "agent" });
    if (!versionOutput.includes(input.version)) {
      throw new Error(`Installed ${target.id} executable reported an unexpected version: ${versionOutput.trim()}`);
    }
    const helpOutput = await run([executable, "--help"], { AKUA_OUTPUT: "agent" });
    if (helpOutput.trim() === "") {
      throw new Error(`Installed ${target.id} executable returned empty help output`);
    }
    const commandsOutput = await run([executable, "commands", "--limit", "1"], { AKUA_OUTPUT: "agent" });
    if (commandsOutput.trim() === "") {
      throw new Error(`Installed ${target.id} executable returned empty command output`);
    }
  } finally {
    await rm(installRoot, { recursive: true, force: true });
  }
}

export async function verifyReleaseDirectory(outputDirInput: string, version: string): Promise<void> {
  validateVersion(version);
  const outputDir = resolve(outputDirInput);
  const manifest = JSON.parse(await readFile(join(outputDir, releaseManifestName(version)), "utf8")) as ReleaseManifest;
  if (
    manifest.schema_version !== 1 ||
    manifest.version !== version ||
    manifest.executable !== "akua" ||
    manifest.checksums !== "checksums.txt" ||
    manifest.homebrew_manifest !== homebrewManifestName(version) ||
    manifest.assets.length !== RELEASE_TARGETS.length
  ) {
    throw new Error("Release manifest does not match the requested release contract");
  }

  const aggregateLines: string[] = [];
  for (let index = 0; index < RELEASE_TARGETS.length; index += 1) {
    const target = RELEASE_TARGETS[index];
    const asset = manifest.assets[index];
    const expectedFile = artifactName(version, target);
    if (
      asset.target !== target.id ||
      asset.bun_target !== target.bunTarget ||
      asset.os !== target.os ||
      asset.arch !== target.arch ||
      asset.archive !== target.archive ||
      asset.file !== expectedFile ||
      asset.checksum_file !== `${expectedFile}.sha256` ||
      asset.executable !== target.executable
    ) {
      throw new Error(`Release manifest target mismatch for ${target.id}`);
    }

    const bytes = new Uint8Array(await readFile(join(outputDir, asset.file)));
    const digest = sha256(bytes);
    if (digest !== asset.sha256) {
      throw new Error(`Release asset checksum mismatch: ${asset.file}`);
    }
    const expectedLine = checksumLine(asset.file, digest);
    const adjacent = await readFile(join(outputDir, asset.checksum_file), "utf8");
    if (adjacent !== expectedLine) {
      throw new Error(`Release checksum file mismatch: ${asset.checksum_file}`);
    }
    if ((await stat(join(outputDir, asset.file))).size !== asset.size) {
      throw new Error(`Release asset size mismatch: ${asset.file}`);
    }
    aggregateLines.push(expectedLine);
    await verifyArchive(outputDir, target, asset.file);
  }

  const aggregate = await readFile(join(outputDir, manifest.checksums), "utf8");
  if (aggregate !== aggregateLines.join("")) {
    throw new Error("Aggregate checksum file mismatch");
  }

  const homebrewManifest = await readFile(join(outputDir, manifest.homebrew_manifest), "utf8");
  const expectedHomebrewManifest = stableJson(createHomebrewManifest(version, manifest.assets));
  if (homebrewManifest !== expectedHomebrewManifest) {
    throw new Error("Homebrew manifest mismatch");
  }

  const actualNames = (await readdir(outputDir)).sort();
  const expectedNames = releaseAssetNames(version).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`Unexpected release files: ${actualNames.join(", ")}`);
  }
}

function createHomebrewManifest(version: string, assets: readonly ReleaseAsset[]) {
  const platforms: Record<string, { artifact: string; url: string; sha256: string }> = {};
  for (const target of RELEASE_TARGETS) {
    if (!target.homebrew) {
      continue;
    }
    const asset = assets.find((candidate) => candidate.target === target.id);
    if (!asset) {
      throw new Error(`Missing Homebrew release asset for ${target.id}`);
    }
    const key = `${target.homebrew.os}_${target.homebrew.arch}`;
    platforms[key] = {
      artifact: asset.file,
      url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/${asset.file}`,
      sha256: asset.sha256,
    };
  }
  return {
    schema_version: 1,
    formula: "akua",
    version,
    release: `https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${version}`,
    platforms,
  };
}

async function verifyArchive(outputDir: string, target: ReleaseTarget, file: string): Promise<void> {
  const archivePath = join(outputDir, file);
  const listCommand = target.archive === "zip" ? ["unzip", "-Z1", archivePath] : ["tar", "-tzf", archivePath];
  const listed = (await run(listCommand)).trim().split("\n").filter(Boolean);
  if (listed.length !== 1 || listed[0] !== target.executable) {
    throw new Error(`Release archive ${file} must contain only ${target.executable}`);
  }

  if (target.os === "windows") {
    return;
  }
  const extractDir = await mkdtemp(join(tmpdir(), "akua-release-verify-"));
  try {
    await run(["tar", "-xzf", archivePath, "-C", extractDir]);
    const mode = (await stat(join(extractDir, target.executable))).mode & 0o777;
    if (mode !== 0o755) {
      throw new Error(`Release executable mode mismatch for ${target.id}: ${mode.toString(8)}`);
    }
  } finally {
    await rm(extractDir, { recursive: true, force: true });
  }
}

async function run(command: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn({ cmd: command, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...extraEnv } });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command[0]} failed (${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readCliFlags(argv: readonly string[]): { command: string; version: string; outputDir: string; targetId?: string } {
  const [command, ...flags] = argv;
  if (!command || !["matrix", "package", "verify", "smoke"].includes(command)) {
    throw new Error("Usage: bun scripts/release.ts <matrix|package|verify|smoke> --version <version> --output <directory> [--target <target>]");
  }
  if (command === "matrix") {
    if (flags.length !== 0) {
      throw new Error("The matrix command does not accept arguments");
    }
    return { command, version: "", outputDir: "" };
  }
  const values: Record<string, string> = {};
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid release argument near: ${flag ?? "<end>"}`);
    }
    values[flag.slice(2)] = value;
  }
  if (!values.version || !values.output) {
    throw new Error("Both --version and --output are required");
  }
  return { command, version: values.version, outputDir: values.output, targetId: values.target };
}

if (import.meta.main) {
  try {
    const input = readCliFlags(process.argv.slice(2));
    if (input.command === "matrix") {
      console.log(JSON.stringify(releaseMatrix()));
    } else if (input.command === "package") {
      await packageRelease({ version: input.version, outputDir: input.outputDir });
    } else if (input.command === "verify") {
      await verifyReleaseDirectory(input.outputDir, input.version);
    } else {
      await smokeReleaseArtifact({
        version: input.version,
        outputDir: input.outputDir,
        targetId: input.targetId ?? hostTargetId(),
      });
    }
    if (input.command !== "matrix") {
      console.error(`Release ${input.command} succeeded for v${input.version}.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
