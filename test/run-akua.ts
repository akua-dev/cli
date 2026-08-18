import { spawnSync } from "node:child_process";

import { resolveBunBinary } from "./bun-binary";

/**
 * Shared subprocess helper for tests that exercise the real `akua` CLI
 * entrypoint end to end. Genuine process-boundary glue: it necessarily spawns
 * an OS process and is exempt from this repo's Effect-only rule for `src/`
 * and `scripts/` (test/ is not covered by that rule; see AGENTS.md).
 *
 * Deliberately kept on raw node:child_process rather than
 * effect/unstable/process's ChildProcessSpawner: this helper black-box
 * tests the compiled CLI entrypoint from outside the Effect pipeline it
 * spawns (that's the point — it never touches the runtime under test), and
 * it is called synchronously from 45+ plain (non-Effect) assertions across
 * test/cli.test.ts and test/strict-effect-control-flow.test.ts. Converting
 * it to an Effect-returning spawn would force every one of those call sites
 * into an Effect.gen/it.effect body for no behavior-relevant gain.
 */
export interface RunAkuaResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export function runAkua(
  args: readonly string[],
  env: Record<string, string> = {},
): RunAkuaResult {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...env,
  };
  if (!("AKUA_OUTPUT" in env)) {
    delete childEnv.AKUA_OUTPUT;
  }
  if (!("AKUA_API_TOKEN" in env)) {
    delete childEnv.AKUA_API_TOKEN;
  }

  const result = spawnSync(resolveBunBinary(), ["src/bin/akua.ts", ...args], {
    env: childEnv,
    encoding: "utf8",
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? -1,
  };
}
