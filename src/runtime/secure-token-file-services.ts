import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

import { Context, Effect, Layer } from "effect";

import type { SecureTokenFileDependencies, SecureTokenFileHandle, SecureTokenFileStat } from "./secure-token-file";

const O_CLOEXEC = process.platform === "linux" ? 0x80000 : 0x1000000;
export const SECURE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | O_CLOEXEC;

export class SecureTokenFile extends Context.Service<SecureTokenFile, {
  readonly dependencies: SecureTokenFileDependencies;
}>()("platform/cli/SecureTokenFile") {}

export const SecureTokenFileLive = Layer.succeed(SecureTokenFile, {
  dependencies: {
    getuid: () => {
      if (typeof process.getuid !== "function") throw new Error("getuid is unavailable");
      return process.getuid();
    },
    lstat: (path) => Effect.tryPromise({ try: () => lstat(path), catch: (cause) => cause }),
    open: (path, flags) => Effect.tryPromise({ try: () => open(path, flags), catch: (cause) => cause }).pipe(Effect.map(adaptFileHandle)),
  },
});

function adaptFileHandle(handle: FileHandle): SecureTokenFileHandle {
  return {
    stat: () => Effect.tryPromise({ try: () => handle.stat(), catch: (cause) => cause }),
    read: (buffer, offset, length, position) => Effect.tryPromise({ try: () => handle.read(buffer, offset, length, position), catch: (cause) => cause }).pipe(Effect.map((result) => ({ bytesRead: result.bytesRead }))),
    close: () => Effect.tryPromise({ try: () => handle.close(), catch: (cause) => cause }),
  };
}
