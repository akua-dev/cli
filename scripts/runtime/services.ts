import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Context, Data, Effect, Layer } from "effect";

export class ScriptHostFailure extends Data.TaggedError("ScriptHostFailure")<{
  readonly cause: unknown;
}> {}

export class ScriptHttp extends Context.Service<ScriptHttp, {
  readonly getJson: (url: URL) => Effect.Effect<unknown, ScriptHostFailure>;
}>()("platform/scripts/Http") {}

export class ScriptFiles extends Context.Service<ScriptFiles, {
  readonly readText: (path: string) => Effect.Effect<string, ScriptHostFailure>;
  readonly writeText: (path: string, contents: string) => Effect.Effect<void, ScriptHostFailure>;
}>()("platform/scripts/Files") {}

export const ScriptHttpLive = Layer.succeed(ScriptHttp, {
  getJson: (url) => Effect.tryPromise({
    try: () => fetch(url).then((response) => {
      if (!response.ok) throw new Error(`OpenAPI fetch failed with ${response.status} ${response.statusText}`);
      return response.json();
    }),
    catch: (cause) => new ScriptHostFailure({ cause }),
  }),
});

export const ScriptFilesLive = Layer.succeed(ScriptFiles, {
  readText: (path) => Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => new ScriptHostFailure({ cause }),
  }),
  writeText: (path, contents) => Effect.tryPromise({
    try: () => mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, contents)),
    catch: (cause) => new ScriptHostFailure({ cause }),
  }),
});

export const ScriptLive = Layer.merge(ScriptHttpLive, ScriptFilesLive);
