import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Context, Effect, Layer } from "effect";

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
    runner: "akua-x64-ci-v2",
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
];

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

export interface PackageExistingExecutablesInput {
  version: string;
  outputDir: string;
  binaries: Record<string, string>;
}

export interface PackageReleaseInput {
  version: string;
  outputDir: string;
  entrypoint?: string;
}

const RELEASE_REPOSITORY = "akua-dev/cli";
const ARCHIVE_TIMESTAMP_SECONDS = 315532800;
const ARCHIVE_TIMESTAMP = new Date(ARCHIVE_TIMESTAMP_SECONDS * 1000);

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

function planReleaseUploadsSync(
  candidateDirInput: string,
  existingDirInput: string,
  version: string,
): string[] {
  const candidateDir = resolve(candidateDirInput);
  const existingDir = resolve(existingDirInput);
  const expectedNames = releaseAssetNames(version);
  const candidateNames = readdirSync(candidateDir).sort();
  if (JSON.stringify(candidateNames) !== JSON.stringify([...expectedNames].sort())) throw new Error(`Unexpected release files: ${candidateNames.join(", ")}`);
  const existingNames = readdirSync(existingDir);
  const expectedNameSet = new Set(expectedNames);
  for (const name of existingNames) {
    if (!expectedNameSet.has(name)) throw new Error(`Unexpected existing release asset: ${name}`);
    if (!readFileSync(join(candidateDir, name)).equals(readFileSync(join(existingDir, name)))) throw new Error(`Existing release asset does not match candidate: ${name}`);
  }
  const existingNameSet = new Set(existingNames);
  return expectedNames.filter((name) => !existingNameSet.has(name)).map((name) => join(candidateDir, name));
}

function assertSafeOutputDirectorySync(outputDirInput: string): void {
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
      if ((lstatSync(currentPath)).isSymbolicLink()) {
        throw new Error(`Unsafe release output directory contains a symlink: ${currentPath}`);
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        break;
      }
      throw error;
    }
  }
}

function packageExistingExecutablesSync(input: PackageExistingExecutablesInput): void {
  validateVersion(input.version);
  const outputDir = resolve(input.outputDir);
  assertSafeOutputDirectorySync(outputDir);
  const stagingRoot = join(outputDir, ".staging");
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });

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
      mkdirSync(stagingDir, { recursive: true });
      // copyFile can use an in-kernel copy optimization across filesystems. In
      // a Kata guest, copying from its root filesystem into the virtiofs-backed
      // Actions work volume produced correctly sized but zero-filled binaries.
      // Materialize and verify the bytes so release archives cannot silently
      // contain corrupted executables.
      const sourceBytes = readFileSync(source);
      writeFileSync(stagedExecutable, sourceBytes);
      const stagedBytes = readFileSync(stagedExecutable);
      if (!stagedBytes.equals(sourceBytes)) {
        throw new Error(`Staged executable does not match source for ${target.id}`);
      }
      chmodSync(stagedExecutable, target.os === "windows" ? 0o644 : 0o755);
      utimesSync(stagedExecutable, ARCHIVE_TIMESTAMP, ARCHIVE_TIMESTAMP);

      if (target.archive === "tar.gz") {
        const metadataArguments = process.platform === "linux"
          ? ["--owner=0", "--group=0", `--mtime=@${ARCHIVE_TIMESTAMP_SECONDS}`]
          : [
              "--uid",
              "0",
              "--gid",
              "0",
              "--uname",
              "root",
              "--gname",
              "root",
              "--options",
              "gzip:!timestamp",
            ];
        runSync([
          "tar",
          "--format=ustar",
          ...metadataArguments,
          "-czf",
          archivePath,
          "-C",
          stagingDir,
          target.executable,
        ], { COPYFILE_DISABLE: "1" });
      } else {
        runSync(["zip", "-X", "-q", "-j", archivePath, stagedExecutable], {
          COPYFILE_DISABLE: "1",
          TZ: "UTC",
        });
      }

      const bytes = new Uint8Array(readFileSync(archivePath));
      const digest = sha256(bytes);
      const checksumFile = `${archive}.sha256`;
      writeFileSync(join(outputDir, checksumFile), checksumLine(archive, digest));
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
    writeFileSync(join(outputDir, "checksums.txt"), assets.map((asset) => checksumLine(asset.file, asset.sha256)).join(""));
    writeFileSync(join(outputDir, releaseManifestName(input.version)), stableJson(manifest));
    writeFileSync(join(outputDir, homebrewManifestName(input.version)), stableJson(createHomebrewManifest(input.version, assets)));
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }

  verifyReleaseDirectorySync(outputDir, input.version);
}

