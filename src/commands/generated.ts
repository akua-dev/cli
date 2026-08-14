import { Cause, Data, Effect, Exit, Schema, SchemaIssue, Stream } from "effect";
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
    | "transport"
    | "internal";
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
          stream: result.stream.pipe(describeStreamFailures(definition)),
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
  const mapped = mapGeneratedFailure(definition, failure);
  if (mapped.reason !== "api" || mapped.apiError !== undefined) {
    return Effect.succeed(mapped);
  }
  const response = failureResponse(failure);
  if (response === undefined) return Effect.succeed(mapped);
  return readResponseBody(response).pipe(
    Effect.map((body) =>
      body === undefined ? mapped : withResponseDetail(mapped, body),
    ),
  );
}

function describeStreamFailures(
  definition: CommandDefinition<PublicOperationId>,
): <Value>(
  stream: Stream.Stream<Value, unknown>,
) => Stream.Stream<Value, GeneratedCommandFailure> {
  return (stream) =>
    stream.pipe(
      Stream.catchCause((cause) => {
        const failed = cause.reasons.find(Cause.isFailReason);
        if (failed === undefined) {
          // Defect/interrupt-only causes carry no failure to map; re-raise.
          return Stream.failCause(
            Cause.map(cause, (error) =>
              mapGeneratedFailure(definition, error),
            ),
          );
        }
        return Stream.unwrap(
          Effect.map(
            describeGeneratedFailure(definition, failed.error),
            Stream.fail,
          ),
        );
      }),
    );
}

function failureResponse(
  failure: unknown,
): HttpClientResponse.HttpClientResponse | undefined {
  if (!(failure instanceof PublicOperationResponseFailure)) return undefined;
  const error: unknown = failure.error;
  return HttpClientError.isHttpClientError(error) ? error.response : undefined;
}

function withResponseDetail(
  mapped: GeneratedCommandFailure,
  body: string,
): GeneratedCommandFailure {
  const apiError = decodeApiErrorBody(body);
  if (apiError !== undefined) {
    return new GeneratedCommandFailure({
      operationId: mapped.operationId,
      reason: "api",
      status: mapped.status,
      apiError,
    });
  }
  return new GeneratedCommandFailure({
    operationId: mapped.operationId,
    reason: "api",
    status: mapped.status,
    responseBody: truncateBody(body),
    responseMessage: extractResponseMessage(body),
  });
}

function mapGeneratedFailure(
  definition: CommandDefinition<PublicOperationId>,
  failure: unknown,
): GeneratedCommandFailure {
  const operationId = definition.operation_id;
  if (failure instanceof PublicOperationResponseFailure) {
    const error: unknown = failure.error;
    if (Schema.is(Api.ApiErrorResponse)(error)) {
      return new GeneratedCommandFailure({
        operationId,
        reason: "api",
        status: failure.status,
        apiError: error,
      });
    }
    if (HttpClientError.isHttpClientError(error)) {
      return new GeneratedCommandFailure({
        operationId,
        // A 2xx/3xx status means the API accepted the request; a client
        // error after that (for example a dropped stream) is transport-level.
        reason:
          failure.status !== undefined && failure.status >= 400
            ? "api"
            : "transport",
        status: failure.status,
      });
    }
    return new GeneratedCommandFailure({
      operationId,
      reason: "response",
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
  return new GeneratedCommandFailure({ operationId, reason: "internal" });
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
    body?: Readonly<Record<string, unknown>>;
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
  const body = definition.body;
  if (
    body !== undefined &&
    (body.required || Object.keys(body.example).length > 0)
  ) {
    sections.body = body.example;
  }
  return JSON.stringify(sections);
}

function readResponseBody(
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<string | undefined> {
  return response.text.pipe(
    Effect.map((body) => (body === "" ? undefined : body)),
    Effect.catch(() => Effect.succeed(undefined)),
  );
}

function truncateBody(body: string): string {
  return body.length > MAX_RESPONSE_BODY_CHARS
    ? body.slice(0, MAX_RESPONSE_BODY_CHARS)
    : body;
}

const ApiErrorResponseJson = Schema.fromJsonString(Api.ApiErrorResponse);

function decodeApiErrorBody(body: string): ApiErrorResponse | undefined {
  const exit = Schema.decodeUnknownExit(ApiErrorResponseJson)(body);
  return Exit.isSuccess(exit) ? exit.value : undefined;
}

const ErrorsEnvelopeJson = Schema.fromJsonString(
  Schema.Struct({
    errors: Schema.Array(
      Schema.Struct({ message: Schema.optionalKey(Schema.String) }),
    ),
  }),
);

const TopLevelMessageJson = Schema.fromJsonString(
  Schema.Struct({ message: Schema.String }),
);

function extractResponseMessage(body: string): string | undefined {
  const envelope = Schema.decodeUnknownExit(ErrorsEnvelopeJson)(body);
  if (Exit.isSuccess(envelope)) {
    const message = envelope.value.errors[0]?.message;
    if (message !== undefined && message !== "") return message;
  }
  const topLevel = Schema.decodeUnknownExit(TopLevelMessageJson)(body);
  if (Exit.isSuccess(topLevel) && topLevel.value.message !== "") {
    return topLevel.value.message;
  }
  return undefined;
}
