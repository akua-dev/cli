import { Effect, Runtime } from "effect";

import {
  RELEASE_TARGETS as releaseTargets,
  ReleaseHost,
  ReleaseHostLive,
  archiveExtractCommand as releaseArchiveExtractCommand,
  artifactName as releaseArtifactName,
  assertCompiledExecutable as releaseAssertCompiledExecutable,
  checksumLine as releaseChecksumLine,
  homebrewManifestName as releaseHomebrewManifestName,
  hostTargetId as releaseHostTargetId,
  releaseAssetNames as releaseAssetNamesForVersion,
  releaseManifestName as releaseManifestNameForVersion,
  releaseMatrix as releaseMatrixForTargets,
  sha256 as releaseSha256,
  validateVersion as validateReleaseVersion,
} from "./runtime/release-services";
import type {
  PackageExistingExecutablesInput,
  PackageReleaseInput,
  ReleaseAsset as ReleaseAssetValue,
  ReleaseManifest as ReleaseManifestValue,
  ReleaseTarget as ReleaseTargetValue,
  ReleaseTargetId as ReleaseTargetIdValue,
} from "./runtime/release-services";

export const RELEASE_TARGETS = releaseTargets;
export const artifactName = releaseArtifactName;
export const archiveExtractCommand = releaseArchiveExtractCommand;
export const assertCompiledExecutable = releaseAssertCompiledExecutable;
export const checksumLine = releaseChecksumLine;
export const homebrewManifestName = releaseHomebrewManifestName;
export const hostTargetId = releaseHostTargetId;
export const releaseAssetNames = releaseAssetNamesForVersion;
export const releaseManifestName = releaseManifestNameForVersion;
export const releaseMatrix = releaseMatrixForTargets;
export const sha256 = releaseSha256;
export const validateVersion = validateReleaseVersion;
export type ReleaseAsset = ReleaseAssetValue;
export type ReleaseManifest = ReleaseManifestValue;
export type ReleaseTarget = ReleaseTargetValue;
export type ReleaseTargetId = ReleaseTargetIdValue;

export function planReleaseUploads(candidateDir: string, existingDir: string, version: string) {
  return Effect.gen(function* () {
    return yield* (yield* ReleaseHost).planUploads(candidateDir, existingDir, version);
  }).pipe(Effect.provide(ReleaseHostLive));
}

export function assertSafeOutputDirectory(outputDir: string) {
  return Effect.gen(function* () {
    return yield* (yield* ReleaseHost).assertSafeOutputDirectory(outputDir);
  }).pipe(Effect.provide(ReleaseHostLive));
}

export function packageExistingExecutables(input: PackageExistingExecutablesInput) {
  return Effect.gen(function* () {
    return yield* (yield* ReleaseHost).packageExistingExecutables(input);
  }).pipe(Effect.provide(ReleaseHostLive));
}

export function packageRelease(input: PackageReleaseInput) {
  return Effect.gen(function* () {
    return yield* (yield* ReleaseHost).packageRelease(input);
  }).pipe(Effect.provide(ReleaseHostLive));
}

export function smokeReleaseArtifact(input: { version: string; outputDir: string; targetId: string }) {
  return Effect.gen(function* () {
    return yield* (yield* ReleaseHost).smokeReleaseArtifact(input);
  }).pipe(Effect.provide(ReleaseHostLive));
}

export function verifyReleaseDirectory(outputDir: string, version: string) {
  return Effect.gen(function* () {
    return yield* (yield* ReleaseHost).verifyReleaseDirectory(outputDir, version);
  }).pipe(Effect.provide(ReleaseHostLive));
}

function readCliFlags(argv: readonly string[]): { command: string; version: string; outputDir: string; targetId?: string; existingDir?: string } {
  const [command, ...flags] = argv;
  if (!command || !["matrix", "package", "verify", "smoke", "upload-plan"].includes(command)) throw new Error("Usage: bun scripts/release.ts <matrix|package|verify|smoke|upload-plan> --version <version> --output <directory> [--target <target>] [--existing <directory>]");
  if (command === "matrix") return { command, version: "", outputDir: "" };
  const values: Record<string, string> = {};
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`Invalid release argument near: ${flag ?? "<end>"}`);
    values[flag.slice(2)] = value;
  }
  if (!values.version || !values.output) throw new Error("Both --version and --output are required");
  if (command === "upload-plan" && !values.existing) throw new Error("--existing is required for upload-plan");
  return { command, version: values.version, outputDir: values.output, targetId: values.target, existingDir: values.existing };
}

if (import.meta.main) {
  Runtime.makeRunMain(({ fiber, teardown }) => {
    fiber.addObserver((exit) => teardown(exit, (code) => { process.exitCode = code; }));
  })(Effect.try({ try: () => readCliFlags(process.argv.slice(2)), catch: toError }).pipe(
    Effect.flatMap((input) => {
      if (input.command === "matrix") return Effect.sync(() => console.log(JSON.stringify(releaseMatrix())));
      if (input.command === "package") return packageRelease({ version: input.version, outputDir: input.outputDir });
      if (input.command === "verify") return verifyReleaseDirectory(input.outputDir, input.version);
      if (input.command === "upload-plan") return input.existingDir === undefined ? Effect.fail(new Error("--existing is required for upload-plan")) : planReleaseUploads(input.outputDir, input.existingDir, input.version).pipe(Effect.tap((plan) => Effect.sync(() => console.log(JSON.stringify(plan)))));
      return smokeReleaseArtifact({ version: input.version, outputDir: input.outputDir, targetId: input.targetId ?? hostTargetId() });
    }),
    Effect.provide(ReleaseHostLive),
  ));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
