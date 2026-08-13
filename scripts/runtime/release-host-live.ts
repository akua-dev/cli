import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Effect, Layer } from "effect";

import {
  RELEASE_TARGETS,
  ReleaseHost,
  ReleaseFailure,
  archiveExtractCommand,
  artifactName,
  assertCompiledExecutable,
  checksumLine,
  homebrewManifestName,
  releaseAssetNames,
  releaseFailure,
  releaseManifestName,
  releaseTargetIdForHost,
  validateVersion,
} from "./release-services";
import type {
  PackageExistingExecutablesInput,
  PackageReleaseInput,
  ReleaseAsset,
  ReleaseManifest,
  ReleaseTarget,
} from "./release-services";

const RELEASE_REPOSITORY = "akua-dev/cli";
const ARCHIVE_TIMESTAMP_SECONDS = 315532800;
const ARCHIVE_TIMESTAMP = new Date(ARCHIVE_TIMESTAMP_SECONDS * 1000);

function attempt<A>(
  operation: string,
  execute: () => A,
): Effect.Effect<A, ReleaseFailure> {
  return Effect.try({
    try: execute,
    catch: (cause) =>
      new ReleaseFailure({
        message: `Release host ${operation} failed`,
        cause,
      }),
  });
}

function check(
  condition: boolean,
  message: string,
): Effect.Effect<void, ReleaseFailure> {
  return condition ? Effect.void : releaseFailure(message);
}

function planReleaseUploads(
  candidateDirInput: string,
  existingDirInput: string,
  version: string,
): Effect.Effect<string[], ReleaseFailure> {
  return Effect.gen(function* () {
    const candidateDir = yield* attempt("resolve candidate directory", () =>
      resolve(candidateDirInput),
    );
    const existingDir = yield* attempt("resolve existing directory", () =>
      resolve(existingDirInput),
    );
    const expectedNames = yield* releaseAssetNames(version);
    const candidateNames = yield* attempt("read candidate directory", () =>
      readdirSync(candidateDir).sort(),
    );
    yield* check(
      JSON.stringify(candidateNames) ===
        JSON.stringify([...expectedNames].sort()),
      `Unexpected release files: ${candidateNames.join(", ")}`,
    );
    const existingNames = yield* attempt("read existing directory", () =>
      readdirSync(existingDir),
    );
    const expectedNameSet = new Set(expectedNames);
    for (const name of existingNames) {
      yield* check(
        expectedNameSet.has(name),
        `Unexpected existing release asset: ${name}`,
      );
      const candidate = yield* attempt("read candidate asset", () =>
        readFileSync(join(candidateDir, name)),
      );
      const existing = yield* attempt("read existing asset", () =>
        readFileSync(join(existingDir, name)),
      );
      yield* check(
        candidate.equals(existing),
        `Existing release asset does not match candidate: ${name}`,
      );
    }
    const existingNameSet = new Set(existingNames);
    return expectedNames
      .filter((name) => !existingNameSet.has(name))
      .map((name) => join(candidateDir, name));
  });
}

function assertSafeOutputDirectory(
  outputDirInput: string,
): Effect.Effect<void, ReleaseFailure> {
  return Effect.gen(function* () {
    const outputDir = yield* attempt("resolve output directory", () =>
      resolve(outputDirInput),
    );
    const workspace = yield* attempt("read workspace directory", () =>
      resolve(process.cwd()),
    );
    const releaseOutputRoot = join(workspace, "dist", "release");
    const releaseRelativePath = relative(releaseOutputRoot, outputDir);
    yield* check(
      !(
        releaseRelativePath === ".." ||
        releaseRelativePath.startsWith(
          `..${process.platform === "win32" ? "\\" : "/"}`,
        ) ||
        isAbsolute(releaseRelativePath)
      ),
      `Unsafe release output directory: ${outputDir}`,
    );

    let currentPath = workspace;
    const segments = relative(workspace, outputDir).split(sep);
    for (const segment of segments) {
      currentPath = join(currentPath, segment);
      const stats = yield* lstatIfPresent(currentPath);
      if (stats !== undefined) {
        yield* check(
          !stats.isSymbolicLink(),
          `Unsafe release output directory contains a symlink: ${currentPath}`,
        );
      }
    }
  });
}

