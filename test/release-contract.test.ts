import { describe, expect, it } from '@effect/vitest';
import { BunServices } from '@effect/platform-bun';
import { Config, Effect, FileSystem, Layer, Option, Path, Result } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { makeReleaseHostLive } from '../scripts/runtime/release-host-live';
import {
	admitNativeSmokeArchive,
	artifactName,
	makeReleaseProvenance,
	RELEASE_TARGETS,
	ReleaseHost
} from '../scripts/runtime/release-services';

const TEST_SOURCE_SHA = '0123456789abcdef0123456789abcdef01234567';

describe('release provenance contract', () => {
	it.effect('binds the cnap source and embedded Akuapkg SDK identity', () =>
		Effect.gen(function* () {
			const provenance = yield* makeReleaseProvenance({
				sourceSha: '0123456789abcdef0123456789abcdef01234567',
				sdkVersion: '0.9.4',
				sdkSha256: 'a'.repeat(64)
			});

			expect(provenance).toEqual({
				source: {
					repository: 'akua-dev/cnap',
					sha: '0123456789abcdef0123456789abcdef01234567',
					subtree: 'tools/cli/source'
				},
				dependencies: [
					{
						name: '@akua-dev/sdk',
						version: '0.9.4',
						sha256: 'a'.repeat(64)
					}
				]
			});
		})
	);

	it.effect('rejects malformed source and dependency identities', () =>
		Effect.gen(function* () {
			const malformedSource = yield* Effect.exit(
				makeReleaseProvenance({
					sourceSha: 'main',
					sdkVersion: '0.9.4',
					sdkSha256: 'a'.repeat(64)
				})
			);
			const malformedDigest = yield* Effect.exit(
				makeReleaseProvenance({
					sourceSha: '0'.repeat(40),
					sdkVersion: '0.9.4',
					sdkSha256: 'not-a-digest'
				})
			);

			expect(malformedSource._tag).toBe('Failure');
			expect(malformedDigest._tag).toBe('Failure');
		})
	);
});

describe('native smoke archive admission', () => {
	it.effect('admits only the expected bytes on the actual native target', () =>
		Effect.gen(function* () {
			expect(
				yield* admitNativeSmokeArchive({
					targetId: 'linux-x64',
					hostTargetId: 'linux-x64',
					archiveSha256: 'a'.repeat(64),
					actualSha256: Effect.succeed('a'.repeat(64))
				})
			).toBeUndefined();
		})
	);
	it.effect('refuses altered bytes and malformed expected digests', () =>
		Effect.gen(function* () {
			for (const archiveSha256 of ['b'.repeat(64), 'not-a-digest']) {
				const result = yield* Effect.exit(
					admitNativeSmokeArchive({
						targetId: 'linux-x64',
						hostTargetId: 'linux-x64',
						archiveSha256,
						actualSha256: Effect.succeed('a'.repeat(64))
					})
				);
				expect(result._tag).toBe('Failure');
			}
		})
	);
	it.effect('refuses a foreign OS or architecture even with matching bytes', () =>
		Effect.gen(function* () {
			for (const hostTargetId of ['linux-arm64', 'darwin-x64']) {
				const result = yield* Effect.exit(
					admitNativeSmokeArchive({
						targetId: 'linux-x64',
						hostTargetId,
						archiveSha256: 'a'.repeat(64),
						actualSha256: Effect.succeed('a'.repeat(64))
					})
				);
				expect(result._tag).toBe('Failure');
			}
		})
	);
});

const makeSourceBindingFixture = Effect.fn('test.makeSourceBindingFixture')(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const releaseRoot = path.join(process.cwd(), 'dist/release');
	yield* fs.makeDirectory(releaseRoot, { recursive: true });
	const root = yield* fs.makeTempDirectoryScoped({ directory: releaseRoot });
	const packageRoot = path.join(root, 'runtime');
	for (const [name, files] of [
		['sdk', ['dist/execute.js']],
		['native', ['index.js', 'loader.js']],
		['native-engines', ['helm-engine.wasm', 'kustomize-engine.wasm']]
	] as const) {
		const directory = path.join(packageRoot, name);
		yield* fs.makeDirectory(directory, { recursive: true });
		yield* fs.writeFileString(
			path.join(directory, 'package.json'),
			JSON.stringify({
				name: `@akua-dev/${name}`,
				version: '0.9.6',
				files
			})
		);
		for (const file of files) {
			yield* fs.makeDirectory(path.dirname(path.join(directory, file)), { recursive: true });
			yield* fs.writeFileString(path.join(directory, file), `${name}/${file}`);
		}
	}
	const nativeBindings: Record<string, string> = {};
	for (const target of RELEASE_TARGETS) {
		const file = `akua.${target.bindingPackage.slice('native-'.length)}.node`;
		const directory = path.join(packageRoot, target.bindingPackage);
		yield* fs.makeDirectory(directory);
		yield* fs.writeFileString(path.join(directory, 'package.json'), JSON.stringify({ main: file }));
		yield* fs.writeFileString(path.join(directory, file), `registry:${target.id}`);
		const source = path.join(root, `source-${target.id}.node`);
		yield* fs.writeFileString(source, `source:${target.id}`);
		nativeBindings[target.id] = source;
	}
	const executable = path.join(root, 'executable');
	yield* fs.writeFileString(executable, 'compiled-cli-fixture');
	return { root, packageRoot, executable, nativeBindings };
});

