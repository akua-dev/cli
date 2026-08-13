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

import { Data, Duration, Effect, Layer } from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  Browser,
  BrowserFailure,
  CliClock,
  type CliServices,
  Console,
  Http,
  HttpFailure,
  Process,
  PublicInput,
  PublicInputFailure,
  SecureConfig,
  SecureConfigFailure,
} from "./services";

const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;
const MAX_DEVICE_RESPONSE_SIZE = 16_384;

class ConfigParseFailure extends Data.TaggedError("ConfigParseFailure")<{
  readonly cause: Error;
}> {}

export const HttpLive = Layer.effect(
  Http,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return {
      postJson: (request) =>
        readJsonResponse(
          HttpClientRequest.post(request.url).pipe(
            HttpClientRequest.bodyJson(request.body),
            Effect.flatMap(client.execute),
          ),
          "Device response is too large.",
        ),
    };
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

export const BrowserLive = Layer.succeed(Browser, {
  launch: (url) =>
    Effect.try({
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
        return processHandle;
      },
      catch: (cause) => new BrowserFailure({ cause }),
    }).pipe(
      Effect.flatMap((processHandle) =>
        Effect.tryPromise({
          try: () => processHandle.exited,
          catch: (cause) => new BrowserFailure({ cause }),
        }),
      ),
      Effect.flatMap((exitCode) =>
        exitCode === 0
          ? Effect.void
          : Effect.fail(
              new BrowserFailure({
                cause: new Error("Browser launch failed."),
              }),
            ),
      ),
    ),
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
      Effect.map((config) =>
        typeof config.token === "string" && config.token !== ""
          ? config.token
          : undefined,
      ),
      Effect.mapError(
        (cause) => new SecureConfigFailure({ operation: "read", path, cause }),
      ),
    ),
  saveToken: (path, token) =>
    readConfig(path).pipe(
      Effect.flatMap((config) => writeConfig(path, { ...config, token })),
      Effect.mapError(
        (cause) =>
          new SecureConfigFailure({ operation: "write", path, cause }),
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
        (cause) =>
          new SecureConfigFailure({ operation: "remove", path, cause }),
      ),
    ),
});

export const PublicInputLive = Layer.succeed(PublicInput, {
  read: (source) =>
    Effect.tryPromise({
      try: () => (source === "-" ? Bun.stdin.text() : readFile(source, "utf8")),
      catch: () => new PublicInputFailure(),
    }),
});

export const CliLive: Layer.Layer<CliServices> = Layer.mergeAll(
  HttpLive,
  BrowserLive,
  ProcessLive,
  ConsoleLive,
  SecureConfigLive,
  PublicInputLive,
  ClockLive,
);

function readJsonResponse(
  response: Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError | HttpBody.HttpBodyError
  >,
  oversizedMessage: string,
): Effect.Effect<{ readonly status: number; readonly body: unknown }, HttpFailure> {
  return response.pipe(
    Effect.flatMap((value) =>
      value.text.pipe(
        Effect.flatMap((text) =>
          text.length > MAX_DEVICE_RESPONSE_SIZE
            ? Effect.fail(
                new HttpFailure({ cause: new Error(oversizedMessage) }),
              )
            : Effect.try({
                try: () => ({
                  status: value.status,
                  body: text === "" ? {} : JSON.parse(text),
                }),
                catch: (cause) => new HttpFailure({ cause }),
              }),
        ),
      ),
    ),
    Effect.mapError((cause) =>
      cause instanceof HttpFailure ? cause : new HttpFailure({ cause }),
    ),
  );
}

function readConfig(
  path: string,
): Effect.Effect<Record<string, unknown>, unknown> {
  return Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      isNotFound(cause) ? Effect.succeed("{}") : Effect.fail(cause),
    ),
    Effect.flatMap((raw) =>
      Effect.try({
        try: (): unknown => JSON.parse(raw),
        catch: (cause) => cause,
      }).pipe(
        Effect.flatMap((value) =>
          isRecord(value)
            ? Effect.succeed(value)
            : Effect.fail(
                new ConfigParseFailure({
                  cause: new Error("Akua config must be a JSON object."),
                }),
              ),
        ),
      ),
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
    yield* Effect.tryPromise({
      try: () => mkdir(directory, { recursive: true, mode: CONFIG_DIR_MODE }),
      catch: (cause) => cause,
    });
    yield* Effect.tryPromise({
      try: () => chmod(directory, CONFIG_DIR_MODE),
      catch: (cause) => cause,
    });
    yield* Effect.tryPromise({
      try: () =>
        writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
          mode: CONFIG_FILE_MODE,
          flag: "wx",
        }),
      catch: (cause) => cause,
    });
    yield* Effect.tryPromise({
      try: () => chmod(temporary, CONFIG_FILE_MODE),
      catch: (cause) => cause,
    });
    yield* Effect.tryPromise({
      try: () => rename(temporary, path),
      catch: (cause) => cause,
    });
    yield* Effect.tryPromise({
      try: () => chmod(path, CONFIG_FILE_MODE),
      catch: (cause) => cause,
    });
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