function lstatIfPresent(
  path: string,
): Effect.Effect<ReturnType<typeof lstatSync> | undefined, ReleaseFailure> {
  return attempt("inspect output directory", () => lstatSync(path)).pipe(
    Effect.map((stats) => stats),
    Effect.catch((failure) =>
      isNotFoundError(failure.cause)
        ? Effect.succeed(undefined)
        : Effect.fail(failure),
    ),
  );
}

function packageExistingExecutables(
  input: PackageExistingExecutablesInput,
): Effect.Effect<void, ReleaseFailure> {
  return Effect.gen(function* () {
    yield* validateVersion(input.version);
    const outputDir = yield* attempt("resolve output directory", () =>
      resolve(input.outputDir),
    );
    yield* assertSafeOutputDirectory(outputDir);
    const stagingRoot = join(outputDir, ".staging");
    yield* attempt("clear release output", () =>
      rmSync(outputDir, { recursive: true, force: true }),
    );
    yield* attempt("create staging directory", () =>
      mkdirSync(stagingRoot, { recursive: true }),
    );

    const assets: ReleaseAsset[] = [];
    const packageAssets = Effect.gen(function* () {
      for (const target of RELEASE_TARGETS) {
        const source = input.binaries[target.id];
        if (!source) {
          return yield* releaseFailure(
            `Missing compiled executable for ${target.id}`,
          );
        }
        const stagingDir = join(stagingRoot, target.id);
        const stagedExecutable = join(stagingDir, target.executable);
        const archive = artifactName(input.version, target);
        const archivePath = join(outputDir, archive);
        yield* attempt("create target staging directory", () =>
          mkdirSync(stagingDir, { recursive: true }),
        );
        const sourceBytes = yield* attempt("read compiled executable", () =>
          readFileSync(source),
        );
        yield* attempt("stage compiled executable", () =>
          writeFileSync(stagedExecutable, sourceBytes),
        );
        const stagedBytes = yield* attempt("verify staged executable", () =>
          readFileSync(stagedExecutable),
        );
        yield* check(
          stagedBytes.equals(sourceBytes),
          `Staged executable does not match source for ${target.id}`,
        );
        yield* attempt("set staged executable mode", () =>
          chmodSync(stagedExecutable, target.os === "windows" ? 0o644 : 0o755),
        );
        yield* attempt("set staged executable timestamp", () =>
          utimesSync(stagedExecutable, ARCHIVE_TIMESTAMP, ARCHIVE_TIMESTAMP),
        );
        if (target.archive === "tar.gz") {
          const metadataArguments =
            process.platform === "linux"
              ? [
                  "--owner=0",
                  "--group=0",
                  `--mtime=@${ARCHIVE_TIMESTAMP_SECONDS}`,
                ]
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
          yield* runCommand(
            [
              "tar",
              "--format=ustar",
              ...metadataArguments,
              "-czf",
              archivePath,
              "-C",
              stagingDir,
              target.executable,
            ],
            { COPYFILE_DISABLE: "1" },
          );
        } else {
          yield* runCommand(
            ["zip", "-X", "-q", "-j", archivePath, stagedExecutable],
            { COPYFILE_DISABLE: "1", TZ: "UTC" },
          );
        }
        const bytes = new Uint8Array(
          yield* attempt("read packaged archive", () =>
            readFileSync(archivePath),
          ),
        );
        const digest = yield* sha256(bytes);
        const checksumFile = `${archive}.sha256`;
        yield* attempt("write archive checksum", () =>
          writeFileSync(
            join(outputDir, checksumFile),
            checksumLine(archive, digest),
          ),
        );
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
      const manifestName = yield* releaseManifestName(input.version);
      const homebrewName = yield* homebrewManifestName(input.version);
      const manifest: ReleaseManifest = {
        schema_version: 1,
        executable: "akua",
        version: input.version,
        checksums: "checksums.txt",
        homebrew_manifest: homebrewName,
        assets,
      };
      const homebrewManifest = yield* createHomebrewManifest(
        input.version,
        assets,
      );
      yield* attempt("write aggregate checksums", () =>
        writeFileSync(
          join(outputDir, "checksums.txt"),
          assets
            .map((asset) => checksumLine(asset.file, asset.sha256))
            .join(""),
        ),
      );
      yield* attempt("write release manifest", () =>
        writeFileSync(join(outputDir, manifestName), stableJson(manifest)),
      );
      yield* attempt("write Homebrew manifest", () =>
        writeFileSync(
          join(outputDir, homebrewName),
          stableJson(homebrewManifest),
        ),
      );
    });
    yield* packageAssets.pipe(
      Effect.ensuring(
        attempt("remove staging directory", () =>
          rmSync(stagingRoot, { recursive: true, force: true }),
        ).pipe(Effect.ignore),
      ),
    );
    yield* verifyReleaseDirectory(outputDir, input.version);
  });
}

function packageRelease(
  input: PackageReleaseInput,
): Effect.Effect<void, ReleaseFailure> {
  return Effect.gen(function* () {
    yield* validateVersion(input.version);
    const binaryBuildParent = yield* attempt(
      "resolve binary build directory",
      () => join(process.cwd(), "dist"),
    );
    yield* attempt("create binary build directory", () =>
      mkdirSync(binaryBuildParent, { recursive: true }),
    );
    const binaryRoot = yield* attempt(
      "create binary build staging directory",
      () => mkdtempSync(join(binaryBuildParent, ".tmp-akua-release-build-")),
    );
    const buildBinaries = Effect.gen(function* () {
      const binaries: Record<string, string> = {};
      for (const target of RELEASE_TARGETS) {
        const binaryPath = join(binaryRoot, target.id, target.executable);
        yield* attempt("create target binary directory", () =>
          mkdirSync(join(binaryRoot, target.id), { recursive: true }),
        );
        yield* runCommand([
          "bun",
          "build",
          input.entrypoint ?? "src/bin/akua.ts",
          "--compile",
          `--target=${target.bunTarget}`,
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          `--outfile=${binaryPath}`,
        ]);
        const bytes = yield* attempt("read compiled executable", () =>
          readFileSync(binaryPath),
        );
        yield* assertCompiledExecutable(target, bytes);
        binaries[target.id] = binaryPath;
      }
      yield* packageExistingExecutables({
        version: input.version,
        outputDir: input.outputDir,
        binaries,
      });
    });
    yield* buildBinaries.pipe(
      Effect.ensuring(
        attempt("remove binary build staging directory", () =>
          rmSync(binaryRoot, { recursive: true, force: true }),
        ).pipe(Effect.ignore),
      ),
    );
  });
}

function smokeReleaseArtifact(input: {
  version: string;
  outputDir: string;
  targetId: string;
}): Effect.Effect<void, ReleaseFailure> {
  return Effect.gen(function* () {
    yield* validateVersion(input.version);
    const target = RELEASE_TARGETS.find(
      (candidate) => candidate.id === input.targetId,
    );
    if (!target) {
      return yield* releaseFailure(`Unknown release target: ${input.targetId}`);
    }
    const installRoot = yield* attempt("create smoke directory", () =>
      mkdtempSync(join(tmpdir(), "akua-release-smoke-")),
    );
    const smoke = Effect.gen(function* () {
      const archivePath = yield* attempt("resolve smoke archive", () =>
        resolve(input.outputDir, artifactName(input.version, target)),
      );
      yield* runCommand(
        archiveExtractCommand(
          target.archive,
          archivePath,
          installRoot,
          process.platform,
        ),
      );
      const executable = join(installRoot, target.executable);
      if (target.os !== "windows") {
        yield* attempt("set smoke executable mode", () =>
          chmodSync(executable, 0o755),
        );
      }
      const versionOutput = yield* runCommand([
        executable,
        "--version",
        "--json",
      ]);
      const reportedVersion = yield* parseReportedVersion(versionOutput);
      yield* check(
        reportedVersion === input.version,
        `Installed ${target.id} executable reported an unexpected version: ${versionOutput.trim()}`,
      );
      const helpOutput = yield* runCommand([executable, "--help"], {
        AKUA_OUTPUT: "agent",
      });
      yield* check(
        helpOutput.trim() !== "",
        `Installed ${target.id} executable returned empty help output`,
      );
      const commandsOutput = yield* runCommand(
        [executable, "commands", "--limit", "1"],
        {
          AKUA_OUTPUT: "agent",
        },
      );
      yield* check(
        commandsOutput.trim() !== "",
        `Installed ${target.id} executable returned empty command output`,
      );
    });
    yield* smoke.pipe(
      Effect.ensuring(
        attempt("remove smoke directory", () =>
          rmSync(installRoot, { recursive: true, force: true }),
        ).pipe(Effect.ignore),
      ),
    );
  });
}

function parseReportedVersion(
  output: string,
): Effect.Effect<unknown, ReleaseFailure> {
  return attempt("parse executable version response", () =>
    JSON.parse(output),
  ).pipe(
    Effect.map(versionFromPayload),
    Effect.catch(() => Effect.succeed(undefined)),
  );
}

function verifyReleaseDirectory(
  outputDirInput: string,
  version: string,
): Effect.Effect<void, ReleaseFailure> {
  return Effect.gen(function* () {
    yield* validateVersion(version);
    const outputDir = yield* attempt("resolve release directory", () =>
      resolve(outputDirInput),
    );
    const manifestName = yield* releaseManifestName(version);
    const manifestContents = yield* attempt("read release manifest", () =>
      readFileSync(join(outputDir, manifestName), "utf8"),
    );
    const manifestJson = yield* attempt("parse release manifest", () =>
      JSON.parse(manifestContents),
    );
    const manifest = yield* parseReleaseManifest(manifestJson);
    const homebrewName = yield* homebrewManifestName(version);
    yield* check(
      manifest.schema_version === 1 &&
        manifest.version === version &&
        manifest.executable === "akua" &&
        manifest.checksums === "checksums.txt" &&
        manifest.homebrew_manifest === homebrewName &&
        manifest.assets.length === RELEASE_TARGETS.length,
      "Release manifest does not match the requested release contract",
    );
    const aggregateLines: string[] = [];
    for (let index = 0; index < RELEASE_TARGETS.length; index += 1) {
      const target = RELEASE_TARGETS[index];
      const asset = manifest.assets[index];
      const expectedFile = artifactName(version, target);
      yield* check(
        asset.target === target.id &&
          asset.bun_target === target.bunTarget &&
          asset.os === target.os &&
          asset.arch === target.arch &&
          asset.archive === target.archive &&
          asset.file === expectedFile &&
          asset.checksum_file === `${expectedFile}.sha256` &&
          asset.executable === target.executable,
        `Release manifest target mismatch for ${target.id}`,
      );
      const bytes = new Uint8Array(
        yield* attempt("read release archive", () =>
          readFileSync(join(outputDir, asset.file)),
        ),
      );
      const digest = yield* sha256(bytes);
      yield* check(
        digest === asset.sha256,
        `Release asset checksum mismatch: ${asset.file}`,
      );
      const expectedLine = checksumLine(asset.file, digest);
      const adjacent = yield* attempt("read release checksum", () =>
        readFileSync(join(outputDir, asset.checksum_file), "utf8"),
      );
      yield* check(
        adjacent === expectedLine,
        `Release checksum file mismatch: ${asset.checksum_file}`,
      );
      const size = yield* attempt(
        "read release archive metadata",
        () => statSync(join(outputDir, asset.file)).size,
      );
      yield* check(
        size === asset.size,
        `Release asset size mismatch: ${asset.file}`,
      );
      aggregateLines.push(expectedLine);
      yield* verifyArchive(outputDir, target, asset.file);
    }
    const aggregate = yield* attempt("read aggregate checksums", () =>
      readFileSync(join(outputDir, manifest.checksums), "utf8"),
    );
    yield* check(
      aggregate === aggregateLines.join(""),
      "Aggregate checksum file mismatch",
    );
    const homebrewManifest = yield* attempt("read Homebrew manifest", () =>
      readFileSync(join(outputDir, manifest.homebrew_manifest), "utf8"),
    );
    const expectedHomebrewManifest = stableJson(
      yield* createHomebrewManifest(version, manifest.assets),
    );
    yield* check(
      homebrewManifest === expectedHomebrewManifest,
      "Homebrew manifest mismatch",
    );
    const actualNames = yield* attempt("read release directory", () =>
      readdirSync(outputDir).sort(),
    );
    const expectedNames = (yield* releaseAssetNames(version)).sort();
    yield* check(
      JSON.stringify(actualNames) === JSON.stringify(expectedNames),
      `Unexpected release files: ${actualNames.join(", ")}`,
    );
  });
}

function createHomebrewManifest(
  version: string,
  assets: readonly ReleaseAsset[],
): Effect.Effect<
  {
    schema_version: number;
    formula: string;
    version: string;
    release: string;
    platforms: Record<
      string,
      { artifact: string; url: string; sha256: string }
    >;
  },
  ReleaseFailure
> {
  return Effect.gen(function* () {
    const platforms: Record<
      string,
      { artifact: string; url: string; sha256: string }
    > = {};
    for (const target of RELEASE_TARGETS) {
      if (!target.homebrew) continue;
      const asset = assets.find((candidate) => candidate.target === target.id);
      if (!asset) {
        return yield* releaseFailure(
          `Missing Homebrew release asset for ${target.id}`,
        );
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
  });
}

function verifyArchive(
  outputDir: string,
  target: ReleaseTarget,
  file: string,
): Effect.Effect<void, ReleaseFailure> {
  return Effect.gen(function* () {
    const archivePath = join(outputDir, file);
    const listCommand =
      target.archive === "zip"
        ? ["unzip", "-Z1", archivePath]
        : ["tar", "-tzf", archivePath];
    const listed = (yield* runCommand(listCommand))
      .trim()
      .split("\n")
      .filter(Boolean);
    yield* check(
      listed.length === 1 && listed[0] === target.executable,
      `Release archive ${file} must contain only ${target.executable}`,
    );
    if (target.os === "windows") return;
    const extractDir = yield* attempt(
      "create archive verification directory",
      () => mkdtempSync(join(tmpdir(), "akua-release-verify-")),
    );
    const verifyMode = Effect.gen(function* () {
      yield* runCommand(["tar", "-xzf", archivePath, "-C", extractDir]);
      const mode = yield* attempt(
        "read extracted executable metadata",
        () => statSync(join(extractDir, target.executable)).mode & 0o777,
      );
      yield* check(
        mode === 0o755,
        `Release executable mode mismatch for ${target.id}: ${mode.toString(8)}`,
      );
    });
    yield* verifyMode.pipe(
      Effect.ensuring(
        attempt("remove archive verification directory", () =>
          rmSync(extractDir, { recursive: true, force: true }),
        ).pipe(Effect.ignore),
      ),
    );
  });
}

function runCommand(
  command: string[],
  extraEnv: Record<string, string> = {},
): Effect.Effect<string, ReleaseFailure> {
  return Effect.gen(function* () {
    const proc = yield* attempt("run release command", () =>
      Bun.spawnSync({
        cmd: command,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...extraEnv },
      }),
    );
    const decoder = new TextDecoder();
    const stdout = decoder.decode(proc.stdout);
    const stderr = decoder.decode(proc.stderr);
    yield* check(
      proc.exitCode === 0,
      `${command[0]} failed (${proc.exitCode}): ${stderr.trim()}`,
    );
    return stdout;
  });
}

function sha256(bytes: Uint8Array): Effect.Effect<string, ReleaseFailure> {
  return attempt("calculate SHA-256", () =>
    createHash("sha256").update(bytes).digest("hex"),
  );
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function versionFromPayload(value: unknown): unknown {
  return isRecord(value) && isRecord(value.data)
    ? value.data.version
    : undefined;
}

function parseReleaseManifest(
  value: unknown,
): Effect.Effect<ReleaseManifest, ReleaseFailure> {
  if (!isRecord(value) || !Array.isArray(value.assets)) {
    return releaseFailure("Release manifest is invalid");
  }
  const version = value.version;
  const homebrewManifest = value.homebrew_manifest;
  if (
    value.schema_version !== 1 ||
    value.executable !== "akua" ||
    typeof version !== "string" ||
    value.checksums !== "checksums.txt" ||
    typeof homebrewManifest !== "string"
  ) {
    return releaseFailure("Release manifest is invalid");
  }
  return Effect.all(value.assets.map(parseReleaseAsset)).pipe(
    Effect.map((assets) => ({
      schema_version: 1,
      executable: "akua",
      version,
      checksums: "checksums.txt",
      homebrew_manifest: homebrewManifest,
      assets,
    })),
  );
}

function parseReleaseAsset(
  value: unknown,
): Effect.Effect<ReleaseAsset, ReleaseFailure> {
  if (!isRecord(value))
    return releaseFailure("Release manifest asset is invalid");
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
  if (
    stringFields.some((field) => typeof value[field] !== "string") ||
    typeof value.size !== "number"
  ) {
    return releaseFailure("Release manifest asset is invalid");
  }
  return Effect.gen(function* () {
    const target = yield* parseReleaseTargetId(value.target);
    const os = yield* parseReleaseOs(value.os);
    const arch = yield* parseReleaseArch(value.arch);
    const archive = yield* parseReleaseArchive(value.archive);
    const executable = yield* parseReleaseExecutable(value.executable);
    return {
      target,
      bun_target: yield* requiredString(value.bun_target),
      os,
      arch,
      archive,
      executable,
      file: yield* requiredString(value.file),
      checksum_file: yield* requiredString(value.checksum_file),
      sha256: yield* requiredString(value.sha256),
      size: yield* requiredNumber(value.size),
    };
  });
}

function parseReleaseTargetId(
  value: unknown,
): Effect.Effect<ReleaseAsset["target"], ReleaseFailure> {
  return value === "darwin-arm64" ||
    value === "darwin-x64" ||
    value === "linux-arm64" ||
    value === "linux-x64" ||
    value === "windows-x64"
    ? Effect.succeed(value)
    : releaseFailure("Release manifest asset is invalid");
}

function parseReleaseOs(
  value: unknown,
): Effect.Effect<ReleaseTarget["os"], ReleaseFailure> {
  return value === "darwin" || value === "linux" || value === "windows"
    ? Effect.succeed(value)
    : releaseFailure("Release manifest asset is invalid");
}

function parseReleaseArch(
  value: unknown,
): Effect.Effect<ReleaseTarget["arch"], ReleaseFailure> {
  return value === "arm64" || value === "x64"
    ? Effect.succeed(value)
    : releaseFailure("Release manifest asset is invalid");
}

function parseReleaseArchive(
  value: unknown,
): Effect.Effect<ReleaseTarget["archive"], ReleaseFailure> {
  return value === "tar.gz" || value === "zip"
    ? Effect.succeed(value)
    : releaseFailure("Release manifest asset is invalid");
}

function parseReleaseExecutable(
  value: unknown,
): Effect.Effect<ReleaseTarget["executable"], ReleaseFailure> {
  return value === "akua" || value === "akua.exe"
    ? Effect.succeed(value)
    : releaseFailure("Release manifest asset is invalid");
}

function requiredString(value: unknown): Effect.Effect<string, ReleaseFailure> {
  return typeof value === "string"
    ? Effect.succeed(value)
    : releaseFailure("Release manifest asset is invalid");
}

function requiredNumber(value: unknown): Effect.Effect<number, ReleaseFailure> {
  return typeof value === "number"
    ? Effect.succeed(value)
    : releaseFailure("Release manifest asset is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const ReleaseHostLive = Layer.succeed(ReleaseHost, {
  sha256,
  hostTargetId: attempt("read release host", () => ({
    platform: process.platform,
    arch: process.arch,
  })).pipe(
    Effect.flatMap(({ platform, arch }) =>
      releaseTargetIdForHost(platform, arch),
    ),
  ),
  planUploads: planReleaseUploads,
  assertSafeOutputDirectory,
  packageExistingExecutables,
  packageRelease,
  smokeReleaseArtifact,
  verifyReleaseDirectory,
});
