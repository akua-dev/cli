import { Console, Effect, Option, Runtime } from "effect";
import { Argument, Command } from "effect/unstable/cli";

import {
  ScriptEnvironment,
  ScriptFiles,
  ScriptHostFailure,
  ScriptHttp,
  ScriptValidationFailure,
} from "./runtime/services";
import { ScriptCliLive } from "./runtime/cli-live";
import { ScriptLive } from "./runtime/services-live";

export const DEFAULT_OPENAPI_URL = "https://api.akua.dev/v1/openapi.json";
export const DEFAULT_OUTPUT_PATH = "openapi/public.json";

export function resolveSpecUrl(
  input: string | undefined,
  env: Record<string, string | undefined> = {},
): Effect.Effect<URL, ScriptValidationFailure> {
  const raw = input ?? env.AKUA_OPENAPI_URL ?? DEFAULT_OPENAPI_URL;
  return Effect.try({
    try: () => new URL(raw),
    catch: () =>
      new ScriptValidationFailure({
        message: `OpenAPI URL is invalid: ${raw}`,
      }),
  }).pipe(
    Effect.flatMap((url) =>
      url.protocol === "https:"
        ? Effect.succeed(url)
        : Effect.fail(
            new ScriptValidationFailure({
              message: `OpenAPI URL must use https: ${url.href}`,
            }),
          ),
    ),
  );
}

export function fetchOpenApi(
  url: URL,
  outputPath = DEFAULT_OUTPUT_PATH,
): Effect.Effect<
  void,
  ScriptHostFailure | ScriptValidationFailure,
  ScriptHttp | ScriptFiles
> {
  return Effect.gen(function* () {
    const http = yield* ScriptHttp;
    const files = yield* ScriptFiles;
    const spec = yield* http.getJson(url);
    const valid = yield* validateOpenApiDocument(spec);
    yield* files.writeText(outputPath, `${JSON.stringify(valid, null, 2)}\n`);
  });
}

export const fetchOpenApiCommand = Command.make(
  "fetch-openapi",
  {
    url: Argument.string("url").pipe(
      Argument.optional,
      Argument.withDescription("Optional HTTPS OpenAPI document URL"),
    ),
  },
  ({ url: input }) =>
    Effect.gen(function* () {
      const environment = yield* ScriptEnvironment;
      const openApiUrl = yield* environment.openApiUrl;
      const url = yield* resolveSpecUrl(Option.getOrUndefined(input), {
        AKUA_OPENAPI_URL: openApiUrl,
      });
      yield* fetchOpenApi(url);
      yield* Console.error(
        `Fetched OpenAPI spec from ${url.href} into ${DEFAULT_OUTPUT_PATH}`,
      );
    }),
).pipe(Command.withDescription("Fetch the public OpenAPI document"));

export function validateOpenApiDocument(
  value: unknown,
): Effect.Effect<Record<string, unknown>, ScriptValidationFailure> {
  if (!isRecord(value)) {
    return invalidOpenApi("OpenAPI response is not an object");
  }
  if (typeof value.openapi !== "string" || !value.openapi.startsWith("3."))
    return invalidOpenApi("OpenAPI response must be OpenAPI 3.x");
  if (!isRecord(value.paths))
    return invalidOpenApi("OpenAPI response is missing paths");
  return Effect.succeed(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalidOpenApi(
  message: string,
): Effect.Effect<never, ScriptValidationFailure> {
  return Effect.fail(new ScriptValidationFailure({ message }));
}

if (import.meta.main) {
  Runtime.makeRunMain(({ fiber, teardown }) => {
    fiber.addObserver((exit) =>
      teardown(exit, (code) => {
        process.exitCode = code;
      }),
    );
  })(
    Command.run(fetchOpenApiCommand, { version: "0.9.0" }).pipe(
      Effect.provide(ScriptLive),
      Effect.provide(ScriptCliLive),
    ),
  );
}
