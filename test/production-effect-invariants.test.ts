import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const productionRoots = ["src", "scripts"];

interface Violation {
  readonly file: string;
  readonly rule: string;
}

interface ForbiddenPattern {
  readonly rule: string;
  readonly pattern: RegExp;
}

const forbiddenPatterns: readonly ForbiddenPattern[] = [
  {
    rule: "native Promise type or API",
    pattern: /\b(?:Promise\s*[<.]|new\s+Promise\b)/,
  },
  { rule: "async function", pattern: /\basync\b/ },
  { rule: "await expression", pattern: /\bawait\b/ },
  { rule: "Effect.runPromise", pattern: /\bEffect\.runPromise\b/ },
];

test("production TypeScript is Effect-only and assertion-free", () => {
  const violations = productionFiles().flatMap(inspectProductionFile);

  expect(violations).toEqual([]);
});

function productionFiles(): string[] {
  return productionRoots.flatMap(collectTypeScriptFiles);
}

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function inspectProductionFile(file: string): Violation[] {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest);
  const violations = lexicalViolations(file, source);

  visit(sourceFile, (node) => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      violations.push({ file, rule: "TypeScript assertion" });
    }
  });

  return violations;
}

function lexicalViolations(file: string, source: string): Violation[] {
  return forbiddenPatterns.flatMap(({ rule, pattern }) =>
    pattern.test(source) ? [{ file, rule }] : [],
  );
}

function visit(node: ts.Node, inspect: (current: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}
