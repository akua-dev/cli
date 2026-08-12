import { Data, Effect } from "effect";

import { AkuaCliError } from "./errors";
import { renderError, renderSuccess, type RenderEnvelope } from "./render";
import type { OutputMode } from "./mode";

interface FailureFields {
  readonly error: AkuaCliError;
}

export class UsageFailure extends Data.TaggedError("UsageFailure")<FailureFields> {}
export class ConfigFailure extends Data.TaggedError("ConfigFailure")<FailureFields> {}
export class DeviceRequestFailure extends Data.TaggedError("DeviceRequestFailure")<FailureFields> {}
export class DeviceCancelledFailure extends Data.TaggedError("DeviceCancelledFailure")<FailureFields> {}
export class CommandFailure extends Data.TaggedError("CommandFailure")<FailureFields> {}

export type CliFailure =
  | UsageFailure
  | ConfigFailure
  | DeviceRequestFailure
  | DeviceCancelledFailure
  | CommandFailure;

export interface CliRenderer {
  readonly mode: OutputMode | (() => OutputMode);
  readonly writeStdout: (value: string) => void;
}

export function fail(error: AkuaCliError): Effect.Effect<never, CliFailure> {
  return Effect.fail(new CommandFailure({ error }));
}

/** The only Promise boundary for command execution and rendering. */
export async function runCli(
  command: Effect.Effect<RenderEnvelope, CliFailure>,
  renderer: CliRenderer,
): Promise<number> {
  return Effect.runPromise(Effect.matchEffect(command, {
    onSuccess: (envelope) => Effect.sync(() => {
      renderer.writeStdout(renderSuccess(envelope, rendererMode(renderer)));
      return 0;
    }),
    onFailure: ({ error }) => Effect.sync(() => {
      renderer.writeStdout(renderError(error, rendererMode(renderer)));
      return error.exitCode;
    }),
  }));
}

function rendererMode(renderer: CliRenderer): OutputMode {
  return typeof renderer.mode === "function" ? renderer.mode() : renderer.mode;
}
