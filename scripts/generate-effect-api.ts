import * as OpenApiGenerator from "@effect/openapi-generator/OpenApiGenerator";
import * as GeneratorUtils from "@effect/openapi-generator/Utils";
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
export const PUBLIC_OPERATION_EXECUTOR_OUTPUT_PATH =
  "src/generated/public-operation-executor.gen.ts";

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
    const artifacts = yield* generateEffectArtifacts(specPath);
    yield* files.writeText(outputPath, artifacts.api);
    yield* files.writeText(
      PUBLIC_OPERATION_EXECUTOR_OUTPUT_PATH,
      artifacts.executor,
    );
    return artifacts.api;
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
    const artifacts = yield* generateEffectArtifacts(specPath);
    const currentApi = yield* files.readText(outputPath);
    const currentExecutor = yield* files.readText(
      PUBLIC_OPERATION_EXECUTOR_OUTPUT_PATH,
    );
    if (currentApi !== artifacts.api || currentExecutor !== artifacts.executor)
      return yield* Effect.fail(
        new EffectApiGenerationFailure({
          message: `Generated public API artifacts are out of date. Run: bun scripts/generate-effect-api.ts`,
        }),
      );
  });
}

interface EffectArtifacts {
  readonly api: string;
  readonly executor: string;
}

function generateEffectArtifacts(
  specPath: string,
): Effect.Effect<
  EffectArtifacts,
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
    const api = normalizeGeneratedSource(generated);
    const executor = yield* renderPublicOperationExecutor(publicSpec, api);
    return { api, executor };
  }).pipe(Effect.provide(OpenApiGenerator.layerTransformerSchema));
}

interface PublicOperation {
  readonly operationId: string;
  readonly group: string;
  readonly endpoint: string;
  readonly schemaBase: string;
  readonly hasPath: boolean;
  readonly hasQuery: boolean;
  readonly hasHeaders: boolean;
  readonly hasBody: boolean;
  readonly bodyRequired: boolean;
  readonly isStream: boolean;
}

function renderPublicOperationExecutor(
  spec: OpenAPISpec,
  apiSource: string,
): Effect.Effect<string, EffectApiGenerationFailure> {
  return collectPublicOperations(spec).pipe(
    Effect.flatMap((operations) =>
      validateExecutorSchemas(operations, apiSource).pipe(
        Effect.as(renderExecutorSource(operations)),
      ),
    ),
  );
}

function collectPublicOperations(
  spec: OpenAPISpec,
): Effect.Effect<readonly PublicOperation[], EffectApiGenerationFailure> {
  return Effect.gen(function* () {
    const operations: PublicOperation[] = [];
    for (const pathItem of Object.values(spec.paths)) {
      if (!isRecord(pathItem)) continue;
      const pathParameters = readParameters(
        readRecordField(pathItem, "parameters"),
      );
      for (const [method, value] of Object.entries(pathItem)) {
        if (!isHttpMethod(method) || !hasPublicVisibility(value)) continue;
        if (!isRecord(value) || typeof value.operationId !== "string") {
          return yield* executorGenerationFailure(
            "Every public operation must declare an operationId.",
          );
        }
        const operationParameters = readParameters(value.parameters);
        const parameterLocations = new Set(
          [...pathParameters, ...operationParameters].map(
            (parameter) => parameter.location,
          ),
        );
        const group = readFirstString(value.tags) ?? "default";
        operations.push({
          operationId: value.operationId,
          group,
          endpoint: GeneratorUtils.camelize(value.operationId),
          schemaBase: GeneratorUtils.identifier(value.operationId),
          hasPath: parameterLocations.has("path"),
          hasQuery: parameterLocations.has("query"),
          hasHeaders: parameterLocations.has("header"),
          hasBody: isRecord(value.requestBody),
          bodyRequired:
            isRecord(value.requestBody) && value.requestBody.required === true,
          isStream: hasStreamResponse(value.responses),
        });
      }
    }
    return operations.sort((left, right) =>
      left.operationId.localeCompare(right.operationId),
    );
  });
}

interface RequestParameter {
  readonly location: string;
}

function readParameters(value: unknown): readonly RequestParameter[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .filter((parameter) => typeof parameter.in === "string")
    .map((parameter) => ({ location: String(parameter.in) }));
}

function readRecordField(value: unknown, field: string): unknown {
  return isRecord(value) ? value[field] : undefined;
}

function readFirstString(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const first = value[0];
  return typeof first === "string" ? first : undefined;
}

