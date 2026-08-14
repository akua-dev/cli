import { Data, Effect, Exit, Schema, SchemaIssue, Stream } from "effect";
import { HttpClientError } from "effect/unstable/http";
import type { HttpClientResponse } from "effect/unstable/http";

import {
  executeAnyPublicOperation,
  PublicOperationResponseFailure,
  type PublicOperationId,
} from "../generated/public-operation-executor.gen";
import * as Api from "../generated/openapi-api.gen";
import { PublicApiClient } from "../runtime/public-api";
import type { RenderEnvelope } from "../runtime/render";
import type { CommandDefinition } from "../runtime/registry";
import { PublicInput } from "../runtime/services";

type ApiErrorResponse = typeof Api.ApiErrorResponse.Type;

export interface PublicInputIssue {
  readonly path: readonly string[];
  readonly message: string;
}

export class GeneratedCommandFailure extends Data.TaggedError(
  "GeneratedCommandFailure",
)<{
  readonly operationId: string;
  readonly reason:
    | "usage"
    | "source"
    | "input"
    | "auth"
    | "api"
    | "response"
    | "transport";
  readonly status?: number;
  readonly apiError?: ApiErrorResponse;
  readonly command?: string;
  readonly issues?: readonly PublicInputIssue[];
  readonly inputExample?: string;
  readonly responseBody?: string;
  readonly responseMessage?: string;
}> {}

export function generatedCommandView(
  definition: CommandDefinition<PublicOperationId>,
  argv: readonly string[],
): Effect.Effect<
  RenderEnvelope<GeneratedCommandFailure>,
  GeneratedCommandFailure,
  PublicApiClient | PublicInput
> {
  return Effect.gen(function* () {
    const inputSource = yield* parseInputFlag(definition.operation_id, argv);
    const rawInput = yield* readPublicInput(definition.operation_id, inputSource);
    const input = yield* parsePublicInput(definition, rawInput);
    const client = yield* PublicApiClient;
    const result = yield* executeAnyPublicOperation(
      client,
      definition.operation_id,
      input,
    ).pipe(
      Effect.catch((failure) =>
        Effect.flatMap(describeGeneratedFailure(definition, failure), Effect.fail),
      ),
    );
    const command = `akua ${definition.command}`;
    return result._tag === "Value"
      ? { command, data: result.value }
      : {
          command,
          stream: result.stream.pipe(
            Stream.mapError((failure) =>
              mapGeneratedFailure(definition, failure),
            ),
          ),
        };
  });
}

function parseInputFlag(
  operationId: string,
  argv: readonly string[],
): Effect.Effect<string | undefined, GeneratedCommandFailure> {
  if (argv.length === 0) return Effect.succeed(undefined);
  if (argv.length !== 2 || argv[0] !== "--input" || argv[1] === "") {
    return Effect.fail(
      new GeneratedCommandFailure({ operationId, reason: "usage" }),
    );
  }
  return Effect.succeed(argv[1]);
}

function readPublicInput(
  operationId: string,
  source: string | undefined,
): Effect.Effect<string, GeneratedCommandFailure, PublicInput> {
  if (source === undefined) return Effect.succeed("{}");
  return Effect.gen(function* () {
    const input = yield* PublicInput;
    return yield* input.read(source).pipe(
      Effect.mapError(
        () => new GeneratedCommandFailure({ operationId, reason: "source" }),
      ),
    );
  });
}

function parsePublicInput(
  definition: CommandDefinition<PublicOperationId>,
  rawInput: string,
): Effect.Effect<unknown, GeneratedCommandFailure> {
  return Effect.try({
    try: () => JSON.parse(rawInput),
    catch: (cause) =>
      new GeneratedCommandFailure({
        operationId: definition.operation_id,
        reason: "input",
        command: definition.command,
        issues: [
          {
            path: [],
            message:
              cause instanceof Error
                ? `Input is not valid JSON: ${cause.message}`
                : "Input is not valid JSON",
          },
        ],
        inputExample: inputExampleFor(definition),
      }),
  });
}

const MAX_RESPONSE_BODY_CHARS = 2000;

