import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import {
	admitNativeSmokeArchive,
	makeReleaseProvenance
} from '../scripts/runtime/release-services';

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
