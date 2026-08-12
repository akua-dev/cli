import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Effect, Layer } from "effect";
import ts from "typescript";

import {
  checkEffectApi,
  EffectApiGenerationFailure,
  generateEffectApi,
} from "../scripts/generate-effect-api";
import { ScriptFiles, ScriptHostFailure } from "../scripts/runtime/services";

const sourcePath = "openapi/public.json";
const outputPath = "src/generated/openapi-api.gen.ts";

test("generates a typed HttpApi module from the public OpenAPI contract", async () => {
  let written = "";
  const layer = Layer.succeed(ScriptFiles, {
    readText: () => Effect.succeed(JSON.stringify(publicSpec())),
    writeText: (_, contents) =>
      Effect.sync(() => {
        written = contents;
      }),
  });

  const generated = await Effect.runPromise(
    generateEffectApi(sourcePath, outputPath).pipe(Effect.provide(layer)),
  );

  expect(written).toBe(generated);
  expect(generated).toContain(
    'HttpApiEndpoint.post("secretsCreate", "/v1/secrets"',
  );
  expect(generated).toContain('annotate(OpenApi.Identifier, "secrets.create")');
  expect(typeAssertions(generated)).toEqual([]);
  expect(generated).not.toMatch(/[ \t]+$/m);
});

test("generates only PUBLIC operations", async () => {
  const layer = Layer.succeed(ScriptFiles, {
    readText: () => Effect.succeed(JSON.stringify(specWithMixedVisibility())),
    writeText: () => Effect.void,
  });

  const generated = await Effect.runPromise(
    generateEffectApi(sourcePath, outputPath).pipe(Effect.provide(layer)),
  );

  expect(generated).toContain(
    'HttpApiEndpoint.get("secretsList", "/v1/secrets"',
  );
  expect(generated).toContain("pageSize");
  expect(generated).not.toContain("adminListSecrets");
});

test("fails with a typed error when the generator reports a public contract warning", async () => {
  const layer = Layer.succeed(ScriptFiles, {
    readText: () => Effect.succeed(JSON.stringify(specWithUnannotatedSse())),
    writeText: () => Effect.void,
  });

  await expect(
    Effect.runPromise(
      generateEffectApi(sourcePath, outputPath).pipe(Effect.provide(layer)),
    ),
  ).rejects.toBeInstanceOf(EffectApiGenerationFailure);
});

test("maps generator defects to a typed generation error", async () => {
  const layer = Layer.succeed(ScriptFiles, {
    readText: () => Effect.succeed(JSON.stringify(specWithInvalidPattern())),
    writeText: () => Effect.void,
  });

  await expect(
    Effect.runPromise(
      generateEffectApi(sourcePath, outputPath).pipe(Effect.provide(layer)),
    ),
  ).rejects.toBeInstanceOf(EffectApiGenerationFailure);
});

test("detects generated API drift without overwriting the checked-in artifact", async () => {
  let writes = 0;
  const layer = Layer.succeed(ScriptFiles, {
    readText: (path) =>
      Effect.succeed(
        path === sourcePath ? JSON.stringify(publicSpec()) : "stale artifact",
      ),
    writeText: () =>
      Effect.sync(() => {
        writes += 1;
      }),
  });

  await expect(
    Effect.runPromise(
      checkEffectApi(sourcePath, outputPath).pipe(Effect.provide(layer)),
    ),
  ).rejects.toBeInstanceOf(EffectApiGenerationFailure);

  expect(writes).toBe(0);
});

test("propagates generated artifact read failures instead of treating them as drift", async () => {
  const layer = Layer.succeed(ScriptFiles, {
    readText: (path) =>
      path === sourcePath
        ? Effect.succeed(JSON.stringify(publicSpec()))
        : Effect.fail(new ScriptHostFailure({ cause: "permission denied" })),
    writeText: () => Effect.void,
  });

  await expect(
    Effect.runPromise(
      checkEffectApi(sourcePath, outputPath).pipe(Effect.provide(layer)),
    ),
  ).rejects.toBeInstanceOf(ScriptHostFailure);
});

test("checked-in public contract produces the committed strict Effect API artifact", async () => {
  const source = readFileSync(sourcePath, "utf8");
  const artifact = readFileSync(outputPath, "utf8");
  const layer = Layer.succeed(ScriptFiles, {
    readText: (path) => Effect.succeed(path === sourcePath ? source : artifact),
    writeText: () => Effect.void,
  });

  await Effect.runPromise(
    checkEffectApi(sourcePath, outputPath).pipe(Effect.provide(layer)),
  );

  expect(artifact).toContain('annotate(OpenApi.Identifier, "secrets.create")');
  expect(typeAssertions(artifact)).toEqual([]);
  expect(artifact).not.toMatch(/[ \t]+$/m);
});

function publicSpec() {
  return {
    openapi: "3.1.0",
    info: { title: "Public API", version: "1.0.0" },
    paths: {
      "/v1/secrets": {
        post: {
          operationId: "secrets.create",
          "x-platform-visibility": "PUBLIC",
          tags: ["Secrets"],
          parameters: [],
          security: [],
          responses: { 201: { description: "Created" } },
        },
      },
    },
    components: { schemas: {}, securitySchemes: {} },
    security: [],
    tags: [{ name: "Secrets" }],
  };
}

function specWithUnannotatedSse() {
  return {
    openapi: "3.1.0",
    info: { title: "Public API", version: "1.0.0" },
    paths: {
      "/v1/logs": {
        get: {
          operationId: "installs.getLogs",
          "x-platform-visibility": "PUBLIC",
          tags: ["Installs"],
          parameters: [],
          security: [],
          responses: {
            200: {
              description: "Logs",
              content: {
                "text/event-stream": { schema: { type: "string" } },
              },
            },
          },
        },
      },
    },
    components: { schemas: {}, securitySchemes: {} },
    security: [],
    tags: [{ name: "Installs" }],
  };
}

function specWithInvalidPattern() {
  return {
    openapi: "3.1.0",
    info: { title: "Public API", version: "1.0.0" },
    paths: {
      "/v1/name": {
        get: {
          operationId: "names.get",
          "x-platform-visibility": "PUBLIC",
          tags: ["Names"],
          parameters: [],
          security: [],
          responses: {
            200: {
              description: "Name",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Name" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Name: { type: "string", pattern: "^[\\p{L}]$/u" },
      },
      securitySchemes: {},
    },
    security: [],
    tags: [],
  };
}

function specWithMixedVisibility() {
  return {
    openapi: "3.1.0",
    info: { title: "Public API", version: "1.0.0" },
    paths: {
      "/v1/secrets": {
        parameters: [
          {
            name: "pageSize",
            in: "query",
            required: false,
            schema: { type: "integer" },
          },
        ],
        get: {
          operationId: "secrets.list",
          "x-platform-visibility": "PUBLIC",
          tags: ["Secrets"],
          parameters: [],
          security: [],
          responses: { 200: { description: "Secrets" } },
        },
      },
      "/v1/admin/secrets": {
        get: {
          operationId: "admin.listSecrets",
          "x-platform-visibility": "ADMIN",
          tags: ["Admin"],
          parameters: [],
          security: [],
          responses: { 200: { description: "Secrets" } },
        },
      },
    },
    components: { schemas: {}, securitySchemes: {} },
    security: [],
    tags: [{ name: "Secrets" }, { name: "Admin" }],
  };
}

function typeAssertions(source: string): readonly ts.Node[] {
  const sourceFile = ts.createSourceFile(
    "openapi-api.gen.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const assertions: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
      assertions.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return assertions;
}
