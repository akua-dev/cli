import { BunServices } from '@effect/platform-bun';
import { Effect, FileSystem } from 'effect';
import { describe, expect, it } from '@effect/vitest';

interface ReleasePleaseConfig {
	'include-component-in-tag'?: boolean;
	packages?: Record<
		string,
		{
			'release-type'?: string;
			'package-name'?: string;
			'changelog-path'?: string;
			'extra-files'?: Array<{
				type?: string;
				path?: string;
				jsonpath?: string;
			}>;
		}
	>;
}

describe('release-please configuration', () => {
	it.effect('configures the root Bun CLI package without publish automation', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const releasePleaseConfig = yield* fs.readFileString('release-please-config.json');
			const config = JSON.parse(releasePleaseConfig) as ReleasePleaseConfig;

			expect(config.packages?.['.']).toEqual({
				'release-type': 'node',
				'package-name': '@akua-dev/cli',
				'changelog-path': 'CHANGELOG.md',
				'extra-files': [
					{
						type: 'generic',
						path: 'src/bin/akua.ts'
					}
				]
			});
			expect(config['include-component-in-tag']).toBe(false);
			expect(JSON.stringify(config)).not.toContain('npm');
			expect(JSON.stringify(config)).not.toContain('publish');
		}).pipe(Effect.provide(BunServices.layer))
	);

	it.effect('updates the CLI version reported by akua --version', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const cliSource = yield* fs.readFileString('src/bin/akua.ts');
			expect(cliSource).toMatch(
				/const VERSION = ['"]\d+\.\d+\.\d+(?:[-+][^'"]+)?['"]; \/\/ x-release-please-version/
			);
		}).pipe(Effect.provide(BunServices.layer))
	);

	it.effect('tracks the root package release version', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const releaseManifest = yield* fs.readFileString('.release-please-manifest.json');
			const manifest = JSON.parse(releaseManifest) as Record<string, string>;

			expect(Object.keys(manifest)).toEqual(['.']);
			expect(manifest['.']).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
		}).pipe(Effect.provide(BunServices.layer))
	);

	it.effect('keeps package and binary release metadata coherent', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const changelog = yield* fs.readFileString('CHANGELOG.md');
			const releaseManifest = yield* fs.readFileString('.release-please-manifest.json');
			const packageManifest = yield* fs.readFileString('package.json');
			const cliSource = yield* fs.readFileString('src/bin/akua.ts');
			const manifest = JSON.parse(releaseManifest) as Record<string, string>;
			const packageVersion = JSON.parse(packageManifest) as {
				version: string;
			};

			expect(packageVersion.version).toBe(manifest['.']);
			expect(cliSource).toContain(
				`const VERSION = '${manifest['.']}'; // x-release-please-version`
			);
			expect(changelog).toContain(`## [${manifest['.']}]`);
		}).pipe(Effect.provide(BunServices.layer))
	);
});
