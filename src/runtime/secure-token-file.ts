import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { AkuaCliError } from "./errors";

export const MAX_PROVIDER_TOKEN_BYTES = 4096;

// Bun's Node type declarations omit O_CLOEXEC although its Unix open syscall
// accepts it. Linux uses 0x80000; Darwin and the supported BSD target use
// 0x1000000. This command is intentionally Unix-only.
const O_CLOEXEC = process.platform === "linux" ? 0x80000 : 0x1000000;
export const SECURE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | O_CLOEXEC;

export interface SecureTokenFileStat {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  size: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface SecureTokenFileHandle {
  stat(): Promise<SecureTokenFileStat>;
  read(buffer: Uint8Array, offset?: number, length?: number, position?: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface SecureTokenFileDependencies {
  getuid(): number;
  lstat(path: string): Promise<SecureTokenFileStat>;
  open(path: string, flags: number): Promise<SecureTokenFileHandle>;
}

const productionDependencies: SecureTokenFileDependencies = {
  getuid: () => {
    if (typeof process.getuid !== "function") {
      throw unsafeFileError();
    }
    return process.getuid();
  },
  lstat: async (path) => lstat(path),
  open: async (path, flags) => open(path, flags),
};

export async function readSecureTokenFile(
  path: string,
  dependencies: SecureTokenFileDependencies = productionDependencies,
): Promise<Uint8Array> {
  if (!isAbsolute(path)) {
    throw new AkuaCliError({
      type: "validation_error",
      code: "AKUA_HCLOUD_TOKEN_PATH_INVALID",
      message: "The provider token file must use an absolute path.",
      exitCode: 2,
    });
  }

  const preOpen = await safeLstat(path, dependencies);
  validateStat(preOpen, dependencies.getuid());
  validateSize(preOpen.size);

  let handle: SecureTokenFileHandle | undefined;
  try {
    handle = await dependencies.open(path, SECURE_OPEN_FLAGS);
    const opened = await safeFstat(handle);
    validateStat(opened, dependencies.getuid());
    if (!sameFile(preOpen, opened)) {
      throw changedFileError();
    }
    validateSize(opened.size);

    const bytes = new Uint8Array(opened.size);
    try {
      const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
      if (bytesRead !== bytes.byteLength) {
        clearBytes(bytes);
        throw unsafeFileError();
      }
      return bytes;
    } catch (error) {
      clearBytes(bytes);
      throw error;
    }
  } catch (error) {
    if (error instanceof AkuaCliError) {
      throw error;
    }
    throw unsafeFileError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function clearBytes(bytes: Uint8Array): void {
  bytes.fill(0);
}

async function safeLstat(path: string, dependencies: SecureTokenFileDependencies): Promise<SecureTokenFileStat> {
  try {
    return await dependencies.lstat(path);
  } catch {
    throw unsafeFileError();
  }
}

async function safeFstat(handle: SecureTokenFileHandle): Promise<SecureTokenFileStat> {
  try {
    return await handle.stat();
  } catch {
    throw unsafeFileError();
  }
}

function validateStat(stat: SecureTokenFileStat, expectedUid: number): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== expectedUid || (stat.mode & 0o777) !== 0o600) {
    throw unsafeFileError();
  }
}

function validateSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PROVIDER_TOKEN_BYTES) {
    throw new AkuaCliError({
      type: "validation_error",
      code: "AKUA_HCLOUD_TOKEN_FILE_SIZE_INVALID",
      message: "The provider token file size is invalid.",
      exitCode: 2,
    });
  }
}

function sameFile(before: SecureTokenFileStat, opened: SecureTokenFileStat): boolean {
  return (
    before.dev === opened.dev &&
    before.ino === opened.ino &&
    before.uid === opened.uid &&
    before.mode === opened.mode &&
    before.size === opened.size
  );
}

function unsafeFileError(): AkuaCliError {
  return new AkuaCliError({
    type: "validation_error",
    code: "AKUA_HCLOUD_TOKEN_FILE_UNSAFE",
    message: "The provider token file does not meet the required security checks.",
    exitCode: 2,
  });
}

function changedFileError(): AkuaCliError {
  return new AkuaCliError({
    type: "validation_error",
      code: "AKUA_HCLOUD_TOKEN_FILE_CHANGED",
    message: "The provider token file changed while it was being opened.",
    exitCode: 2,
  });
}
