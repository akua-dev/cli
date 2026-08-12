import { Context, Effect } from "effect";

export type ReleaseTargetId =
  "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64" | "windows-x64";

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

export function validateVersion(version: string): void {
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  ) {
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
  const archives = RELEASE_TARGETS.map((target) =>
    artifactName(version, target),
  );
  return [
    ...archives,
    ...archives.map((archive) => `${archive}.sha256`),
    "checksums.txt",
    releaseManifestName(version),
    homebrewManifestName(version),
  ];
}

export function assertCompiledExecutable(
  target: Pick<ReleaseTarget, "id" | "os">,
  bytes: Uint8Array,
): void {
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
    throw new Error(
      `Compiled executable has an invalid ${target.os} header for ${target.id}`,
    );
  }
}

export function releaseTargetIdForHost(
  platform: string,
  arch: string,
): ReleaseTargetId {
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
    readonly sha256: (bytes: Uint8Array) => Effect.Effect<string, Error>;
    readonly hostTargetId: Effect.Effect<ReleaseTargetId, Error>;
    readonly planUploads: (
      candidateDir: string,
      existingDir: string,
      version: string,
    ) => Effect.Effect<string[], Error>;
    readonly assertSafeOutputDirectory: (
      outputDir: string,
    ) => Effect.Effect<void, Error>;
    readonly packageExistingExecutables: (
      input: PackageExistingExecutablesInput,
    ) => Effect.Effect<void, Error>;
    readonly packageRelease: (
      input: PackageReleaseInput,
    ) => Effect.Effect<void, Error>;
    readonly smokeReleaseArtifact: (input: {
      version: string;
      outputDir: string;
      targetId: string;
    }) => Effect.Effect<void, Error>;
    readonly verifyReleaseDirectory: (
      outputDir: string,
      version: string,
    ) => Effect.Effect<void, Error>;
  }
>()("platform/scripts/ReleaseHost") {}
