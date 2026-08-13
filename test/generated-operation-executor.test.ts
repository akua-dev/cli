import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { commandRegistry } from "../src/generated/commands.gen";

const specPath = "openapi/public.json";
const executorPath = "src/generated/public-operation-executor.gen.ts";

test("the generated executor represents every public OpenAPI operation", () => {
  expect(existsSync(executorPath)).toBe(true);

  const source = readFileSync(executorPath, "utf8");
  const operationIds = publicOperationIds(
    JSON.parse(readFileSync(specPath, "utf8")),
  );

  expect(operationIds.length).toBeGreaterThan(0);
  for (const operationId of operationIds) {
    expect(source).toContain(`case ${JSON.stringify(operationId)}:`);
  }
  expect((source.match(/\bcase\s+"[^"]+":/g) ?? []).length).toBe(
    operationIds.length,
  );
  expect(operationIds).toEqual(
    commandRegistry.map((command) => command.operation_id),
  );
});

test("the generated executor is static and assertion-free", () => {
  expect(existsSync(executorPath)).toBe(true);

  const source = readFileSync(executorPath, "utf8");
  expect(source).toContain("export type PublicOperationId =");
  expect(source).toContain("export function executePublicOperation(");
  expect(source).not.toContain("Reflect");
  expect(typeAssertions(source)).toEqual([]);
  expect(source).not.toMatch(/\b(?:async|await|Promise|throw)\b/);
});

function typeAssertions(source: string): string[] {
  const file = ts.createSourceFile(
    executorPath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const assertions: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      assertions.push(node.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return assertions;
}

function publicOperationIds(spec: unknown): string[] {
  if (!isRecord(spec) || !isRecord(spec.paths)) return [];
  return Object.values(spec.paths)
    .filter(isRecord)
    .flatMap((pathItem) =>
      Object.values(pathItem)
        .filter(isRecord)
        .filter(
          (operation) => operation["x-platform-visibility"] === "PUBLIC",
        )
        .map((operation) => operation.operationId)
        .filter((operationId): operationId is string =>
          typeof operationId === "string",
        ),
    )
    .sort((left, right) => left.localeCompare(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
