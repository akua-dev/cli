import { describe, expect, test } from "bun:test";

import { DEFAULT_OPENAPI_URL, resolveSpecUrl, validateOpenApiDocument } from "../scripts/fetch-openapi";

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
});
