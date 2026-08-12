import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { Context, Data, Effect, Layer } from "effect";
import { Clock, Duration } from "effect";

import { encodeForm } from "./device-http";

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface HttpRequest {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
}

export class HttpFailure extends Data.TaggedError("HttpFailure")<{
  readonly cause: unknown;
}> {}

export class BrowserFailure extends Data.TaggedError("BrowserFailure")<{
  readonly cause: unknown;
}> {}

export class SecureConfigFailure extends Data.TaggedError(
  "SecureConfigFailure",
)<{
  readonly operation: "read" | "write" | "remove";
  readonly path: string;
  readonly cause: unknown;
}> {}

export class Http extends Context.Service<
  Http,
  {
    readonly postForm: (
      request: HttpRequest,
    ) => Effect.Effect<HttpResponse, HttpFailure>;
  }
>()("platform/cli/Http") {}

export class Browser extends Context.Service<
  Browser,
  {
    readonly launch: (url: string) => Effect.Effect<void, BrowserFailure>;
  }
>()("platform/cli/Browser") {}

export class Process extends Context.Service<
  Process,
  {
    readonly awaitSignal: Effect.Effect<void>;
  }
>()("platform/cli/Process") {}

export class Console extends Context.Service<
  Console,
  {
    readonly stdoutIsTTY: boolean;
    readonly writeStderr: (value: string) => Effect.Effect<void>;
    readonly writeStdout: (value: string) => Effect.Effect<void>;
  }
>()("platform/cli/Console") {}

export class SecureConfig extends Context.Service<
  SecureConfig,
  {
    readonly readToken: (
      path: string,
    ) => Effect.Effect<string | undefined, SecureConfigFailure>;
    readonly saveToken: (
      path: string,
      token: string,
    ) => Effect.Effect<void, SecureConfigFailure>;
    readonly removeToken: (
      path: string,
    ) => Effect.Effect<boolean, SecureConfigFailure>;
  }
>()("platform/cli/SecureConfig") {}

const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;
const MAX_DEVICE_RESPONSE_SIZE = 16_384;

export const HttpLive = Layer.succeed(Http, {
  postForm: (request) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(request.url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: encodeForm(request.fields),
          signal,
        });
        const text = await response.text();
        if (text.length > MAX_DEVICE_RESPONSE_SIZE) {
          throw new Error("Device response is too large.");
        }
        return {
          status: response.status,
          body: text === "" ? {} : JSON.parse(text),
        };
      },
      catch: (cause) => new HttpFailure({ cause }),
    }),
});

export const BrowserLive = Layer.succeed(Browser, {
  launch: (url) =>
    Effect.tryPromise({
      try: async () => {
        const command =
          process.platform === "darwin"
            ? ["open", url]
            : process.platform === "win32"
              ? ["cmd", "/c", "start", "", url]
              : ["xdg-open", url];
        const processHandle = Bun.spawn({
          cmd: command,
          stdout: "ignore",
          stderr: "ignore",
        });
        if ((await processHandle.exited) !== 0) {
          throw new Error("Browser launch failed.");
        }
      },
      catch: (cause) => new BrowserFailure({ cause }),
    }),
});

export const ProcessLive = Layer.succeed(Process, {
  awaitSignal: Effect.callback((resume) => {
    const cancel = () => resume(Effect.void);
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    return Effect.sync(() => {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    });
  }),
});

export const ConsoleLive = Layer.succeed(Console, {
  stdoutIsTTY: process.stdout.isTTY,
  writeStderr: (value) => Effect.sync(() => process.stderr.write(value)),
  writeStdout: (value) => Effect.sync(() => process.stdout.write(value)),
});

export const ClockLive = Layer.succeed(Clock.Clock, {
  currentTimeMillisUnsafe: () => Date.now(),
  currentTimeMillis: Effect.sync(Date.now),
  monotonicTimeNanosUnsafe: () => process.hrtime.bigint(),
  monotonicTimeNanos: Effect.sync(() => process.hrtime.bigint()),
  currentTimeNanosUnsafe: () => BigInt(Date.now()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(Date.now()) * 1_000_000n),
  sleep: (duration) =>
    Effect.tryPromise({
      try: () => Bun.sleep(Duration.toMillis(duration)),
      catch: () => new Error("Clock sleep failed."),
    }).pipe(Effect.orDie),
});

export const SecureConfigLive = Layer.succeed(SecureConfig, {
  readToken: (path) =>
    Effect.tryPromise({
      try: async () => {
        const config = await readConfig(path);
        return typeof config.token === "string" && config.token !== ""
          ? config.token
          : undefined;
      },
      catch: (cause) =>
        new SecureConfigFailure({ operation: "read", path, cause }),
    }),
  saveToken: (path, token) =>
    Effect.tryPromise({
      try: async () =>
        writeConfig(path, { ...(await readConfig(path)), token }),
      catch: (cause) =>
        new SecureConfigFailure({ operation: "write", path, cause }),
    }),
  removeToken: (path) =>
    Effect.tryPromise({
      try: async () => {
        let config: Record<string, unknown>;
        try {
          config = await readConfig(path);
        } catch (error) {
          if (!isNotFound(error)) {
            await rm(path, { force: true });
            return true;
          }
          return false;
        }
        if (!Object.prototype.hasOwnProperty.call(config, "token"))
          return false;
        const hadToken =
          typeof config.token === "string" && config.token !== "";
        const { token: _token, ...remaining } = config;
        await writeConfig(path, remaining);
        return hadToken;
      },
      catch: (cause) =>
        new SecureConfigFailure({ operation: "remove", path, cause }),
    }),
});

export const CliLive = Layer.mergeAll(
  HttpLive,
  BrowserLive,
  ProcessLive,
  ConsoleLive,
  SecureConfigLive,
  ClockLive,
);

async function readConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, "utf8");
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) throw new Error("Akua config must be a JSON object.");
    return value;
  } catch (error) {
    if (isNotFound(error)) return {};
    throw error;
  }
}

async function writeConfig(
  path: string,
  config: Record<string, unknown>,
): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.config.json.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: CONFIG_DIR_MODE });
    await chmod(directory, CONFIG_DIR_MODE);
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      mode: CONFIG_FILE_MODE,
      flag: "wx",
    });
    await chmod(temporary, CONFIG_FILE_MODE);
    await rename(temporary, path);
    await chmod(path, CONFIG_FILE_MODE);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
