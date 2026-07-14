import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_OPENAPI_URL, fetchOpenApi, resolveSpecUrl, validateOpenApiDocument } from "../scripts/fetch-openapi";

describe("OpenAPI fetch guard", () => {
  test("defaults to the production public OpenAPI endpoint", () => {
    expect(resolveSpecUrl(undefined).href).toBe(DEFAULT_OPENAPI_URL);
  });

  test("rejects non-https URLs", () => {
    expect(() => resolveSpecUrl("http://api.akua.dev/v1/openapi.json")).toThrow("https");
  });

  test("validates the minimum OpenAPI document shape", () => {
    expect(() => validateOpenApiDocument({ openapi: "3.1.0", paths: {} })).not.toThrow();
    expect(() => validateOpenApiDocument({ openapi: "2.0", paths: {} })).toThrow("OpenAPI 3.x");
  });

  test("writes stable output when an unchanged spec is fetched repeatedly", async () => {
    const originalFetch = globalThis.fetch;
    const root = await mkdtemp(join(process.cwd(), ".tmp-akua-openapi-"));
    const output = join(root, "public.json");
    const spec = { paths: { "/health": { get: { operationId: "health" } } }, openapi: "3.1.0" };
    globalThis.fetch = (async () => Response.json(spec)) as unknown as typeof fetch;
    try {
      await fetchOpenApi(new URL(DEFAULT_OPENAPI_URL), output);
      const first = await readFile(output, "utf8");
      await fetchOpenApi(new URL(DEFAULT_OPENAPI_URL), output);
      const second = await readFile(output, "utf8");

      expect(second).toBe(first);
      expect(second).toBe(`${JSON.stringify(spec, null, 2)}\n`);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });
});
