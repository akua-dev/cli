import { spawnSync } from 'bun';
import { Schema } from 'effect';

import { resolveBunBinary } from './bun-binary';

const Argv = Schema.Array(Schema.String);

/**
 * Shared subprocess helper for tests that exercise the real `akua` CLI
 * entrypoint end to end. Genuine process-boundary glue: it necessarily spawns
 * an OS process and is exempt from this repo's Effect-only rule for `src/`
 * and `scripts/` (test/ is not covered by that rule; see AGENTS.md).
 *
 * Uses Bun.spawnSync (via the `bun` module) rather than node:child_process so
 * the helper stays off the banned node-builtins import list while remaining
 * synchronous for the many plain (non-Effect) call sites in cli.test.ts.
 */
export interface RunAkuaResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

export function runAkua(args: readonly string[], env: Record<string, string> = {}): RunAkuaResult {
	const childEnv: Record<string, string | undefined> = {
		...process.env,
		...env
	};
	if (!('AKUA_OUTPUT' in env)) {
		delete childEnv.AKUA_OUTPUT;
	}
	if (!('AKUA_API_TOKEN' in env)) {
		delete childEnv.AKUA_API_TOKEN;
	}

	const argv = Schema.decodeUnknownSync(Argv)([...args]);
	const result = spawnSync([resolveBunBinary(), 'src/bin/akua.ts', ...argv], {
		env: childEnv,
		stdout: 'pipe',
		stderr: 'pipe'
	});

	return {
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
		exitCode: result.exitCode ?? -1
	};
}