function hasStreamResponse(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([status, response]) =>
      /^2\d\d$/.test(status) &&
      isRecord(response) &&
      isRecord(response.content) &&
      Object.values(response.content).some(
        (media) => isRecord(media) && isRecord(media["x-effect-stream"]),
      ),
  );
}

function validateExecutorSchemas(
  operations: readonly PublicOperation[],
  apiSource: string,
): Effect.Effect<void, EffectApiGenerationFailure> {
  for (const operation of operations) {
    for (const schema of operationSchemaNames(operation)) {
      if (!apiSource.includes(`export const ${schema} =`)) {
        return executorGenerationFailure(
          `Generated API is missing request schema ${schema} for ${operation.operationId}.`,
        );
      }
    }
  }
  return Effect.void;
}

function operationSchemaNames(
  operation: PublicOperation,
): readonly string[] {
  const names: string[] = [];
  if (operation.hasPath) names.push(`${operation.schemaBase}PathParams`);
  if (operation.hasQuery) names.push(`${operation.schemaBase}Query`);
  if (operation.hasHeaders) names.push(`${operation.schemaBase}Headers`);
  if (operation.hasBody) names.push(`${operation.schemaBase}RequestJson`);
  return names;
}

function renderExecutorSource(operations: readonly PublicOperation[]): string {
  const operationIds = operations
    .map((operation) => `  | ${JSON.stringify(operation.operationId)}`)
    .join("\n");
  const effects = operations
    .map(
      (operation) =>
        `  readonly ${JSON.stringify(operation.operationId)}: WithCommandFailure<ReturnType<PublicApiClientValue["client"][${JSON.stringify(operation.group)}][${JSON.stringify(operation.endpoint)}]>>;`,
    )
    .join("\n");
  const cases = operations.map(renderOperationCase).join("\n");
  return `// Generated by scripts/generate-effect-api.ts. Do not edit by hand.
import { Data, Effect, Ref, Schema, SchemaIssue, Stream } from "effect";
import type * as SchemaAST from "effect/SchemaAST";

import * as Api from "./openapi-api.gen";
import type { PublicApiClientValue } from "../runtime/public-api";

export type PublicOperationId =
${operationIds};

export interface PublicOperationInput {
  readonly path?: unknown;
  readonly query?: unknown;
  readonly headers?: unknown;
  readonly body?: unknown;
}

type WithCommandFailure<Value> = Value extends Effect.Effect<
  infer Success,
  infer Failure,
  infer Requirements
>
  ? Effect.Effect<
      Success,
      PublicOperationResponseFailure<Failure> | Schema.SchemaError,
      Requirements
    >
  : never;

export interface PublicOperationEffectMap {
${effects}
}

export type PublicOperationCommandResult =
  | { readonly _tag: "Value"; readonly value: unknown }
  | {
      readonly _tag: "Stream";
      readonly stream: Stream.Stream<
        unknown,
        PublicOperationResponseFailure<unknown>,
        never
      >;
    };

export class UnknownPublicOperationFailure extends Data.TaggedError(
  "UnknownPublicOperationFailure",
)<{ readonly operationId: string }> {}

export class PublicOperationResponseFailure<Failure> extends Data.TaggedError(
  "PublicOperationResponseFailure",
)<{
  readonly status?: number;
  readonly error: Failure;
}> {}

const strictParseOptions = {
  onExcessProperty: "error",
} satisfies SchemaAST.ParseOptions;

function atEnvelopeKey<Value, Requirements>(
  key: "path" | "query" | "headers" | "body",
  effect: Effect.Effect<Value, Schema.SchemaError, Requirements>,
): Effect.Effect<Value, Schema.SchemaError, Requirements> {
  return Effect.mapError(
    effect,
    (error) =>
      new Schema.SchemaError(new SchemaIssue.Pointer([key], error.issue)),
  );
}

export function executePublicOperation<OperationId extends PublicOperationId>(
  client: PublicApiClientValue,
  operationId: OperationId,
  input: unknown,
): PublicOperationEffectMap[OperationId];
export function executePublicOperation(
  client: PublicApiClientValue,
  operationId: PublicOperationId,
  rawInput: unknown,
): Effect.Effect<unknown, unknown, never> {
  return executeOperation(client, operationId, rawInput, "raw");
}

export function executeAnyPublicOperation(
  client: PublicApiClientValue,
  operationId: PublicOperationId,
  rawInput: unknown,
): Effect.Effect<PublicOperationCommandResult, unknown, never>;
export function executeAnyPublicOperation(
  client: PublicApiClientValue,
  operationId: PublicOperationId,
  rawInput: unknown,
): Effect.Effect<unknown, unknown, never> {
  return executeOperation(client, operationId, rawInput, "command");
}

function executeOperation(
  client: PublicApiClientValue,
  operationId: PublicOperationId,
  rawInput: unknown,
  mode: "raw" | "command",
): Effect.Effect<unknown, unknown, never> {
  switch (operationId) {
${cases}
  }
  return Effect.fail(new UnknownPublicOperationFailure({ operationId }));
}

function executeClientOperation<Success, Failure, Requirements>(
  client: PublicApiClientValue,
  operation: Effect.Effect<Success, Failure, Requirements>,
): Effect.Effect<
  Success,
  PublicOperationResponseFailure<Failure>,
  Requirements
> {
  return client.semaphore.withPermit(
    Ref.set(client.responseStatus, undefined).pipe(
      Effect.andThen(operation),
      Effect.catch((error) =>
        Ref.get(client.responseStatus).pipe(
          Effect.flatMap((status) =>
            Effect.fail(
              new PublicOperationResponseFailure({ status, error }),
            ),
          ),
        ),
      ),
    ),
  );
}
`;
}

