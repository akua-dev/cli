import { isAbsolute } from "node:path";

import { Effect } from "effect";

import { AkuaCliError } from "./errors";
import { SECURE_OPEN_FLAGS } from "./secure-token-file-live";
import { SecureTokenFile } from "./secure-token-file-services";

export { SECURE_OPEN_FLAGS } from "./secure-token-file-live";

export const MAX_PROVIDER_TOKEN_BYTES = 4096;

export interface SecureTokenFileStat {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  size: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface SecureTokenFileHandle {
  stat(): Effect.Effect<SecureTokenFileStat, unknown>;
  read(buffer: Uint8Array, offset?: number, length?: number, position?: number): Effect.Effect<{ bytesRead: number }, unknown>;
  close(): Effect.Effect<void, unknown>;
}

export interface SecureTokenFileDependencies {
  getuid(): number;
  lstat(path: string): Effect.Effect<SecureTokenFileStat, unknown>;
  open(path: string, flags: number): Effect.Effect<SecureTokenFileHandle, unknown>;
}

export function readSecureTokenFile(path: string): Effect.Effect<Uint8Array, AkuaCliError, SecureTokenFile>;
export function readSecureTokenFile(path: string, dependencies: SecureTokenFileDependencies): Effect.Effect<Uint8Array, AkuaCliError>;
export function readSecureTokenFile(
  path: string,
  suppliedDependencies?: SecureTokenFileDependencies,
): Effect.Effect<Uint8Array, AkuaCliError, SecureTokenFile> {
  return Effect.gen(function* () {
    const dependencies = suppliedDependencies === undefined ? (yield* SecureTokenFile).dependencies : suppliedDependencies;
    return yield* readSecureTokenFileWithDependencies(path, dependencies);
  });
}

function readSecureTokenFileWithDependencies(
  path: string,
  dependencies: SecureTokenFileDependencies,
): Effect.Effect<Uint8Array, AkuaCliError> {
  if (!isAbsolute(path)) return Effect.fail(invalidPathError());
  return safeLstat(path, dependencies).pipe(
    Effect.flatMap((preOpen) =>
      Effect.try({
        try: () => {
          validateStat(preOpen, dependencies.getuid());
          validateSize(preOpen.size);
        },
        catch: (error) => error instanceof AkuaCliError ? error : unsafeFileError(),
      }).pipe(
        Effect.andThen(
          Effect.acquireUseRelease(
            safeOpen(path, dependencies),
            (handle) => readOpenedFile(handle, preOpen, dependencies),
            (handle) => handle.close().pipe(Effect.ignore),
          ),
        ),
      ),
    ),
  );
}

export function clearBytes(bytes: Uint8Array): void {
  bytes.fill(0);
}

function safeLstat(path: string, dependencies: SecureTokenFileDependencies): Effect.Effect<SecureTokenFileStat, AkuaCliError> {
  return dependencies.lstat(path).pipe(Effect.mapError(unsafeFileError));
}

function safeOpen(path: string, dependencies: SecureTokenFileDependencies): Effect.Effect<SecureTokenFileHandle, AkuaCliError> {
  return dependencies.open(path, SECURE_OPEN_FLAGS).pipe(Effect.mapError(unsafeFileError));
}

function readOpenedFile(
  handle: SecureTokenFileHandle,
  preOpen: SecureTokenFileStat,
  dependencies: SecureTokenFileDependencies,
): Effect.Effect<Uint8Array, AkuaCliError> {
  return handle.stat().pipe(
    Effect.mapError(unsafeFileError),
    Effect.flatMap((opened) =>
      Effect.try({
        try: () => {
          validateStat(opened, dependencies.getuid());
          if (!sameFile(preOpen, opened)) throw changedFileError();
          validateSize(opened.size);
          return new Uint8Array(opened.size);
        },
        catch: (error) => error instanceof AkuaCliError ? error : unsafeFileError(),
      }),
    ),
    Effect.flatMap((bytes) =>
      handle.read(bytes, 0, bytes.byteLength, 0).pipe(
        Effect.mapError(unsafeFileError),
        Effect.flatMap(({ bytesRead }) =>
          bytesRead === bytes.byteLength
            ? Effect.succeed(bytes)
            : Effect.sync(() => clearBytes(bytes)).pipe(Effect.andThen(Effect.fail(unsafeFileError()))),
        ),
        Effect.catch((error) => Effect.sync(() => clearBytes(bytes)).pipe(Effect.andThen(Effect.fail(error)))),
      ),
    ),
  );
}

function validateStat(stat: SecureTokenFileStat, expectedUid: number): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== expectedUid || (stat.mode & 0o777) !== 0o600) throw unsafeFileError();
}

function validateSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PROVIDER_TOKEN_BYTES) throw new AkuaCliError({ type: "validation_error", code: "AKUA_LOADER_TOKEN_FILE_SIZE_INVALID", message: "The provider token file size is invalid.", exitCode: 2 });
}

function sameFile(before: SecureTokenFileStat, opened: SecureTokenFileStat): boolean {
  return before.dev === opened.dev && before.ino === opened.ino && before.uid === opened.uid && before.mode === opened.mode && before.size === opened.size;
}

function invalidPathError(): AkuaCliError {
  return new AkuaCliError({ type: "validation_error", code: "AKUA_LOADER_TOKEN_PATH_INVALID", message: "The provider token file must use an absolute path.", exitCode: 2 });
}

function unsafeFileError(): AkuaCliError {
  return new AkuaCliError({ type: "validation_error", code: "AKUA_LOADER_TOKEN_FILE_UNSAFE", message: "The provider token file does not meet the required security checks.", exitCode: 2 });
}

function changedFileError(): AkuaCliError {
  return new AkuaCliError({ type: "validation_error", code: "AKUA_LOADER_TOKEN_FILE_CHANGED", message: "The provider token file changed while it was being opened.", exitCode: 2 });
}
