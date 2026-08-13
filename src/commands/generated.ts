import { Data, Effect, Schema, Stream } from "effect";
import { HttpClientError } from "effect/unstable/http";

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
    const input = yield* parsePublicInput(definition.operation_id, rawInput);
    const client = yield* PublicApiClient;
    const result = yield* executeAnyPublicOperation(
      client,
      definition.operation_id,
      input,
    ).pipe(
      Effect.mapError((failure) =>
        mapGeneratedFailure(definition.operation_id, failure),
      ),
    );
    const command = `akua ${definition.command}`;
    return result._tag === "Value"
      ? { command, data: result.value }
      : {
          command,
          stream: result.stream.pipe(
            Stream.mapError((failure) =>
              mapGeneratedFailure(definition.operation_id, failure),
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
  operationId: string,
  rawInput: string,
): Effect.Effect<unknown, GeneratedCommandFailure> {
  return Effect.try({
    try: () => JSON.parse(rawInput),
    catch: () => new GeneratedCommandFailure({ operationId, reason: "input" }),
  });
}

function mapGeneratedFailure(
  operationId: string,
  failure: unknown,
): GeneratedCommandFailure {
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
  return new GeneratedCommandFailure({ operationId, reason: "input" });
}
