#!/usr/bin/env bun
import { BunServices } from '@effect/platform-bun';
import { Effect, Exit, Runtime } from 'effect';

import { runAkua } from '../cli/main';
import { CliLive } from '../runtime/services-live';
import type { CliServices } from '../runtime/services';

export const VERSION = '0.11.4'; // x-release-please-version

export function main(
	argv: readonly string[],
	env: Record<string, string | undefined>
): Effect.Effect<number, never, CliServices> {
	return runAkua(argv, env, VERSION);
}

if (import.meta.main) {
	const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
		fiber.addObserver((exit) => {
			if (Exit.isSuccess(exit)) {
				process.exitCode = typeof exit.value === 'number' ? exit.value : 1;
				return;
			}
			teardown(exit, (code) => {
				process.exitCode = code;
			});
		});
	});
	runMain(
		Effect.provide(
			Effect.provide(main(process.argv.slice(2), process.env), CliLive(VERSION)),
			BunServices.layer
		)
	);
}