function packageReleaseSync(input: PackageReleaseInput): void {
  validateVersion(input.version);
  // Bun's compiled output is memory-mapped. Under Kata, output created on the
  // guest-local /tmp filesystem was observed as correctly sized but entirely
  // sparse/zero-filled. Keep compilation on the Actions workspace's virtiofs
  // volume, then validate the native executable header before packaging it.
  const binaryBuildParent = join(process.cwd(), "dist");
  mkdirSync(binaryBuildParent, { recursive: true });
  const binaryRoot = mkdtempSync(join(binaryBuildParent, ".tmp-akua-release-build-"));
  const binaries: Record<string, string> = {};
  try {
    for (const target of RELEASE_TARGETS) {
      const binaryPath = join(binaryRoot, target.id, target.executable);
      mkdirSync(join(binaryRoot, target.id), { recursive: true });
      runSync([
        "bun",
        "build",
        input.entrypoint ?? "src/bin/akua.ts",
        "--compile",
        `--target=${target.bunTarget}`,
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        `--outfile=${binaryPath}`,
      ]);
      assertCompiledExecutable(target, readFileSync(binaryPath));
      binaries[target.id] = binaryPath;
    }
    packageExistingExecutablesSync({ version: input.version, outputDir: input.outputDir, binaries });
  } finally {
    rmSync(binaryRoot, { recursive: true, force: true });
  }
}

