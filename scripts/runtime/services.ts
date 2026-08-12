import { Context, Data, Effect } from "effect";

export class ScriptHostFailure extends Data.TaggedError("ScriptHostFailure")<{
  readonly cause: unknown;
}> {}

export class ScriptHttp extends Context.Service<
  ScriptHttp,
  {
    readonly getJson: (url: URL) => Effect.Effect<unknown, ScriptHostFailure>;
  }
>()("platform/scripts/Http") {}

export class ScriptFiles extends Context.Service<
  ScriptFiles,
  {
    readonly readText: (
      path: string,
    ) => Effect.Effect<string, ScriptHostFailure>;
    readonly writeText: (
      path: string,
      contents: string,
    ) => Effect.Effect<void, ScriptHostFailure>;
  }
>()("platform/scripts/Files") {}
