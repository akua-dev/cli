import { Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';

import type { ApiClient } from '../api/client';
import type { ApiContract } from '../api/contract';
import { optionalEnv, requiredConfigPath } from '../runtime/credentials';
import { type CliFailure, UsageFailure } from '../runtime/effect-runtime';
import type { RenderEnvelope } from '../runtime/render';
import { SecureConfig } from '../runtime/services';
import { respond } from './invocation';
import { failWorkspaceLookup } from './operation-errors';
import { akua } from './root';
import {
	findWorkspace,
	isWorkspaceId,
	selectWorkspace,
	type WorkspaceSource
} from './workspace-context';

const SOURCE_LABEL: Record<WorkspaceSource, string> = {
	flag: 'Set by --workspace.',
	env: 'Set by AKUA_WORKSPACE.',
	config: 'Saved with akua workspaces use.'
};

/**
 * `akua workspaces use|current`: the persisted workspace context, in the
 * spirit of `vercel switch` and `gh repo set-default`. Added to the generated
 * `workspaces` group, which also answers to `akua workspace`.
 */
export function workspaceContextCommands(contract: ApiContract) {
	const use = Command.make(
		'use',
		{
			workspace: Argument.String('workspace').pipe(
				Argument.withDescription('Workspace name, slug, or ID'),
				Argument.optional
			),
			clear: Flag.Boolean('clear').pipe(
				Flag.withDefault(false),
				Flag.withDescription('Forget the saved workspace')
			)
		},
		({ workspace, clear }) => respond(clear ? clearWorkspace : useWorkspace(contract, workspace))
	).pipe(
		Command.withAlias('switch'),
		Command.withDescription(
			'Save the workspace later commands run in (--workspace and AKUA_WORKSPACE still override it)'
		),
		Command.withExamples([
			{
				command: 'akua workspaces use my-team',
				description: 'Use the workspace with this slug or name'
			},
			{ command: 'akua workspace switch ws_123', description: 'Same, by ID' },
			{ command: 'akua workspaces use --clear', description: 'Forget the saved workspace' }
		])
	);

	const current = Command.make('current', {}, () =>
		Effect.gen(function* () {
			const global = yield* akua;
			yield* respond(currentWorkspace(contract, global.workspace));
		})
	).pipe(Command.withDescription('Show the workspace commands run in and where it comes from'));

	return { commands: [use, current], alias: 'workspace' };
}

const useWorkspace = Effect.fnUntraced(function* (
	contract: ApiContract,
	reference: Option.Option<string>
): Effect.fn.Return<RenderEnvelope, CliFailure, SecureConfig | ApiClient> {
	if (Option.isNone(reference) || reference.value === '') {
		return yield* new UsageFailure({
			message: 'Name the workspace: akua workspaces use <name|id>. See akua workspaces list.'
		});
	}
	const path = yield* requiredConfigPath;
	const workspace = yield* findWorkspace(contract, reference.value).pipe(
		Effect.catch(failWorkspaceLookup(contract))
	);
	yield* (yield* SecureConfig).saveWorkspace(path, { id: workspace.id, name: workspace.name });
	const lines = [
		`Now using ${workspace.name} (${workspace.id}).`,
		...Option.toArray(yield* optionalEnv('AKUA_WORKSPACE')).map(
			(value) => `AKUA_WORKSPACE=${value} still overrides it until you unset it.`
		)
	];
	return {
		command: 'akua workspaces use',
		observations: lines,
		data: { ...workspace, source: 'config', config_path: path },
		human: lines,
		next_steps: [{ command: 'akua clusters list', description: 'List clusters in this workspace.' }]
	};
});

const clearWorkspace: Effect.Effect<RenderEnvelope, CliFailure, SecureConfig> = Effect.gen(
	function* () {
		const path = yield* requiredConfigPath;
		const removed = yield* (yield* SecureConfig).removeWorkspace(path);
		const lines = [removed ? 'Saved workspace cleared.' : 'No workspace was saved.'];
		return {
			command: 'akua workspaces use --clear',
			observations: lines,
			human: lines,
			data: { cleared: removed, config_path: path }
		};
	}
);

const currentWorkspace = Effect.fnUntraced(function* (
	contract: ApiContract,
	flag: Option.Option<string>
): Effect.fn.Return<RenderEnvelope, CliFailure, SecureConfig | ApiClient> {
	const selection = yield* selectWorkspace(flag);
	if (Option.isNone(selection)) {
		return {
			command: 'akua workspaces current',
			observations: ['No workspace selected.'],
			data: { workspace: null },
			next_steps: [
				{ command: 'akua workspaces list', description: 'See your workspaces.' },
				{ command: 'akua workspaces use <name>', description: 'Choose one for later commands.' }
			]
		};
	}
	const { reference, source, name } = selection.value;
	const workspace = isWorkspaceId(reference)
		? { id: reference, ...(name === undefined ? {} : { name }) }
		: yield* findWorkspace(contract, reference).pipe(Effect.catch(failWorkspaceLookup(contract)));
	const lines = [
		workspace.name === undefined ? workspace.id : `${workspace.name} (${workspace.id})`,
		SOURCE_LABEL[source]
	];
	return {
		command: 'akua workspaces current',
		observations: lines,
		data: { ...workspace, source },
		human: lines
	};
});
