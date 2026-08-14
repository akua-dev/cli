import { Context, Data, Effect } from "effect";

export class ReleaseFailure extends Data.TaggedError("ReleaseFailure")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type ReleaseTargetId =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "windows-x64";

export interface ReleaseTarget {
  id: ReleaseTargetId;
  bunTarget: string;
  os: "darwin" | "linux" | "windows";
  arch: "arm64" | "x64";
  archive: "tar.gz" | "zip";
  executable: "akua" | "akua.exe";
  bindingPackage: string;
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
    bindingPackage: "native-darwin-arm64",
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
    bindingPackage: "native-darwin-x64",
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
    bindingPackage: "native-linux-arm64-gnu",
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
    bindingPackage: "native-linux-x64-gnu",
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
    bindingPackage: "native-win32-x64-msvc",
    runner: "windows-2025",
  },
];

export interface ReleaseAsset {
  target: ReleaseTargetId;
  bun_target: string;
  os: ReleaseTarget["os"];
  arch: ReleaseTarget["arch"];
  archive: ReleaseTarget["archive"];
  executable: ReleaseTarget["executable"];
  contents: string[];
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
  packageRoot: string;
}

export interface PackageReleaseInput {
  version: string;
  outputDir: string;
  entrypoint?: string;
  packageRoot?: string;
}

export function releaseMatrix(): {
  include: Array<{ target: ReleaseTargetId; runner: string }>;
} {
  return {
    include: RELEASE_TARGETS.map((target) => ({
      target: target.id,
      runner: target.runner,
    })),
  };
}

export function artifactName(
  version: string,
  target: Pick<ReleaseTarget, "id" | "archive">,
): string {
  return `akua-v${version}-${target.id}.${target.archive}`;
}

export function checksumLine(name: string, digest: string): string {
  return `${digest}  ${name}\n`;
}

export function validateVersion(
  version: string,
): Effect.Effect<void, ReleaseFailure> {
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  ) {
    return releaseFailure(`Invalid release version: ${version}`);
  }
  return Effect.void;
}

export function releaseManifestName(
  version: string,
): Effect.Effect<string, ReleaseFailure> {
  return validateVersion(version).pipe(
    Effect.map(() => `akua-v${version}-manifest.json`),
  );
}

export function homebrewManifestName(
  version: string,
): Effect.Effect<string, ReleaseFailure> {
  return validateVersion(version).pipe(
    Effect.map(() => `akua-v${version}-homebrew.json`),
  );
}

export function releaseAssetNames(
  version: string,
): Effect.Effect<string[], ReleaseFailure> {
  return Effect.gen(function* () {
    const archives = RELEASE_TARGETS.map((target) =>
      artifactName(version, target),
    );
    return [
      ...archives,
      ...archives.map((archive) => `${archive}.sha256`),
      "checksums.txt",
      yield* releaseManifestName(version),
      yield* homebrewManifestName(version),
    ];
  });
}

export function assertCompiledExecutable(
  target: Pick<ReleaseTarget, "id" | "os">,
  bytes: Uint8Array,
): Effect.Effect<void, ReleaseFailure> {
  const expectedMagic =
    target.os === "darwin"
      ? [0xcf, 0xfa, 0xed, 0xfe]
      : target.os === "linux"
        ? [0x7f, 0x45, 0x4c, 0x46]
        : [0x4d, 0x5a];
  if (
    bytes.length < expectedMagic.length ||
    expectedMagic.some((byte, index) => bytes[index] !== byte)
  ) {
    return releaseFailure(
      `Compiled executable has an invalid ${target.os} header for ${target.id}`,
    );
  }
  return Effect.void;
}

export function releaseTargetIdForHost(
  platform: string,
  arch: string,
): Effect.Effect<ReleaseTargetId, ReleaseFailure> {
  const normalizedPlatform = platform === "win32" ? "windows" : platform;
  const id = `${normalizedPlatform}-${arch}`;
  const target = RELEASE_TARGETS.find((candidate) => candidate.id === id);
  if (!target) {
    return releaseFailure(`Unsupported release host: ${platform}-${arch}`);
  }
  return Effect.succeed(target.id);
}

export function archiveExtractCommand(
  archive: ReleaseTarget["archive"],
  archivePath: string,
  installRoot: string,
  platform: string,
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

export class ReleaseHost extends Context.Service<
  ReleaseHost,
  {
    readonly sha256: (
      bytes: Uint8Array,
    ) => Effect.Effect<string, ReleaseFailure>;
    readonly hostTargetId: Effect.Effect<ReleaseTargetId, ReleaseFailure>;
    readonly planUploads: (
      candidateDir: string,
      existingDir: string,
      version: string,
    ) => Effect.Effect<string[], ReleaseFailure>;
    readonly assertSafeOutputDirectory: (
      outputDir: string,
    ) => Effect.Effect<void, ReleaseFailure>;
    readonly packageExistingExecutables: (
      input: PackageExistingExecutablesInput,
    ) => Effect.Effect<void, ReleaseFailure>;
    readonly packageRelease: (
      input: PackageReleaseInput,
    ) => Effect.Effect<void, ReleaseFailure>;
    readonly smokeReleaseArtifact: (input: {
      version: string;
      outputDir: string;
      targetId: string;
    }) => Effect.Effect<void, ReleaseFailure>;
    readonly verifyReleaseDirectory: (
      outputDir: string,
      version: string,
    ) => Effect.Effect<void, ReleaseFailure>;
  }
>()("platform/scripts/ReleaseHost") {}

export function releaseFailure(
  message: string,
  cause?: unknown,
): Effect.Effect<never, ReleaseFailure> {
  return Effect.fail(new ReleaseFailure({ message, cause }));
}
