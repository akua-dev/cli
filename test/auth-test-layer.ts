import { Duration, Effect, Layer } from "effect";

import { authView } from "../src/commands/auth";
import {
  DeviceCancelledFailure,
  DeviceRequestFailure,
  toCliError,
  type CliFailure,
} from "../src/runtime/effect-runtime";
import type { RenderEnvelope } from "../src/runtime/render";
import {
  Browser,
  BrowserFailure,
  CliClock,
  Console,
  Http,
  HttpFailure,
  Process,
  SecureConfigLive,
} from "../src/runtime/services";

export interface AuthTestDependencies {
  request(request: {
    url: string;
    body: unknown;
    signal?: AbortSignal;
  }): Promise<{ status: number; body: unknown }>;
  sleep(milliseconds: number): Promise<void>;
  launchBrowser(url: string): Promise<void>;
  displayDeviceAuthorization?(details: {
    verification_uri_complete: string;
    user_code: string;
  }): void;
  now?(): number;
  signal?: AbortSignal;
}

export function runAuthView(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  dependencies: AuthTestDependencies,
): Promise<RenderEnvelope> {
  if (dependencies.signal?.aborted)
    return Promise.reject(toCliError(new DeviceCancelledFailure()));
  return Effect.runPromise(
    authView(argv, env).pipe(
      Effect.catchIf(
        (failure): failure is DeviceRequestFailure =>
          dependencies.signal?.aborted === true &&
          failure._tag === "DeviceRequestFailure",
        () => Effect.fail(new DeviceCancelledFailure()),
      ),
      Effect.mapError(toCliError),
      Effect.provide(testServices(dependencies)),
    ) as Effect.Effect<RenderEnvelope, never>,
  );
}

function testServices(dependencies: AuthTestDependencies) {
  const now = dependencies.now ?? Date.now;
  return Layer.mergeAll(
    Layer.succeed(Http, {
      postForm: ({ url, fields }) =>
        Effect.tryPromise({
          try: () =>
            dependencies.request({
              url,
              body: fields,
              signal: dependencies.signal,
            }),
          catch: (cause) => new HttpFailure({ cause }),
        }),
    }),
    Layer.succeed(Browser, {
      launch: (url) =>
        Effect.tryPromise({
          try: () => dependencies.launchBrowser(url),
          catch: (cause) => new BrowserFailure({ cause }),
        }),
    }),
    Layer.succeed(Process, {
      awaitSignal: dependencies.signal?.aborted ? Effect.void : Effect.never,
    }),
    Layer.succeed(Console, {
      stdoutIsTTY: false,
      writeStderr: (value) =>
        Effect.sync(() => {
          const [open, code] = value.trimEnd().split("\n");
          dependencies.displayDeviceAuthorization?.({
            verification_uri_complete: open.slice("Open ".length),
            user_code: code.slice("Enter code: ".length),
          });
        }),
      writeStdout: () => Effect.void,
    }),
    Layer.succeed(CliClock, {
      currentTimeMillis: Effect.sync(now),
      sleep: (duration) =>
        Effect.tryPromise({
          try: () => dependencies.sleep(Duration.toMillis(duration)),
          catch: () => new DeviceRequestFailure(),
        }).pipe(Effect.orDie),
    }),
    SecureConfigLive,
  );
}