export function assertCompiledExecutable(target: Pick<ReleaseTarget, "id" | "os">, bytes: Uint8Array): void {
  const expectedMagic = target.os === "darwin"
    ? [0xcf, 0xfa, 0xed, 0xfe]
    : target.os === "linux"
      ? [0x7f, 0x45, 0x4c, 0x46]
      : [0x4d, 0x5a];
  if (bytes.length < expectedMagic.length || expectedMagic.some((byte, index) => bytes[index] !== byte)) {
    throw new Error(`Compiled executable has an invalid ${target.os} header for ${target.id}`);
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

export function archiveExtractCommand(
  archive: ReleaseTarget["archive"],
  archivePath: string,
  installRoot: string,
  platform = process.platform,
): string[] {
  if (archive === "zip") {
    if (platform === "win32") {
      const archiveLiteral = `'${archivePath.replaceAll("'", "''")}'`;
      const installRootLiteral = `'${installRoot.replaceAll("'", "''")}'`;
      return [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath ${archiveLiteral} -DestinationPath ${installRootLiteral}`,
      ];
    }
    return ["unzip", "-q", archivePath, "-d", installRoot];
  }
  return ["tar", "-xf", archivePath, "-C", installRoot];
}

function smokeReleaseArtifactSync(input: {
  version: string;
  outputDir: string;
  targetId: string;
}): void {
  validateVersion(input.version);
  const target = RELEASE_TARGETS.find((candidate) => candidate.id === input.targetId);
  if (!target) {
    throw new Error(`Unknown release target: ${input.targetId}`);
  }
  const installRoot = mkdtempSync(join(tmpdir(), "akua-release-smoke-"));
  try {
    const archivePath = resolve(input.outputDir, artifactName(input.version, target));
    runSync(archiveExtractCommand(target.archive, archivePath, installRoot));
    const executable = join(installRoot, target.executable);
    if (target.os !== "windows") {
      chmodSync(executable, 0o755);
    }

    const versionOutput = runSync([executable, "--version", "--json"]);
    let reportedVersion: unknown;
    try {
      reportedVersion = versionFromPayload(JSON.parse(versionOutput));
    } catch {
      reportedVersion = undefined;
    }
    if (reportedVersion !== input.version) {
      throw new Error(`Installed ${target.id} executable reported an unexpected version: ${versionOutput.trim()}`);
    }
    const helpOutput = runSync([executable, "--help"], { AKUA_OUTPUT: "agent" });
    if (helpOutput.trim() === "") {
      throw new Error(`Installed ${target.id} executable returned empty help output`);
    }
    const commandsOutput = runSync([executable, "commands", "--limit", "1"], { AKUA_OUTPUT: "agent" });
    if (commandsOutput.trim() === "") {
      throw new Error(`Installed ${target.id} executable returned empty command output`);
    }
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
}

function verifyReleaseDirectorySync(outputDirInput: string, version: string): void {
  validateVersion(version);
  const outputDir = resolve(outputDirInput);
  const manifest = parseReleaseManifest(
    JSON.parse(readFileSync(join(outputDir, releaseManifestName(version)), "utf8")),
  );
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

    const bytes = new Uint8Array(readFileSync(join(outputDir, asset.file)));
    const digest = sha256(bytes);
    if (digest !== asset.sha256) {
      throw new Error(`Release asset checksum mismatch: ${asset.file}`);
    }
    const expectedLine = checksumLine(asset.file, digest);
    const adjacent = readFileSync(join(outputDir, asset.checksum_file), "utf8");
    if (adjacent !== expectedLine) {
      throw new Error(`Release checksum file mismatch: ${asset.checksum_file}`);
    }
    if ((statSync(join(outputDir, asset.file))).size !== asset.size) {
      throw new Error(`Release asset size mismatch: ${asset.file}`);
    }
    aggregateLines.push(expectedLine);
    verifyArchiveSync(outputDir, target, asset.file);
  }

  const aggregate = readFileSync(join(outputDir, manifest.checksums), "utf8");
  if (aggregate !== aggregateLines.join("")) {
    throw new Error("Aggregate checksum file mismatch");
  }

  const homebrewManifest = readFileSync(join(outputDir, manifest.homebrew_manifest), "utf8");
  const expectedHomebrewManifest = stableJson(createHomebrewManifest(version, manifest.assets));
  if (homebrewManifest !== expectedHomebrewManifest) {
    throw new Error("Homebrew manifest mismatch");
  }

  const actualNames = (readdirSync(outputDir)).sort();
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

function verifyArchiveSync(outputDir: string, target: ReleaseTarget, file: string): void {
  const archivePath = join(outputDir, file);
  const listCommand = target.archive === "zip" ? ["unzip", "-Z1", archivePath] : ["tar", "-tzf", archivePath];
  const listed = (runSync(listCommand)).trim().split("\n").filter(Boolean);
  if (listed.length !== 1 || listed[0] !== target.executable) {
    throw new Error(`Release archive ${file} must contain only ${target.executable}`);
  }

  if (target.os === "windows") {
    return;
  }
  const extractDir = mkdtempSync(join(tmpdir(), "akua-release-verify-"));
  try {
    runSync(["tar", "-xzf", archivePath, "-C", extractDir]);
    const mode = (statSync(join(extractDir, target.executable))).mode & 0o777;
    if (mode !== 0o755) {
      throw new Error(`Release executable mode mismatch for ${target.id}: ${mode.toString(8)}`);
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

function runSync(command: string[], extraEnv: Record<string, string> = {}): string {
  const proc = Bun.spawnSync({ cmd: command, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...extraEnv } });
  const decoder = new TextDecoder();
  const stdout = decoder.decode(proc.stdout);
  const stderr = decoder.decode(proc.stderr);
  const exitCode = proc.exitCode;
  if (exitCode !== 0) {
    throw new Error(`${command[0]} failed (${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function versionFromPayload(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.data)) return undefined;
  return value.data.version;
}

function parseReleaseManifest(value: unknown): ReleaseManifest {
  if (!isRecord(value) || !Array.isArray(value.assets)) {
    throw new Error("Release manifest is invalid");
  }
  if (
    value.schema_version !== 1 ||
    value.executable !== "akua" ||
    typeof value.version !== "string" ||
    value.checksums !== "checksums.txt" ||
    typeof value.homebrew_manifest !== "string"
  ) {
    throw new Error("Release manifest is invalid");
  }
  const assets = value.assets.map(parseReleaseAsset);
  return {
    schema_version: 1,
    executable: "akua",
    version: value.version,
    checksums: "checksums.txt",
    homebrew_manifest: value.homebrew_manifest,
    assets,
  };
}

function parseReleaseAsset(value: unknown): ReleaseAsset {
  if (!isRecord(value)) throw new Error("Release manifest asset is invalid");
  const stringFields = [
    "target",
    "bun_target",
    "os",
    "arch",
    "archive",
    "executable",
    "file",
    "checksum_file",
    "sha256",
  ];
  if (stringFields.some((field) => typeof value[field] !== "string") || typeof value.size !== "number") {
    throw new Error("Release manifest asset is invalid");
  }
  const target = releaseTargetId(value.target);
  const os = releaseOs(value.os);
  const arch = releaseArch(value.arch);
  const archive = releaseArchive(value.archive);
  const executable = releaseExecutable(value.executable);
  return {
    target,
    bun_target: requiredString(value.bun_target),
    os,
    arch,
    archive,
    executable,
    file: requiredString(value.file),
    checksum_file: requiredString(value.checksum_file),
    sha256: requiredString(value.sha256),
    size: requiredNumber(value.size),
  };
}

function releaseTargetId(value: unknown): ReleaseTargetId {
  if (value === "darwin-arm64" || value === "darwin-x64" || value === "linux-arm64" || value === "linux-x64" || value === "windows-x64") return value;
  throw new Error("Release manifest asset is invalid");
}

function releaseOs(value: unknown): ReleaseTarget["os"] {
  if (value === "darwin" || value === "linux" || value === "windows") return value;
  throw new Error("Release manifest asset is invalid");
}

function releaseArch(value: unknown): ReleaseTarget["arch"] {
  if (value === "arm64" || value === "x64") return value;
  throw new Error("Release manifest asset is invalid");
}

function releaseArchive(value: unknown): ReleaseTarget["archive"] {
  if (value === "tar.gz" || value === "zip") return value;
  throw new Error("Release manifest asset is invalid");
}

function releaseExecutable(value: unknown): ReleaseTarget["executable"] {
  if (value === "akua" || value === "akua.exe") return value;
  throw new Error("Release manifest asset is invalid");
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Release manifest asset is invalid");
  return value;
}

function requiredNumber(value: unknown): number {
  if (typeof value !== "number") throw new Error("Release manifest asset is invalid");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function planReleaseUploads(candidateDir: string, existingDir: string, version: string): Effect.Effect<string[], Error> {
  return Effect.try({ try: () => planReleaseUploadsSync(candidateDir, existingDir, version), catch: toError });
}

function assertSafeOutputDirectory(outputDir: string): Effect.Effect<void, Error> {
  return Effect.try({ try: () => assertSafeOutputDirectorySync(outputDir), catch: toError });
}

function packageExistingExecutables(input: PackageExistingExecutablesInput): Effect.Effect<void, Error> {
  return Effect.try({ try: () => packageExistingExecutablesSync(input), catch: toError });
}

function packageRelease(input: PackageReleaseInput): Effect.Effect<void, Error> {
  return Effect.try({ try: () => packageReleaseSync(input), catch: toError });
}

function smokeReleaseArtifact(input: { version: string; outputDir: string; targetId: string }): Effect.Effect<void, Error> {
  return Effect.try({ try: () => smokeReleaseArtifactSync(input), catch: toError });
}

function verifyReleaseDirectory(outputDir: string, version: string): Effect.Effect<void, Error> {
  return Effect.try({ try: () => verifyReleaseDirectorySync(outputDir, version), catch: toError });
}

export class ReleaseHost extends Context.Service<ReleaseHost, {
  readonly planUploads: (candidateDir: string, existingDir: string, version: string) => Effect.Effect<string[], Error>;
  readonly assertSafeOutputDirectory: (outputDir: string) => Effect.Effect<void, Error>;
  readonly packageExistingExecutables: (input: PackageExistingExecutablesInput) => Effect.Effect<void, Error>;
  readonly packageRelease: (input: PackageReleaseInput) => Effect.Effect<void, Error>;
  readonly smokeReleaseArtifact: (input: { version: string; outputDir: string; targetId: string }) => Effect.Effect<void, Error>;
  readonly verifyReleaseDirectory: (outputDir: string, version: string) => Effect.Effect<void, Error>;
}>()("platform/scripts/ReleaseHost") {}

export const ReleaseHostLive = Layer.succeed(ReleaseHost, {
  planUploads: planReleaseUploads,
  assertSafeOutputDirectory,
  packageExistingExecutables,
  packageRelease,
  smokeReleaseArtifact,
  verifyReleaseDirectory,
});
