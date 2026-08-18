import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveBunBinary } from "./bun-binary";

test("patched Effect generator preserves headers and SSE contracts without warnings", () => {
  const directory = mkdtempSync(join(tmpdir(), "akua-effect-generator-"));
  const specPath = join(directory, "public.json");
  const outputPath = join(directory, "public-api.gen.ts");

  try {
    writeFileSync(specPath, JSON.stringify(specification()));
    const result = spawnSync(
      resolveBunBinary(),
      [
        "x",
        "--no-install",
        "openapigen",
        "--spec",
        specPath,
        "--format",
        "httpapi",
        "--name",
        "PublicApi",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("warning");
    writeFileSync(outputPath, result.stdout);
    const output = readFileSync(outputPath, "utf8");
    expect(output).toContain("HttpApiSchema.WithHeaders");
    expect(output).toContain("WidgetsCreate201Headers");
    expect(output).toContain("HttpApiSchema.StreamSse({ events:");
    expect(output).toContain(
      "payload: [WidgetsCreateRequestJson, HttpApiSchema.NoContent]",
    );
    expect(output).toContain("readonly [x: string]: Schema.Json | undefined");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("patched Effect client preserves optional multipart as FormData or void", () => {
  const clientTypes = readFileSync(
    "node_modules/effect/dist/unstable/httpapi/HttpApiEndpoint.d.ts",
    "utf8",
  );

  expect(clientTypes).toContain('Extract<Payload["Type"], Brand<');
  expect(clientTypes).toContain('Exclude<Payload["Type"], Brand<');
});

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
