import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("patched Effect generator preserves headers and SSE contracts without warnings", () => {
  const directory = mkdtempSync(join(tmpdir(), "akua-effect-generator-"));
  const specPath = join(directory, "public.json");
  const outputPath = join(directory, "public-api.gen.ts");

  try {
    writeFileSync(specPath, JSON.stringify(specification()));
    const result = Bun.spawnSync({
      cmd: [
        "./node_modules/.bin/openapigen",
        "--spec",
        specPath,
        "--format",
        "httpapi",
        "--name",
        "PublicApi",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stderr)).not.toContain("warning");
    writeFileSync(outputPath, result.stdout);
    const output = readFileSync(outputPath, "utf8");
    expect(output).toContain("HttpApiSchema.WithHeaders");
    expect(output).toContain("WidgetsCreate201Headers");
    expect(output).toContain("HttpApiSchema.StreamSse({ events:");
    expect(output).toContain("payload: [HttpApiSchema.NoContent");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
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
    },
  };
}
