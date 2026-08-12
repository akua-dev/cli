import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Effect, Layer } from "effect";

import { ScriptFiles, ScriptHostFailure, ScriptHttp } from "./services";

export const ScriptHttpLive = Layer.succeed(ScriptHttp, {
  getJson: (url) =>
    Effect.tryPromise({
      try: () =>
        fetch(url).then((response) => {
          if (!response.ok)
            throw new Error(
              `OpenAPI fetch failed with ${response.status} ${response.statusText}`,
            );
          return response.json();
        }),
      catch: (cause) => new ScriptHostFailure({ cause }),
    }),
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
