import { BunServices } from '@effect/platform-bun';
import { Effect, FileSystem, Schema } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { VERSION } from '../src/bin/akua';

const ReleasePleaseConfig = Schema.Struct({
	'include-component-in-tag': Schema.optionalKey(Schema.Boolean),
	packages: Schema.Record(Schema.String, Schema.Unknown)
});
const ReleaseManifest = Schema.Record(Schema.String, Schema.String);
const PackageManifest = Schema.Struct({ version: Schema.String });

const readJson = <S extends Schema.Codec<unknown, unknown>>(schema: S, path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
			yield* fs.readFileString(path)
		);
	});

describe('release-please configuration', () => {
	it.effect('releases the root Bun CLI package and bumps the version akua reports', () =>
		Effect.gen(function* () {
			const config = yield* readJson(ReleasePleaseConfig, 'release-please-config.json');

			expect(config['include-component-in-tag']).toBe(false);
			expect(config.packages).toEqual({
				'.': {
					'release-type': 'node',
					'package-name': '@akua-dev/cli',
					'changelog-path': 'CHANGELOG.md',
					'extra-files': [{ type: 'generic', path: 'src/bin/akua.ts' }]
				}
			});
		}).pipe(Effect.provide(BunServices.layer))
	);

	it.effect('keeps the released, packaged, and reported versions identical', () =>
		Effect.gen(function* () {
			const manifest = yield* readJson(ReleaseManifest, '.release-please-manifest.json');
			const packageManifest = yield* readJson(PackageManifest, 'package.json');

			expect(Object.keys(manifest)).toEqual(['.']);
			expect(manifest['.']).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
			expect(packageManifest.version).toBe(manifest['.']);
			expect(VERSION).toBe(manifest['.']);
		}).pipe(Effect.provide(BunServices.layer))
	);
});