for (const sourceMode of [true, false]) {
	it.live(
		sourceMode
			? 'archives each declared source binding instead of the independently available registry binding'
			: 'preserves manual registry binding selection for every target',
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const host = yield* ReleaseHost;
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
				const fixture = yield* makeSourceBindingFixture();
				const zipper = yield* Config.option(Config.String('PLATFORM_CLI_TEST_ZIPPER'));
				const zipperPath = Option.isSome(zipper) ? path.resolve(zipper.value) : undefined;
				for (const target of RELEASE_TARGETS) {
					const outputDir = path.join(fixture.root, target.id);
					const input = {
						version: '1.2.3',
						outputDir,
						packageRoot: fixture.packageRoot,
						binaries: { [target.id]: fixture.executable },
						sourceSha: TEST_SOURCE_SHA,
						targetId: target.id,
						nativeBindings: sourceMode ? fixture.nativeBindings : undefined,
						zipperPath
					};
					yield* host.packageExistingExecutables(input);
					const extracted = path.join(fixture.root, `extracted-${target.id}`);
					yield* fs.makeDirectory(extracted);
					const archive = path.join(outputDir, artifactName('1.2.3', target));
					const command =
						target.archive === 'zip'
							? zipperPath
								? ChildProcess.make(zipperPath, ['x', archive], { cwd: extracted })
								: ChildProcess.make('unzip', ['-q', archive, '-d', extracted])
							: ChildProcess.make('tar', ['-xzf', archive, '-C', extracted]);
					expect(Number(yield* spawner.exitCode(command))).toBe(0);
					const file = `akua.${target.bindingPackage.slice('native-'.length)}.node`;
					expect(
						yield* fs.readFileString(path.join(extracted, 'node_modules/@akua-dev/native', file))
					).toBe(`${sourceMode ? 'source' : 'registry'}:${target.id}`);
					const asset = JSON.parse(yield* fs.readFileString(path.join(outputDir, 'asset.json')));
					expect(asset.contents.filter((file: string) => file.endsWith('.node'))).toEqual([
						`node_modules/@akua-dev/native/${file}`
					]);
					expect(
						JSON.parse(
							yield* fs.readFileString(
								path.join(extracted, 'node_modules/@akua-dev/sdk/package.json')
							)
						).version
					).toBe('0.9.6');
				}
			}).pipe(
				Effect.scoped,
				Effect.provide(Layer.mergeAll(BunServices.layer, makeReleaseHostLive()))
			)
	);
}

it.live(
	'refuses an unreadable or missing declared source binding even when registry bindings exist',
	() =>
		Effect.gen(function* () {
			const path = yield* Path.Path;
			const fs = yield* FileSystem.FileSystem;
			const host = yield* ReleaseHost;
			const fixture = yield* makeSourceBindingFixture();
			for (const target of RELEASE_TARGETS) {
				for (const nativeBindings of [
					{},
					{ [target.id]: path.join(fixture.root, 'absent.node') }
				]) {
					const input = {
						version: '1.2.3',
						outputDir: path.join(fixture.root, target.id),
						packageRoot: fixture.packageRoot,
						binaries: { [target.id]: fixture.executable },
						sourceSha: TEST_SOURCE_SHA,
						targetId: target.id,
						nativeBindings
					};
					expect(
						Result.isFailure(yield* Effect.result(host.packageExistingExecutables(input)))
					).toBe(true);
					expect(yield* fs.exists(path.join(input.outputDir, artifactName('1.2.3', target)))).toBe(
						false
					);
				}
			}
		}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, makeReleaseHostLive())))
);
