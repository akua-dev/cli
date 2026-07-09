import { describe, expect, test } from "bun:test";

describe("akua entrypoint", () => {
  test("fails loudly on unknown flags", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "src/bin/akua.ts", "commands", "--bogus", "--output", "json"],
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({
      error: {
        type: "usage_error",
        code: "AKUA_USAGE_ERROR",
        message: "Unknown flag: --bogus",
      },
    });
  });
});
