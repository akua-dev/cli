import { expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveBunBinary } from "./bun-binary";

it.effect(
  "patched Effect generator preserves headers and SSE contracts without warnings",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "akua-effect-generator-",
      });
      const specPath = path.join(directory, "public.json");
      const outputPath = path.join(directory, "public-api.gen.ts");

      yield* fs.writeFileString(specPath, JSON.stringify(specification()));
      const handle = yield* spawner.spawn(
        ChildProcess.make(resolveBunBinary(), [
          "x",
          "--no-install",
          "openapigen",
          "--spec",
          specPath,
          "--format",
          "httpapi",
          "--name",
          "PublicApi",
        ]),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );

      expect(exitCode).toBe(ChildProcessSpawner.ExitCode(0));
      expect(stderr).not.toContain("warning");
      yield* fs.writeFileString(outputPath, stdout);
      const output = yield* fs.readFileString(outputPath);
      expect(output).toContain("HttpApiSchema.WithHeaders");
      expect(output).toContain("WidgetsCreate201Headers");
      expect(output).toContain("HttpApiSchema.StreamSse({ events:");
      expect(output).toContain(
        "payload: [WidgetsCreateRequestJson, HttpApiSchema.NoContent]",
      );
      expect(output).toContain("readonly [x: string]: Schema.Json | undefined");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "patched Effect client preserves optional multipart as FormData or void",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const clientTypes = yield* fs.readFileString(
        "node_modules/effect/dist/unstable/httpapi/HttpApiEndpoint.d.ts",
      );

      expect(clientTypes).toContain('Extract<Payload["Type"], Brand<');
      expect(clientTypes).toContain('Exclude<Payload["Type"], Brand<');
    }).pipe(Effect.provide(NodeServices.layer)),
);

function specification() {
  return {
    openapi: "3.1.0",
    info: { title: "Patch fixture", version: "1.0.0" },
    paths: {
      "/widgets": {
        post: {
          operationId: "widgets.create",
          tags: ["Widgets"],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { name: { type: "string" } },
                },
              },
            },
          },
          responses: {
            201: {
              description: "Created",
              headers: {
                Location: { required: true, schema: { type: "string" } },
              },
            },
          },
        },
      },
      "/logs": {
        get: {
          operationId: "installs.getLogs",
          tags: ["Installs"],
          responses: {
            200: {
              description: "Logs",
              content: {
                "text/event-stream": {
                  schema: {
                    type: "object",
                    properties: {
                      event: { type: "string" },
                      data: { type: "string" },
                    },
                    required: ["event", "data"],
                  },
                  "x-effect-stream": { encoding: "sse" },
                },
              },
            },
          },
        },
      },
      "/metadata": {
        get: {
          operationId: "metadata.get",
          tags: ["Metadata"],
          responses: {
            200: {
              description: "Metadata",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { label: { type: "string" } },
                    additionalProperties: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}
