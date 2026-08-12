import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import ts from "typescript";

const coreFiles = [
  "src/runtime/mode.ts",
  "src/commands/auth.ts",
  "src/bin/akua.ts",
];

test("core CLI modules contain no throw statements", () => {
  expect(findThrowStatements(coreFiles)).toEqual([]);
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
