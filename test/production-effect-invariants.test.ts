import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const productionRoots = ["src", "scripts"];
const approvedLiveServiceModules = new Map<string, readonly string[]>([
  [
    "src/runtime/services.ts",
    ["HttpLive", "BrowserLive", "ProcessLive", "ConsoleLive", "SecureConfigLive", "ClockLive"],
  ],
  ["src/runtime/secure-token-file-services.ts", ["SecureTokenFileLive"]],
  ["scripts/runtime/services.ts", ["ScriptHttpLive", "ScriptFilesLive"]],
  ["scripts/runtime/release-services.ts", ["ReleaseHostLive"]],
]);
const hostModules = new Set([
  "node:child_process",
  "node:crypto",
  "node:fs",
  "node:fs/promises",
  "node:http",
  "node:https",
  "node:net",
  "node:os",
  "node:process",
  "node:tls",
]);
const hostGlobals = new Set(["Bun", "Deno", "console", "fetch", "process", "require"]);

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

test("production runtime handoffs stay inside import.meta.main terminal guards", () => {
  const violations = productionFiles().flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return inspectRuntimeHandoffs(file, ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
  });

  expect(violations).toEqual([]);
});

test("runtime handoff inspection rejects Runtime.makeRunMain outside its terminal guard", () => {
  const source = ts.createSourceFile(
    "src/bin/akua.ts",
    'import { Runtime } from "effect";\nRuntime.makeRunMain(() => {});',
    ts.ScriptTarget.Latest,
    true,
  );

  expect(inspectRuntimeHandoffs("src/bin/akua.ts", source)).toEqual([
    { file: "src/bin/akua.ts", rule: "Runtime.makeRunMain outside import.meta.main" },
  ]);
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
    if (isApprovedLiveServiceModule(file, sourceFile)) return;
    if (isExecutableTerminal(file, node)) return;
    violations.push({ file, rule: "host I/O outside a typed live service" });
  });

  return violations;
}

function isHostIo(node: ts.Node, checker: ts.TypeChecker): boolean {
  if (ts.isImportDeclaration(node)) {
    const module = node.moduleSpecifier;
    return ts.isStringLiteral(module) && hostModules.has(module.text);
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    const module = node.arguments[0];
    return module !== undefined && ts.isStringLiteral(module) && hostModules.has(module.text);
  }
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require"
  ) {
    const module = node.arguments[0];
    return module !== undefined && ts.isStringLiteral(module) && hostModules.has(module.text);
  }
  if (!ts.isIdentifier(node) || !hostGlobals.has(node.text)) return false;
  const symbol = checker.getSymbolAtLocation(node);
  return symbol === undefined || !symbol.declarations?.some((declaration) => declaration.getSourceFile() === node.getSourceFile());
}

function isApprovedLiveServiceModule(file: string, sourceFile: ts.SourceFile): boolean {
  const liveExports = approvedLiveServiceModules.get(file);
  return liveExports !== undefined && liveExports.every((name) => sourceFile.text.includes(`export const ${name}`));
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

function inspectRuntimeHandoffs(file: string, sourceFile: ts.SourceFile): Violation[] {
  const violations: Violation[] = [];
  visit(sourceFile, (node) => {
    if (!isRuntimeMakeRunMain(node) || isExecutableTerminal(file, node)) return;
    violations.push({ file, rule: "Runtime.makeRunMain outside import.meta.main" });
  });
  return violations;
}

function isRuntimeMakeRunMain(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Runtime" &&
    node.name.text === "makeRunMain";
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
