import { describe, expect, it, test } from "@effect/vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Console, Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";

import {
  DEFAULT_OPENAPI_URL,
  fetchOpenApi,
  fetchOpenApiCommand,
  resolveSpecUrl,
  validateOpenApiDocument,
} from "../scripts/fetch-openapi";
import {
  ScriptEnvironment,
  ScriptFiles,
  ScriptHttp,
} from "../scripts/runtime/services";
import { ScriptFilesLive } from "../scripts/runtime/services-live";
import { cliTestLayer } from "./cli-test-layer";

describe("OpenAPI fetch guard", () => {
  test("defaults to the production public OpenAPI endpoint", () => {
    expect(Effect.runSync(resolveSpecUrl(undefined)).href).toBe(
      DEFAULT_OPENAPI_URL,
    );
  });

  it.effect("accepts an optional OpenAPI URL positional argument", () =>
    Effect.gen(function* () {
      let requested = "";
      const services = Layer.mergeAll(
        cliTestLayer,
        Layer.succeed(ScriptHttp, {
          getJson: (url) =>
            Effect.sync(() => {
              requested = url.href;
              return { openapi: "3.1.0", paths: {} };
            }),
        }),
        Layer.succeed(ScriptFiles, {
          readText: () => Effect.succeed(""),
          writeText: () => Effect.void,
        }),
        Layer.succeed(ScriptEnvironment, {
          openApiUrl: Effect.succeed(undefined),
        }),
      );
      const testConsole = Object.assign(Object.create(console), {
        error: () => {},
      }) as Console.Console;

      yield* Command.runWith(fetchOpenApiCommand, { version: "test" })([
        "https://example.test/openapi.json",
      ]).pipe(
        Effect.provide(services),
        Effect.provideService(Console.Console, testConsole),
      );

      expect(requested).toBe("https://example.test/openapi.json");
    }),
  );

  test("rejects non-https URLs", () => {
    expect(() =>
      Effect.runSync(resolveSpecUrl("http://api.akua.dev/v1/openapi.json")),
    ).toThrow("https");
  });

  test("validates the minimum OpenAPI document shape", () => {
    expect(() =>
      Effect.runSync(validateOpenApiDocument({ openapi: "3.1.0", paths: {} })),
    ).not.toThrow();
    expect(() =>
      Effect.runSync(validateOpenApiDocument({ openapi: "2.0", paths: {} })),
    ).toThrow("OpenAPI 3.x");
  });

  it.effect(
    "writes stable output when an unchanged spec is fetched repeatedly",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          mkdtemp(join(process.cwd(), ".tmp-akua-openapi-")),
        );
        const output = join(root, "public.json");
        const spec = {
          paths: { "/health": { get: { operationId: "health" } } },
          openapi: "3.1.0",
        };
        // Test double for the ScriptHttp service (the seam fetchOpenApi
        // already depends on), paired with the real ScriptFilesLive so this
        // test still exercises real disk writes/reads for the stable-output
        // assertion. No global fetch mutation, no unsafe cast.
        const services = Layer.mergeAll(
          Layer.succeed(ScriptHttp, {
            getJson: () => Effect.succeed(spec),
          }),
          ScriptFilesLive,
        );

        yield* Effect.gen(function* () {
          yield* Effect.provide(
            fetchOpenApi(new URL(DEFAULT_OPENAPI_URL), output),
            services,
          );
          const first = yield* Effect.promise(() => readFile(output, "utf8"));
          yield* Effect.provide(
            fetchOpenApi(new URL(DEFAULT_OPENAPI_URL), output),
            services,
          );
          const second = yield* Effect.promise(() => readFile(output, "utf8"));

          expect(second).toBe(first);
          expect(second).toBe(`${JSON.stringify(spec, null, 2)}\n`);
        }).pipe(
          Effect.ensuring(
            Effect.promise(() => rm(root, { recursive: true, force: true })),
          ),
        );
      }),
  );
});
