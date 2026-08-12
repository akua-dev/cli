import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Effect, Layer } from "effect";

import { ScriptFiles, ScriptHostFailure, ScriptHttp } from "./services";

export const ScriptHttpLive = Layer.succeed(ScriptHttp, {
  getJson: (url) =>
    Effect.tryPromise({
      try: () => fetch(url),
      catch: (cause) => new ScriptHostFailure({ cause }),
    }).pipe(
      Effect.flatMap((response) =>
        response.ok
          ? Effect.tryPromise({
              try: () => response.json(),
              catch: (cause) => new ScriptHostFailure({ cause }),
            })
          : Effect.fail(
              new ScriptHostFailure({
                cause: new Error(
                  `OpenAPI fetch failed with ${response.status} ${response.statusText}`,
                ),
              }),
            ),
      ),
    ),
});

export const ScriptFilesLive = Layer.succeed(ScriptFiles, {
  readText: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => new ScriptHostFailure({ cause }),
    }),
  writeText: (path, contents) =>
    Effect.tryPromise({
      try: () =>
        mkdir(dirname(path), { recursive: true }).then(() =>
          writeFile(path, contents),
        ),
      catch: (cause) => new ScriptHostFailure({ cause }),
    }),
});

export const ScriptLive = Layer.merge(ScriptHttpLive, ScriptFilesLive);
