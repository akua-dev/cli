import { Effect, Runtime } from "effect";

import { ScriptFiles, ScriptHttp } from "./runtime/services";
import { ScriptLive } from "./runtime/services-live";

export const DEFAULT_OPENAPI_URL = "https://api.akua.dev/v1/openapi.json";
export const DEFAULT_OUTPUT_PATH = "openapi/public.json";

export function resolveSpecUrl(input: string | undefined, env: Record<string, string | undefined> = {}): URL {
  const raw = input ?? env.AKUA_OPENAPI_URL ?? DEFAULT_OPENAPI_URL;
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error(`OpenAPI URL must use https: ${url.href}`);
  return url;
}

export function fetchOpenApi(url: URL, outputPath = DEFAULT_OUTPUT_PATH): Effect.Effect<void, Error, ScriptHttp | ScriptFiles> {
  return Effect.gen(function* () {
    const http = yield* ScriptHttp;
    const files = yield* ScriptFiles;
    const spec = yield* http.getJson(url).pipe(Effect.mapError(toError));
    const valid = yield* Effect.try({ try: () => validateOpenApiDocument(spec), catch: toError });
    yield* files.writeText(outputPath, `${JSON.stringify(valid, null, 2)}\n`).pipe(Effect.mapError(toError));
  });
}

export function validateOpenApiDocument(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("OpenAPI response is not an object");
  if (typeof value.openapi !== "string" || !value.openapi.startsWith("3.")) throw new Error("OpenAPI response must be OpenAPI 3.x");
  if (!isRecord(value.paths)) throw new Error("OpenAPI response is missing paths");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function toError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }

if (import.meta.main) {
  Runtime.makeRunMain(({ fiber, teardown }) => {
    fiber.addObserver((exit) => teardown(exit, (code) => { process.exitCode = code; }));
  })(Effect.try({ try: () => resolveSpecUrl(process.argv[2], process.env), catch: toError }).pipe(
    Effect.flatMap((url) => fetchOpenApi(url).pipe(Effect.tap(() => Effect.sync(() => console.error(`Fetched OpenAPI spec from ${url.href} into ${DEFAULT_OUTPUT_PATH}`))))),
    Effect.provide(ScriptLive),
  ));
}
