import { describe, expect, test } from '@effect/vitest';
import changelog from '../CHANGELOG.md?raw';
import releaseManifest from '../.release-please-manifest.json?raw';
import packageManifest from '../package.json?raw';
import releasePleaseConfig from '../release-please-config.json?raw';
import cliSource from '../src/bin/akua.ts?raw';

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
	test('configures the root Bun CLI package without publish automation', () => {
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
	});

	test('updates the CLI version reported by akua --version', () => {
		expect(cliSource).toMatch(
			/const VERSION = ['"]\d+\.\d+\.\d+(?:[-+][^'"]+)?['"]; \/\/ x-release-please-version/
		);
	});

	test('tracks the root package release version', () => {
		const manifest = JSON.parse(releaseManifest) as Record<string, string>;

		expect(Object.keys(manifest)).toEqual(['.']);
		expect(manifest['.']).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
	});

	test('keeps package and binary release metadata coherent', () => {
		const manifest = JSON.parse(releaseManifest) as Record<string, string>;
		const packageVersion = JSON.parse(packageManifest) as {
			version: string;
		};

		expect(packageVersion.version).toBe(manifest['.']);
		expect(cliSource).toContain(`const VERSION = '${manifest['.']}'; // x-release-please-version`);
		expect(changelog).toContain(`## [${manifest['.']}]`);
	});
});
