import { describe, expect, test } from '@effect/vitest';
import ciWorkflow from '../.github/workflows/ci.yml?raw';
import releasePleaseWorkflow from '../.github/workflows/release-please.yml?raw';
import releaseWorkflow from '../.github/workflows/release.yml?raw';

describe('distribution workflows', () => {
	test('pull request CI uses available GitHub-hosted Linux runners', () => {
		const workflow = ciWorkflow;
		const checkJob = workflow.slice(
			workflow.indexOf('  check:'),
			workflow.indexOf('  package-release:')
		);
		const packageJob = workflow.slice(
			workflow.indexOf('  package-release:'),
			workflow.indexOf('  install-smoke:')
		);

		expect(checkJob).toContain('runs-on: ubuntu-latest');
		expect(packageJob).toContain('runs-on: ubuntu-24.04');
	});

	test('release control-plane jobs use available GitHub-hosted Linux runners', () => {
		const [releasePlease, release] = [releasePleaseWorkflow, releaseWorkflow];

		expect(releasePlease).toContain('runs-on: ubuntu-latest');
		expect(release).toContain('runs-on: ubuntu-24.04');
		expect(`${releasePlease}\n${release}`).not.toMatch(/^\s+runs-on: akua-(?:x64|heavy)-ci-v2$/m);
	});

	test('the release workflow consumes the complete release target matrix', () => {
		const workflow = releaseWorkflow;

		expect(workflow).toContain('bun scripts/release.ts matrix');
		expect(workflow).toContain('fromJSON(needs.package.outputs.matrix)');
	});

	test('release packaging installs every target-native optional dependency', () => {
		const installCommand = "bun install --frozen-lockfile --os='*' --cpu='*'";
		const ciPackageJob = ciWorkflow.slice(
			ciWorkflow.indexOf('  package-release:'),
			ciWorkflow.indexOf('  install-smoke:')
		);
		const releasePackageJob = releaseWorkflow.slice(
			releaseWorkflow.indexOf('  package:'),
			releaseWorkflow.indexOf('  install-smoke:')
		);

		expect(ciPackageJob).toContain(installCommand);
		expect(releasePackageJob).toContain(installCommand);
	});

	test('CI packages once and install-smokes every runnable target natively', () => {
		const workflow = ciWorkflow;

		expect(workflow).toContain('package-release:');
		expect(workflow).toContain('install-smoke:');
		expect(workflow).toContain('bun scripts/release.ts matrix');
		expect(workflow).toContain('fromJSON(needs.package-release.outputs.matrix)');
		expect(workflow).toContain('bun scripts/release.ts smoke');
	});

	test('release inputs reach shell scripts only through quoted environment variables', () => {
		const workflow = releaseWorkflow;

		expect(workflow).not.toContain('test "${{ inputs.tag }}"');
		expect(workflow).not.toContain('--version "${{ inputs.version }}"');
		expect(workflow).not.toContain('gh release upload "${{ inputs.tag }}"');
		expect(workflow).not.toContain('gh release download "${{ inputs.tag }}"');
		expect(workflow).toContain('TAG: ${{ inputs.tag }}');
		expect(workflow).toContain('VERSION: ${{ inputs.version }}');
		expect(workflow).toContain('test "$TAG" = "v$VERSION"');
	});

	test('release jobs checkout and verify the immutable tag commit', () => {
		const workflow = releaseWorkflow;

		expect(workflow.match(/ref: refs\/tags\/\$\{\{ inputs\.tag \}\}/g)).toHaveLength(3);
		expect(workflow).toContain('git rev-parse --verify "refs/tags/$TAG^{commit}"');
		expect(workflow).toContain('commit: ${{ steps.release-ref.outputs.commit }}');
		expect(workflow).toContain('EXPECTED_COMMIT: ${{ needs.package.outputs.commit }}');
		expect(workflow.indexOf('Validate immutable release tag and package version')).toBeLessThan(
			workflow.indexOf('bun install --frozen-lockfile')
		);
		expect(workflow.indexOf('Validate immutable release tag and package version')).toBeLessThan(
			workflow.indexOf('bun scripts/release.ts matrix')
		);
	});

	test('the contents-write publish checkout does not persist its credential', () => {
		const workflow = releaseWorkflow;
		const publishJob = workflow.slice(
			workflow.indexOf('  publish:'),
			workflow.indexOf('  tap-update:')
		);

		expect(publishJob).toContain('persist-credentials: false');
	});

	test('release smoke runners are derived from the release target contract', () => {
		const workflow = releaseWorkflow;

		expect(workflow).toContain('bun scripts/release.ts matrix');
		expect(workflow).toContain('fromJSON(needs.package.outputs.matrix)');
	});

	test('Release Please invokes artifact publication without relying on a tag event', () => {
		const workflow = releasePleaseWorkflow;

		expect(workflow).toContain('release_created:');
		expect(workflow).toContain('tag_name:');
		expect(workflow).toContain('uses: ./.github/workflows/release.yml');
		expect(workflow).toContain('secrets: inherit');
	});

	test('release publication is verified before the tap dispatch', () => {
		const workflow = releaseWorkflow;

		expect(workflow).toContain('workflow_call:');
		expect(workflow).toContain('workflow_dispatch:');
		expect(workflow).toContain('bun scripts/release.ts upload-plan');
		expect(workflow).toContain('gh release view "$TAG" --json assets');
		expect(workflow).toContain('gh release download "$TAG" --dir dist/existing');
		expect(workflow).toContain('gh release upload "$TAG" "${assets[@]}"');
		expect(workflow).not.toContain('gh release upload "$TAG" dist/release/*');
		expect(workflow).not.toContain('--clobber');
		expect(workflow).toContain('gh release download');
		expect(workflow).toContain('bun scripts/release.ts verify');
		expect(workflow).toContain('tap-update:');
		expect(workflow).toContain('needs: publish');
		expect(workflow).toContain('HOMEBREW_TAP_TOKEN');
		expect(workflow).toContain('repos/akua-dev/homebrew-tap/dispatches');
		expect(workflow).toContain('akua-cli-release-published');
		expect(workflow).not.toContain('force');
	});
});
