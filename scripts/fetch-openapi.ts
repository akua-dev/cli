import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_OPENAPI_URL = "https://api.akua.dev/v1/openapi.json";
export const DEFAULT_OUTPUT_PATH = "openapi/public.json";

export function resolveSpecUrl(input: string | undefined): URL {
  const raw = input ?? process.env.AKUA_OPENAPI_URL ?? DEFAULT_OPENAPI_URL;
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error(`OpenAPI URL must use https: ${url.href}`);
  }
  return url;
}

export async function fetchOpenApi(url: URL, outputPath = DEFAULT_OUTPUT_PATH): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OpenAPI fetch failed with ${response.status} ${response.statusText}`);
  }

  const spec = await response.json();
  validateOpenApiDocument(spec);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(spec, null, 2)}\n`);
}

export function validateOpenApiDocument(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("OpenAPI response is not an object");
  }
  const spec = value as Record<string, unknown>;
  if (typeof spec.openapi !== "string" || !spec.openapi.startsWith("3.")) {
    throw new Error("OpenAPI response must be OpenAPI 3.x");
  }
  if (!spec.paths || typeof spec.paths !== "object") {
    throw new Error("OpenAPI response is missing paths");
  }
}

if (import.meta.main) {
  try {
    const url = resolveSpecUrl(process.argv[2]);
    await fetchOpenApi(url);
    console.error(`Fetched OpenAPI spec from ${url.href} into ${DEFAULT_OUTPUT_PATH}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
