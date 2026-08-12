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
import { Duration } from "effect";

import { encodeForm } from "./device-http";

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface HttpRequest {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface HttpBytesRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
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
    readonly postBytes?: (
      request: HttpBytesRequest,
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

export class CliClock extends Context.Service<
  CliClock,
  {
    readonly currentTimeMillis: Effect.Effect<number>;
    readonly sleep: (duration: Duration.Duration) => Effect.Effect<void>;
  }
>()("platform/cli/Clock") {}

export type CliServices =
  | Http
  | Browser
  | Process
  | Console
  | SecureConfig
  | CliClock;

const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;
const MAX_DEVICE_RESPONSE_SIZE = 16_384;

export const HttpLive = Layer.succeed(Http, {
  postForm: (request) =>
    Effect.tryPromise({
      try: (signal) =>
        fetch(request.url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: encodeForm(request.fields),
          signal,
        }).then((response) =>
          response.text().then((text) => {
            if (text.length > MAX_DEVICE_RESPONSE_SIZE) {
              throw new Error("Device response is too large.");
            }
            return {
              status: response.status,
              body: text === "" ? {} : JSON.parse(text),
            };
          }),
        ),
      catch: (cause) => new HttpFailure({ cause }),
    }),
  postBytes: (request) =>
    Effect.tryPromise({
      try: (signal) =>
        fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: new Blob([new Uint8Array(request.body)]),
          signal,
        }).then((response) =>
          response.text().then((text) => {
            if (text.length > MAX_DEVICE_RESPONSE_SIZE) {
              throw new Error("HTTP response is too large.");
            }
            return {
              status: response.status,
              body: text === "" ? {} : JSON.parse(text),
            };
          }),
        ),
      catch: (cause) => new HttpFailure({ cause }),
    }),
});

export const BrowserLive = Layer.succeed(Browser, {
  launch: (url) =>
    Effect.tryPromise({
      try: () => {
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
        return processHandle.exited.then((exitCode) => {
          if (exitCode !== 0) throw new Error("Browser launch failed.");
        });
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

export const ClockLive = Layer.succeed(CliClock, {
  currentTimeMillis: Effect.sync(Date.now),
  sleep: (duration) =>
    Effect.tryPromise({
      try: () => Bun.sleep(Duration.toMillis(duration)),
      catch: () => new Error("Clock sleep failed."),
    }).pipe(Effect.orDie),
});

export const SecureConfigLive = Layer.succeed(SecureConfig, {
  readToken: (path) =>
    readConfig(path).pipe(
      Effect.map((config) => {
        return typeof config.token === "string" && config.token !== ""
          ? config.token
          : undefined;
      }),
      Effect.mapError(
        (cause) => new SecureConfigFailure({ operation: "read", path, cause }),
      ),
    ),
  saveToken: (path, token) =>
    readConfig(path).pipe(
      Effect.flatMap((config) => writeConfig(path, { ...config, token })),
      Effect.mapError(
        (cause) => new SecureConfigFailure({ operation: "write", path, cause }),
      ),
    ),
  removeToken: (path) =>
    readConfig(path).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          isNotFound(cause)
            ? Effect.succeed(false)
            : removeConfig(path).pipe(Effect.as(true)),
        onSuccess: (config) => {
        if (!Object.prototype.hasOwnProperty.call(config, "token"))
          return Effect.succeed(false);
        const hadToken =
          typeof config.token === "string" && config.token !== "";
        const { token: _token, ...remaining } = config;
        return writeConfig(path, remaining).pipe(Effect.as(hadToken));
        },
      }),
      Effect.mapError(
        (cause) => new SecureConfigFailure({ operation: "remove", path, cause }),
      ),
    ),
});

export const CliLive: Layer.Layer<CliServices> = Layer.mergeAll(
  HttpLive,
  BrowserLive,
  ProcessLive,
  ConsoleLive,
  SecureConfigLive,
  ClockLive,
);

function readConfig(path: string): Effect.Effect<Record<string, unknown>, unknown> {
  return Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) => (isNotFound(cause) ? Effect.succeed("{}") : Effect.fail(cause))),
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => {
          const value: unknown = JSON.parse(raw);
          if (!isRecord(value)) {
            throw new Error("Akua config must be a JSON object.");
          }
          return value;
        },
        catch: (cause) => cause,
      }),
    ),
  );
}

function writeConfig(
  path: string,
  config: Record<string, unknown>,
): Effect.Effect<void, unknown> {
  const directory = dirname(path);
  const temporary = join(directory, `.config.json.${randomUUID()}.tmp`);
  const cleanup = Effect.tryPromise({
    try: () => rm(temporary, { force: true }),
    catch: () => undefined,
  }).pipe(Effect.ignore);
  return Effect.gen(function* () {
    yield* Effect.tryPromise({ try: () => mkdir(directory, { recursive: true, mode: CONFIG_DIR_MODE }), catch: (cause) => cause });
    yield* Effect.tryPromise({ try: () => chmod(directory, CONFIG_DIR_MODE), catch: (cause) => cause });
    yield* Effect.tryPromise({
      try: () => writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: CONFIG_FILE_MODE, flag: "wx" }),
      catch: (cause) => cause,
    });
    yield* Effect.tryPromise({ try: () => chmod(temporary, CONFIG_FILE_MODE), catch: (cause) => cause });
    yield* Effect.tryPromise({ try: () => rename(temporary, path), catch: (cause) => cause });
    yield* Effect.tryPromise({ try: () => chmod(path, CONFIG_FILE_MODE), catch: (cause) => cause });
  }).pipe(Effect.ensuring(cleanup));
}

function removeConfig(path: string): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: () => rm(path, { force: true }),
    catch: (cause) => cause,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
