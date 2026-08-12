import { Console, Effect, Option, Runtime } from "effect";
import { Argument, Command } from "effect/unstable/cli";

import { ScriptEnvironment, ScriptFiles, ScriptHttp } from "./runtime/services";
import { ScriptCliLive } from "./runtime/cli-live";
import { ScriptLive } from "./runtime/services-live";

export const DEFAULT_OPENAPI_URL = "https://api.akua.dev/v1/openapi.json";
export const DEFAULT_OUTPUT_PATH = "openapi/public.json";

export function resolveSpecUrl(
  input: string | undefined,
  env: Record<string, string | undefined> = {},
): URL {
  const raw = input ?? env.AKUA_OPENAPI_URL ?? DEFAULT_OPENAPI_URL;
  const url = new URL(raw);
  if (url.protocol !== "https:")
    throw new Error(`OpenAPI URL must use https: ${url.href}`);
  return url;
}

export function fetchOpenApi(
  url: URL,
  outputPath = DEFAULT_OUTPUT_PATH,
): Effect.Effect<void, Error, ScriptHttp | ScriptFiles> {
  return Effect.gen(function* () {
    const http = yield* ScriptHttp;
    const files = yield* ScriptFiles;
    const spec = yield* http.getJson(url).pipe(Effect.mapError(toError));
    const valid = yield* Effect.try({
      try: () => validateOpenApiDocument(spec),
      catch: toError,
    });
    yield* files
      .writeText(outputPath, `${JSON.stringify(valid, null, 2)}\n`)
      .pipe(Effect.mapError(toError));
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
      const url = yield* Effect.try({
        try: () =>
          resolveSpecUrl(Option.getOrUndefined(input), {
            AKUA_OPENAPI_URL: openApiUrl,
          }),
        catch: toError,
      });
      yield* fetchOpenApi(url);
      yield* Console.error(
        `Fetched OpenAPI spec from ${url.href} into ${DEFAULT_OUTPUT_PATH}`,
      );
    }),
).pipe(Command.withDescription("Fetch the public OpenAPI document"));

export function validateOpenApiDocument(
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("OpenAPI response is not an object");
  if (typeof value.openapi !== "string" || !value.openapi.startsWith("3."))
    throw new Error("OpenAPI response must be OpenAPI 3.x");
  if (!isRecord(value.paths))
    throw new Error("OpenAPI response is missing paths");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