function describeGeneratedFailure(
  definition: CommandDefinition<PublicOperationId>,
  failure: unknown,
): Effect.Effect<GeneratedCommandFailure> {
  if (
    failure instanceof PublicOperationResponseFailure &&
    failure.status !== undefined
  ) {
    const error: unknown = failure.error;
    if (
      !Schema.is(Api.ApiErrorResponse)(error) &&
      HttpClientError.isHttpClientError(error) &&
      error.response !== undefined
    ) {
      const status = failure.status;
      return enrichedApiFailure(definition, status, error.response);
    }
  }
  return Effect.succeed(mapGeneratedFailure(definition, failure));
}

function enrichedApiFailure(
  definition: CommandDefinition<PublicOperationId>,
  status: number,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<GeneratedCommandFailure> {
  return readResponseBody(response).pipe(
    Effect.map(
      (body) =>
        new GeneratedCommandFailure({
          operationId: definition.operation_id,
          reason: "api",
          status,
          responseBody: body,
          responseMessage:
            body === undefined ? undefined : extractResponseMessage(body),
        }),
    ),
  );
}

function mapGeneratedFailure(
  definition: CommandDefinition<PublicOperationId>,
  failure: unknown,
): GeneratedCommandFailure {
  const operationId = definition.operation_id;
  if (failure instanceof PublicOperationResponseFailure) {
    if (Schema.is(Api.ApiErrorResponse)(failure.error)) {
      return new GeneratedCommandFailure({
        operationId,
        reason: "api",
        status: failure.status,
        apiError: failure.error,
      });
    }
    return new GeneratedCommandFailure({
      operationId,
      reason: HttpClientError.isHttpClientError(failure.error)
        ? failure.status === undefined
          ? "transport"
          : "api"
        : "response",
      status: failure.status,
    });
  }
  if (Schema.isSchemaError(failure)) {
    return new GeneratedCommandFailure({
      operationId,
      reason: "input",
      command: definition.command,
      issues: schemaIssues(failure),
      inputExample: inputExampleFor(definition),
    });
  }
  return new GeneratedCommandFailure({
    operationId,
    reason: "input",
    command: definition.command,
    inputExample: inputExampleFor(definition),
  });
}

const formatStandardIssues = SchemaIssue.makeFormatterStandardSchemaV1();

function schemaIssues(
  error: Schema.SchemaError,
): readonly PublicInputIssue[] {
  return formatStandardIssues(error.issue).issues.map((issue) => ({
    path: (issue.path ?? []).map(pathSegmentToString),
    message: issue.message,
  }));
}

function pathSegmentToString(
  segment: PropertyKey | { readonly key: PropertyKey },
): string {
  return typeof segment === "object" ? String(segment.key) : String(segment);
}

function inputExampleFor(
  definition: CommandDefinition<PublicOperationId>,
): string {
  const sections: {
    path?: Record<string, string>;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: Record<string, never>;
  } = {};
  for (const parameter of definition.parameters) {
    if (!parameter.required) continue;
    if (parameter.in === "path") {
      (sections.path ??= {})[parameter.name] = `<${parameter.name}>`;
    } else if (parameter.in === "query") {
      (sections.query ??= {})[parameter.name] = `<${parameter.name}>`;
    } else if (parameter.in === "header") {
      (sections.headers ??= {})[parameter.name] = `<${parameter.name}>`;
    }
  }
  if (
    definition.method === "POST" ||
    definition.method === "PUT" ||
    definition.method === "PATCH"
  ) {
    sections.body = {};
  }
  return JSON.stringify(sections);
}

function readResponseBody(
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<string | undefined> {
  return response.text.pipe(
    Effect.map((body) =>
      body === ""
        ? undefined
        : body.length > MAX_RESPONSE_BODY_CHARS
          ? body.slice(0, MAX_RESPONSE_BODY_CHARS)
          : body,
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  );
}

const ResponseBodyWithMessage = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      errors: Schema.Array(Schema.Struct({ message: Schema.String })),
    }),
    Schema.Struct({ message: Schema.String }),
  ]),
);

function extractResponseMessage(body: string): string | undefined {
  const exit = Schema.decodeUnknownExit(ResponseBodyWithMessage)(body);
  if (!Exit.isSuccess(exit)) return undefined;
  const value = exit.value;
  const message = "errors" in value ? value.errors[0]?.message : value.message;
  return message === undefined || message === "" ? undefined : message;
}
