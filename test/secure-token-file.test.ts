import { describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  MAX_PROVIDER_TOKEN_BYTES,
  readSecureTokenFile,
  SECURE_OPEN_FLAGS,
  type SecureTokenFileDependencies,
  type SecureTokenFileStat,
} from "../src/runtime/secure-token-file";

const SYNTHETIC_BYTES = new Uint8Array([115, 121, 110, 116, 104, 101, 116, 105, 99]);
const UID = 501;

describe("readSecureTokenFile", () => {
  test("reads a caller-owned 0600 regular file through one descriptor read and closes it", async () => {
    const fixture = makeFakeFixture();

    const result = await readSecureTokenFile("/synthetic/provider", fixture.dependencies);

    expect(Array.from(result)).toEqual(Array.from(SYNTHETIC_BYTES));
    expect(fixture.reads).toBe(1);
    expect(fixture.closed).toBe(1);
    expect(fixture.flags).toBe(SECURE_OPEN_FLAGS);
    expect(SECURE_OPEN_FLAGS & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    const closeOnExec = process.platform === "linux" ? 0x80000 : 0x1000000;
    expect(SECURE_OPEN_FLAGS & closeOnExec).toBe(closeOnExec);
  });

  test("rejects a relative file path without opening it", async () => {
    const fixture = makeFakeFixture();

    await expect(readSecureTokenFile("relative/provider", fixture.dependencies)).rejects.toMatchObject({
      code: "AKUA_HCLOUD_TOKEN_PATH_INVALID",
    });
    expect(fixture.opens).toBe(0);
  });

  test("rejects a symlink before opening it", async () => {
    const fixture = makeFakeFixture({ pre: fakeStat({ symbolicLink: true }) });

    await expect(readSecureTokenFile("/synthetic/provider", fixture.dependencies)).rejects.toMatchObject({
      code: "AKUA_HCLOUD_TOKEN_FILE_UNSAFE",
    });
    expect(fixture.opens).toBe(0);
  });

  test("rejects a directory, FIFO/device-like entry, wrong owner, and wrong mode", async () => {
    for (const pre of [
      fakeStat({ regular: false }),
      fakeStat({ regular: false }),
      fakeStat({ uid: UID + 1 }),
      fakeStat({ mode: 0o640 }),
    ]) {
      const fixture = makeFakeFixture({ pre });
      await expect(readSecureTokenFile("/synthetic/provider", fixture.dependencies)).rejects.toMatchObject({
        code: "AKUA_HCLOUD_TOKEN_FILE_UNSAFE",
      });
      expect(fixture.opens).toBe(0);
    }
  });

  test("rejects empty and oversized input before descriptor read", async () => {
    for (const size of [0, MAX_PROVIDER_TOKEN_BYTES + 1]) {
      const fixture = makeFakeFixture({ pre: fakeStat({ size }), opened: fakeStat({ size }) });
      await expect(readSecureTokenFile("/synthetic/provider", fixture.dependencies)).rejects.toMatchObject({
        code: "AKUA_HCLOUD_TOKEN_FILE_SIZE_INVALID",
      });
      expect(fixture.reads).toBe(0);
      expect(fixture.closed).toBe(0);
    }
  });

  test("rejects a descriptor substitution after lstat before it can be read", async () => {
    const fixture = makeFakeFixture({ opened: fakeStat({ ino: 99 }) });

    await expect(readSecureTokenFile("/synthetic/provider", fixture.dependencies)).rejects.toMatchObject({
      code: "AKUA_HCLOUD_TOKEN_FILE_CHANGED",
    });
    expect(fixture.reads).toBe(0);
    expect(fixture.closed).toBe(1);
  });

  test("rejects a real symlink with no descriptor access", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-akua-loader-file-"));
    try {
      const target = join(directory, "target");
      const link = join(directory, "link");
      await writeFile(target, SYNTHETIC_BYTES, { mode: 0o600 });
      await chmod(target, 0o600);
      await symlink(target, link);

      await expect(readSecureTokenFile(link)).rejects.toMatchObject({ code: "AKUA_HCLOUD_TOKEN_FILE_UNSAFE" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function makeFakeFixture(options: { pre?: SecureTokenFileStat; opened?: SecureTokenFileStat } = {}) {
  let opens = 0;
  let reads = 0;
  let closed = 0;
  let flags: number | undefined;
  const pre = options.pre ?? fakeStat();
  const opened = options.opened ?? fakeStat();
  const dependencies: SecureTokenFileDependencies = {
    getuid: () => UID,
    lstat: async () => pre,
    open: async (_path, openFlags) => {
      opens += 1;
      flags = openFlags;
      return {
        stat: async () => opened,
        read: async (buffer) => {
          reads += 1;
          buffer.set(SYNTHETIC_BYTES);
          return { bytesRead: SYNTHETIC_BYTES.byteLength };
        },
        close: async () => {
          closed += 1;
        },
      };
    },
  };

  return {
    dependencies,
    get opens() {
      return opens;
    },
    get reads() {
      return reads;
    },
    get closed() {
      return closed;
    },
    get flags() {
      return flags;
    },
  };
}

function fakeStat(options: {
  dev?: number;
  ino?: number;
  uid?: number;
  mode?: number;
  size?: number;
  regular?: boolean;
  symbolicLink?: boolean;
} = {}): SecureTokenFileStat {
  return {
    dev: options.dev ?? 1,
    ino: options.ino ?? 2,
    uid: options.uid ?? UID,
    mode: options.mode ?? 0o100600,
    size: options.size ?? SYNTHETIC_BYTES.byteLength,
    isFile: () => options.regular ?? true,
    isSymbolicLink: () => options.symbolicLink ?? false,
  };
}
