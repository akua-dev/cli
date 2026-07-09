import { describe, expect, test } from "bun:test";

describe("akua entrypoint", () => {
  test("fails loudly on unknown flags", async () => {
    const { stdout, exitCode } = await runAkua(["commands", "--bogus", "--output", "json"]);
    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({
      error: {
        type: "usage_error",
        code: "AKUA_USAGE_ERROR",
        message: "Unknown flag: --bogus",
      },
    });
  });

  test("fails invalid explicit output modes before routing", async () => {
    const { stdout, exitCode } = await runAkua(["--output", "yaml", "--version"]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("Invalid --output value: yaml");
  });

  test("fails missing explicit output mode values before routing", async () => {
    const { stdout, exitCode } = await runAkua(["--output", "--version"]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("Missing value for --output");
  });

  test("fails invalid AKUA_OUTPUT values before routing", async () => {
    const { stdout, exitCode } = await runAkua(["--version"], { AKUA_OUTPUT: "yaml" });
    expect(exitCode).toBe(2);
    expect(stdout).toContain("Invalid AKUA_OUTPUT value: yaml");
  });

  test("requires commands filter values", async () => {
    const { stdout, exitCode } = await runAkua(["commands", "--operation-id", "--json"]);
    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({
      error: {
        type: "usage_error",
        code: "AKUA_USAGE_ERROR",
        message: "Missing value for --operation-id.",
      },
    });
  });

  test("requires resource filter values", async () => {
    const { stdout, exitCode } = await runAkua(["commands", "--resource=", "--json"]);
    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({
      error: {
        message: "Missing value for --resource.",
      },
    });
  });

  test("requires positive integer command limits", async () => {
    const invalid = await runAkua(["commands", "--limit", "banana", "--json"]);
    expect(invalid.exitCode).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      error: {
        message: "Invalid value for --limit: banana. Expected a positive integer.",
      },
    });

    const zero = await runAkua(["commands", "--limit=0", "--json"]);
    expect(zero.exitCode).toBe(2);
    expect(JSON.parse(zero.stdout)).toMatchObject({
      error: {
        message: "Invalid value for --limit: 0. Expected a positive integer.",
      },
    });
  });
});

async function runAkua(args: readonly string[], env: Record<string, string> = {}) {
  const childEnv = { ...process.env, ...env };
  if (!("AKUA_OUTPUT" in env)) {
    delete childEnv.AKUA_OUTPUT;
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
