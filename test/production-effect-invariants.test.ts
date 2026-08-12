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

test("production host I/O is isolated to live services and executable terminals", () => {
  const program = ts.createProgram(productionFiles(), {});
  const checker = program.getTypeChecker();
  const violations = productionFiles().flatMap((file) => inspectHostIo(file, program, checker));

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

function inspectHostIo(
  file: string,
  program: ts.Program,
  checker: ts.TypeChecker,
): Violation[] {
  const sourceFile = program.getSourceFile(file);
  if (sourceFile === undefined) return [{ file, rule: "missing TypeScript source" }];
  const violations: Violation[] = [];

  visit(sourceFile, (node) => {
    if (!isHostIo(node, checker)) return;
    if (isLiveServiceFile(file)) return;
    if (isExecutableTerminal(file, node)) return;
    violations.push({ file, rule: "host I/O outside a typed live service" });
  });

  return violations;
}

function isHostIo(node: ts.Node, checker: ts.TypeChecker): boolean {
  if (ts.isImportDeclaration(node)) {
    const module = node.moduleSpecifier;
    return ts.isStringLiteral(module) && (module.text === "node:fs" || module.text === "node:fs/promises" || module.text === "node:os");
  }
  if (!ts.isIdentifier(node) || !["fetch", "process", "console", "Bun"].includes(node.text)) return false;
  const symbol = checker.getSymbolAtLocation(node);
  return symbol === undefined || !symbol.declarations?.some((declaration) => declaration.getSourceFile() === node.getSourceFile());
}

function isLiveServiceFile(file: string): boolean {
  return /^src\/runtime\/[^/]*services\.ts$/.test(file) || /^scripts\/runtime\/[^/]*services\.ts$/.test(file);
}

function isExecutableTerminal(file: string, node: ts.Node): boolean {
  if (file !== "src/bin/akua.ts" && !/^scripts\/(?:fetch-openapi|generate-commands|release)\.ts$/.test(file)) return false;
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (ts.isIfStatement(current) && isImportMetaMainGuard(current.expression)) return true;
    current = current.parent;
  }
  return false;
}

function isImportMetaMainGuard(expression: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "main" &&
    ts.isMetaProperty(expression.expression) &&
    expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
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