function renderOperationCase(operation: PublicOperation): string {
  const decoders = [renderOperationInputDecoder(operation)];
  const request: string[] = [];
  if (operation.hasPath) {
    decoders.push(renderPartDecoder(operation, "path", "path"));
    request.push("params: path");
  }
  if (operation.hasQuery) {
    decoders.push(renderPartDecoder(operation, "query", "query"));
    request.push("query");
  }
  if (operation.hasHeaders) {
    decoders.push(renderPartDecoder(operation, "headers", "headers"));
    request.push("headers");
  }
  if (operation.hasBody) {
    decoders.push(renderPartDecoder(operation, "body", "payload"));
    request.push("payload");
  }
  const call = `client.client[${JSON.stringify(operation.group)}][${JSON.stringify(operation.endpoint)}]`;
  const invocation =
    request.length === 0
      ? `${call}()`
      : `${call}({ ${request.join(", ")} })`;
  const result = operation.isStream
    ? `        const stream = yield* executeClientOperation(client, ${invocation});\n        if (mode === "raw") return stream;\n        const status = yield* Ref.get(client.responseStatus);\n        return {\n          _tag: "Stream",\n          stream: stream.pipe(\n            Stream.mapError(\n              (error) =>\n                new PublicOperationResponseFailure({ status, error }),\n            ),\n          ),\n        };`
    : `        const value = yield* executeClientOperation(client, ${invocation});\n        return mode === "raw" ? value : { _tag: "Value", value };`;
  return `    case ${JSON.stringify(operation.operationId)}:\n      return Effect.gen(function* () {\n${decoders.join("\n")}\n${result}\n      });`;
}

function renderOperationInputDecoder(operation: PublicOperation): string {
  const fields: string[] = [];
  if (operation.hasPath) fields.push("path: Schema.optionalKey(Schema.Unknown)");
  if (operation.hasQuery) fields.push("query: Schema.optionalKey(Schema.Unknown)");
  if (operation.hasHeaders)
    fields.push("headers: Schema.optionalKey(Schema.Unknown)");
  if (operation.hasBody) fields.push("body: Schema.optionalKey(Schema.Unknown)");
  return `        const input = yield* Schema.decodeUnknownEffect(\n          Schema.Struct({ ${fields.join(", ")} }),\n          strictParseOptions,\n        )(rawInput);`;
}

function renderPartDecoder(
  operation: PublicOperation,
  part: "path" | "query" | "headers" | "body",
  localName: string,
): string {
  const suffix =
    part === "path"
      ? "PathParams"
      : part === "query"
        ? "Query"
        : part === "headers"
          ? "Headers"
          : "RequestJson";
  const fallback = part === "body" ? "" : " ?? {}";
  if (part === "body" && !operation.bodyRequired) {
    return `        const ${localName} = input.body === undefined\n          ? undefined\n          : yield* atEnvelopeKey("body", Schema.decodeUnknownEffect(\n              Api.${operation.schemaBase}${suffix},\n              strictParseOptions,\n            )(input.body));`;
  }
  return `        const ${localName} = yield* atEnvelopeKey(${JSON.stringify(part)}, Schema.decodeUnknownEffect(\n          Api.${operation.schemaBase}${suffix},\n          strictParseOptions,\n        )(input.${part}${fallback}));`;
}

function executorGenerationFailure(
  message: string,
): Effect.Effect<never, EffectApiGenerationFailure> {
  return Effect.fail(new EffectApiGenerationFailure({ message }));
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
