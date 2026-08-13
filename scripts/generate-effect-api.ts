import * as OpenApiGenerator from "@effect/openapi-generator/OpenApiGenerator";
import { Cause, Data, Effect, Runtime } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { OpenAPISpec } from "effect/unstable/httpapi/OpenApi";

import {
  ScriptFiles,
  ScriptHostFailure,
  ScriptValidationFailure,
} from "./runtime/services";
import { ScriptCliLive } from "./runtime/cli-live";
import { ScriptLive } from "./runtime/services-live";

export const OPENAPI_SPEC_PATH = "openapi/public.json";
export const EFFECT_API_OUTPUT_PATH = "src/generated/openapi-api.gen.ts";

export class EffectApiGenerationFailure extends Data.TaggedError(
  "EffectApiGenerationFailure",
)<{
  readonly message: string;
}> {}

export function generateEffectApi(
  specPath = OPENAPI_SPEC_PATH,
  outputPath = EFFECT_API_OUTPUT_PATH,
): Effect.Effect<
  string,
  ScriptHostFailure | ScriptValidationFailure | EffectApiGenerationFailure,
  ScriptFiles
> {
  return Effect.gen(function* () {
    const files = yield* ScriptFiles;
    const generated = yield* generateEffectApiSource(specPath);
    yield* files.writeText(outputPath, generated);
    return generated;
  });
}

export function checkEffectApi(
  specPath = OPENAPI_SPEC_PATH,
  outputPath = EFFECT_API_OUTPUT_PATH,
): Effect.Effect<
  void,
  ScriptHostFailure | ScriptValidationFailure | EffectApiGenerationFailure,
  ScriptFiles
> {
  return Effect.gen(function* () {
    const files = yield* ScriptFiles;
    const generated = yield* generateEffectApiSource(specPath);
    const current = yield* files.readText(outputPath);
    if (current !== generated)
      return yield* Effect.fail(
        new EffectApiGenerationFailure({
          message: `${outputPath} is out of date. Run: bun scripts/generate-effect-api.ts`,
        }),
      );
  });
}

function generateEffectApiSource(
  specPath: string,
): Effect.Effect<
  string,
  ScriptHostFailure | ScriptValidationFailure | EffectApiGenerationFailure,
  ScriptFiles
> {
  return Effect.gen(function* () {
    const files = yield* ScriptFiles;
    const contents = yield* files.readText(specPath);
    const spec = yield* parseOpenApiSpec(contents);
    const publicSpec = selectPublicOperations(spec);
    const warnings: OpenApiGenerator.OpenApiGeneratorWarning[] = [];
    const generator = yield* OpenApiGenerator.OpenApiGenerator;
    const generated = yield* generator
      .generate(publicSpec, {
        name: "PublicApi",
        format: "httpapi",
        onWarning: (warning) => {
          warnings.push(warning);
        },
      })
      .pipe(
        Effect.catchCauseIf(Cause.hasDies, (cause) =>
          Effect.fail(
            new EffectApiGenerationFailure({
              message: Cause.pretty(cause),
            }),
          ),
        ),
      );
    if (warnings.length > 0)
      return yield* Effect.fail(
        new EffectApiGenerationFailure({
          message: formatWarnings(warnings),
        }),
      );
    return normalizeGeneratedSource(generated);
  }).pipe(Effect.provide(OpenApiGenerator.layerTransformerSchema));
}

export const generateEffectApiCommand = Command.make(
  "generate-effect-api",
  {
    check: Flag.boolean("check").pipe(
      Flag.withDescription("Fail if the generated Effect API is out of date"),
    ),
  },
  ({ check }) =>
    Effect.gen(function* () {
      if (!check) {
        yield* generateEffectApi();
        return;
      }
      yield* checkEffectApi();
    }),
).pipe(Command.withDescription("Generate the typed public Effect HttpApi"));

function parseOpenApiSpec(
  contents: string,
): Effect.Effect<OpenAPISpec, ScriptValidationFailure> {
  return Effect.try({
    try: () => JSON.parse(contents),
    catch: (cause) =>
      new ScriptValidationFailure({
        message: `OpenAPI spec is not valid JSON: ${errorMessage(cause)}`,
      }),
  }).pipe(
    Effect.flatMap((value) =>
      isOpenApiSpec(value)
        ? Effect.succeed(value)
        : Effect.fail(
            new ScriptValidationFailure({
              message: "OpenAPI spec is missing required document fields",
            }),
          ),
    ),
  );
}

function isOpenApiSpec(value: unknown): value is OpenAPISpec {
  return (
    isRecord(value) &&
    value.openapi === "3.1.0" &&
    isRecord(value.info) &&
    typeof value.info.title === "string" &&
    typeof value.info.version === "string" &&
    isRecord(value.paths) &&
    isRecord(value.components) &&
    isRecord(value.components.schemas) &&
    isRecord(value.components.securitySchemes) &&
    Array.isArray(value.tags)
  );
}

function selectPublicOperations(spec: OpenAPISpec): OpenAPISpec {
  const paths: OpenAPISpec["paths"] = {};
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    const entries = Object.entries(pathItem);
    const publicOperations = entries.filter(
      ([method, operation]) =>
        isHttpMethod(method) && hasPublicVisibility(operation),
    );
    if (publicOperations.length > 0)
      paths[path] = Object.fromEntries(
        entries.filter(
          ([method, operation]) =>
            !isHttpMethod(method) || hasPublicVisibility(operation),
        ),
      );
  }
  return { ...spec, paths };
}

function hasPublicVisibility(operation: unknown): boolean {
  return isRecord(operation) && operation["x-platform-visibility"] === "PUBLIC";
}

function isHttpMethod(value: string): boolean {
  return HTTP_METHODS.has(value);
}

const HTTP_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatWarnings(
  warnings: readonly OpenApiGenerator.OpenApiGeneratorWarning[],
): string {
  return warnings
    .map(
      (warning) =>
        `${warning.code}: ${warning.method?.toUpperCase() ?? ""} ${warning.path ?? ""} ${warning.message}`,
    )
    .join("\n");
}

function normalizeGeneratedSource(source: string): string {
  return source.replace(/[ \t]+$/gm, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  Runtime.makeRunMain(({ fiber, teardown }) => {
    fiber.addObserver((exit) =>
      teardown(exit, (code) => {
        process.exitCode = code;
      }),
    );
  })(
    Command.run(generateEffectApiCommand, { version: "0.9.0" }).pipe(
      Effect.provide(ScriptLive),
      Effect.provide(ScriptCliLive),
    ),
  );
}
