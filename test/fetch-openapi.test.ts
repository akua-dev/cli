import { describe, expect, test } from "bun:test";
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
import { ScriptLive } from "../scripts/runtime/services-live";
import { cliTestLayer } from "./cli-test-layer";

describe("OpenAPI fetch guard", () => {
  test("defaults to the production public OpenAPI endpoint", () => {
    expect(Effect.runSync(resolveSpecUrl(undefined)).href).toBe(
      DEFAULT_OPENAPI_URL,
    );
  });

  test("accepts an optional OpenAPI URL positional argument", async () => {
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

    await Effect.runPromise(
      Command.runWith(fetchOpenApiCommand, { version: "test" })([
        "https://example.test/openapi.json",
      ]).pipe(
        Effect.provide(services),
        Effect.provideService(Console.Console, testConsole),
      ),
    );

    expect(requested).toBe("https://example.test/openapi.json");
  });

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

  test("writes stable output when an unchanged spec is fetched repeatedly", async () => {
    const originalFetch = globalThis.fetch;
    const root = await mkdtemp(join(process.cwd(), ".tmp-akua-openapi-"));
    const output = join(root, "public.json");
    const spec = {
      paths: { "/health": { get: { operationId: "health" } } },
      openapi: "3.1.0",
    };
    globalThis.fetch = (async () =>
      Response.json(spec)) as unknown as typeof fetch;
    try {
      await Effect.runPromise(
        Effect.provide(
          fetchOpenApi(new URL(DEFAULT_OPENAPI_URL), output),
          ScriptLive,
        ),
      );
      const first = await readFile(output, "utf8");
      await Effect.runPromise(
        Effect.provide(
          fetchOpenApi(new URL(DEFAULT_OPENAPI_URL), output),
          ScriptLive,
        ),
      );
      const second = await readFile(output, "utf8");

      expect(second).toBe(first);
      expect(second).toBe(`${JSON.stringify(spec, null, 2)}\n`);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });
});
