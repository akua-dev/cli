import { Effect, FileSystem } from 'effect';
import { describe, expect, it, test } from '@effect/vitest';
import { BunServices } from '@effect/platform-bun';

const EFFECT_SKILL_PATH = 'skills/effect-v4/SKILL.md';
const AGENTS_PATH = 'AGENTS.md';

const BASELINE_PRESSURE_RESPONSE = `
I will add an async inspectDevice(): Promise<Device> command, await fetch(),
cast the payload as Device, use as const for the command definition, and await
Effect.runPromise() from the command handler so I can ship it in ten minutes.
`;

describe('Effect v4 CLI quality guidance', () => {
	test('shows that the pre-skill pressure response violates the policy', () => {
		expect(BASELINE_PRESSURE_RESPONSE).toMatch(/\basync\b/);
		expect(BASELINE_PRESSURE_RESPONSE).toMatch(/\bPromise\b/);
		expect(BASELINE_PRESSURE_RESPONSE).toMatch(/\bawait\b/);
		expect(BASELINE_PRESSURE_RESPONSE).toMatch(/\bfetch\b/);
		expect(BASELINE_PRESSURE_RESPONSE).toMatch(/\bas\b/);
		expect(BASELINE_PRESSURE_RESPONSE).toMatch(/\bas const\b/);
		expect(BASELINE_PRESSURE_RESPONSE).toMatch(/\brunPromise\b/);
	});

	it.effect('requires a discoverable, auditable Effect v4 skill', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const skill = yield* fs.readFileString(EFFECT_SKILL_PATH);

			expect(skill).toMatch(/^---\nname: effect-v4\ndescription: Use when .*Effect v4.*CLI/m);
			for (const rule of [
				'effect@4.0.0-rc.109',
				'Effect services and layers',
				'Data.TaggedError',
				'TestClock',
				'test layers',
				'`Promise`',
				'`async`',
				'`await`',
				'`throw`',
				'`runPromise`',
				'`as`',
				'`as const`',
				'direct host I/O',
				'production `src/` and `scripts/`',
				'schema',
				'type guard',
				'`satisfies`',
				'binary terminal',
				'fiber',
				'## Red flags',
				'mise run check',
				'bun run test'
			]) {
				expect(skill).toContain(rule);
			}
			expect(skill).toContain('do not use native `Promise`');
		}).pipe(Effect.provide(BunServices.layer))
	);

	it.effect('makes the Effect v4 skill and source scans mandatory for production CLI changes', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const agents = yield* fs.readFileString(AGENTS_PATH);

			expect(agents).toContain('effect-v4');
			expect(agents).toContain('production CLI');
			expect(agents).toContain('source scan');
			expect(agents).toContain('mise run check');
		}).pipe(Effect.provide(BunServices.layer))
	);

	it.effect('keeps generated public commands provider-neutral and Effect-only', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const agents = yield* fs.readFileString(AGENTS_PATH);
			const skill = yield* fs.readFileString(EFFECT_SKILL_PATH);

			for (const rule of [
				'cnap `docs/openapi-public.json` is the only source of truth',
				'provider-neutral',
				'generated path, query, header, and body',
				'fail on warnings, skipped public',
				'raw `throw`',
				'typed error channel',
				'Pure immutable data'
			]) {
				expect(agents).toContain(rule);
			}

			expect(skill).toContain('raw `throw`');
			expect(skill).toContain('typed `Data.TaggedError`');
		}).pipe(Effect.provide(BunServices.layer))
	);

	it.effect('keeps Effect v4 as the only repository-local skill', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			expect(yield* fs.exists('.agents/skills')).toBe(false);
			expect(yield* fs.exists('.superpowers')).toBe(false);
		}).pipe(Effect.provide(BunServices.layer))
	);
});
