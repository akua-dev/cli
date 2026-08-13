import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

const productionFiles = [
  ...findTypeScriptFiles("src"),
  ...findTypeScriptFiles("scripts"),
];

test("production CLI source contains no raw throw statements", () => {
  expect(findThrowStatements(productionFiles)).toEqual([]);
});

test("release entrypoint contains no aliased imports", () => {
  expect(findAliasedImports("scripts/release.ts")).toEqual([]);
});

test("invalid commands arguments render a usage envelope", async () => {
  const { stdout, exitCode } = await runAkua([
    "commands",
    "unexpected",
    "--json",
  ]);

  expect(exitCode).toBe(2);
  expect(JSON.parse(stdout)).toMatchObject({
    error: {
      code: "AKUA_USAGE_ERROR",
      message: "Unexpected argument for commands: unexpected",
    },
  });
});

test("invalid auth arguments render a usage envelope", async () => {
  const { stdout, exitCode } = await runAkua([
    "auth",
    "login",
    "unexpected",
    "--json",
  ]);

  expect(exitCode).toBe(2);
  expect(JSON.parse(stdout)).toMatchObject({
    error: {
      code: "AKUA_USAGE_ERROR",
      message: "Unexpected argument for auth login.",
    },
  });
});

function findThrowStatements(files: readonly string[]) {
  return files.flatMap((file) => {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const throws: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isThrowStatement(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        throws.push(`${file}:${line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return throws;
  });
}

function findTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findTypeScriptFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

function findAliasedImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const aliases: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportSpecifier(node) && node.propertyName !== undefined) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      aliases.push(`${file}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return aliases;
}

async function runAkua(
  args: readonly string[],
  env: Record<string, string> = {},
) {
  const childEnv = { ...process.env, ...env };
  if (!("AKUA_OUTPUT" in env)) {
    delete childEnv.AKUA_OUTPUT;
  }
  if (!("AKUA_API_TOKEN" in env)) {
    delete childEnv.AKUA_API_TOKEN;
  }

  const proc = Bun.spawn({
    cmd: ["bun", "src/bin/akua.ts", ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}
