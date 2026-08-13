import { Data, Effect } from "effect";

import { AkuaCliError, usageError } from "./errors";
import type { OutputMode } from "./mode";
import { renderError, renderSuccess, type RenderEnvelope } from "./render";
import { Console } from "./services";

export class UsageFailure extends Data.TaggedError("UsageFailure")<{
  readonly message: string;
}> {}

export class ConfigFailure extends Data.TaggedError("ConfigFailure")<{
  readonly operation: "read" | "write" | "remove";
  readonly path: string;
  readonly cause: unknown;
}> {}

export class DeviceRequestFailure extends Data.TaggedError(
  "DeviceRequestFailure",
)<{}> {}
export class DeviceCancelledFailure extends Data.TaggedError(
  "DeviceCancelledFailure",
)<{}> {}

export class DeviceAuthorizationFailure extends Data.TaggedError(
  "DeviceAuthorizationFailure",
)<{
  readonly reason: "access_denied" | "expired_token";
}> {}

/** Compatibility boundary for commands that have not migrated to Effect yet. */
export class CommandFailure extends Data.TaggedError("CommandFailure")<{
  readonly error: AkuaCliError;
}> {}

export type CliFailure =
  | UsageFailure
  | ConfigFailure
  | DeviceRequestFailure
  | DeviceCancelledFailure
  | DeviceAuthorizationFailure
  | CommandFailure;

export interface CliRenderer {
  readonly mode: OutputMode;
}

export function runCli<R>(
  command: Effect.Effect<RenderEnvelope, CliFailure, R>,
  renderer: CliRenderer,
): Effect.Effect<number, never, R | Console> {
  return Effect.gen(function* () {
    const console = yield* Console;
    return yield* Effect.matchEffect(command, {
      onSuccess: (envelope) =>
        console
          .writeStdout(renderSuccess(envelope, renderer.mode))
          .pipe(Effect.as(0)),
      onFailure: (failure) => {
        const error = toCliError(failure);
        return console
          .writeStdout(renderError(error, renderer.mode))
          .pipe(Effect.as(error.exitCode));
      },
    });
  });
}

export function toCliError(failure: CliFailure): AkuaCliError {
  switch (failure._tag) {
    case "UsageFailure":
      return usageError(failure.message);
    case "ConfigFailure":
      return new AkuaCliError({
        type: "runtime_error",
        code: "AKUA_CONFIG_ERROR",
        message: `Failed to ${failure.operation} Akua config at ${failure.path}: ${errorMessage(failure.cause)}`,
      });
    case "DeviceRequestFailure":
      return deviceError(
        "AKUA_DEVICE_REQUEST_FAILED",
        "Device authorization could not be completed.",
      );
    case "DeviceCancelledFailure":
      return new AkuaCliError({
        type: "runtime_error",
        code: "AKUA_DEVICE_CANCELLED",
        message: "Device authorization was cancelled.",
      });
    case "DeviceAuthorizationFailure":
      return failure.reason === "access_denied"
        ? deviceError(
            "AKUA_DEVICE_ACCESS_DENIED",
            "Device authorization was denied.",
          )
        : deviceError(
            "AKUA_DEVICE_EXPIRED_TOKEN",
            "Device authorization expired. Start login again.",
          );
    case "CommandFailure":
      return failure.error;
  }
}

function deviceError(code: string, message: string): AkuaCliError {
  return new AkuaCliError({
    type: "authentication_error",
    code,
    message,
    exitCode: 3,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
