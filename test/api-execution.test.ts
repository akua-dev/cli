import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import { runAkua, temporaryHome, writeConfigFile } from './fake-api';

/** Signed in, workspace saved: what most commands run with. */
const signedIn = Effect.gen(function* () {
	const home = yield* temporaryHome;
	yield* writeConfigFile(home, { token: 'test-token', workspace: { id: 'ws_team' } });
	return { HOME: home };
});

const accepted = () => ({ status: 202, body: { id: 'op_1', done: false } });

describe('request assembly', () => {
	it.effect('encodes path segments and keeps literal custom verbs', () =>
		Effect.gen(function* () {
			const env = yield* signedIn;

			const proxied = yield* runAkua(
				['clusters', 'proxy-kube', 'clu_1', 'api/v1/node:name', '--json'],
				{
					env,
					api: () => ({ body: {} })
				}
			);
			const selected = yield* runAkua(
				[
					'order-drafts',
					'select-workspace',
					'od/1',
					'--if-match',
					'etag_1',
					'--kind',
					'existing',
					'--workspace-id',
					'ws_1',
					'--json'
				],
				{ env, api: () => ({ body: {} }) }
			);

			expect(proxied.requests[0]?.url.pathname).toBe(
				'/v1/clusters/clu_1/kube_proxy/api/v1/node%3Aname'
			);
			expect(selected.requests[0]?.url.pathname).toBe('/v1/order_drafts/od%2F1:selectWorkspace');
			expect(selected.requests[0]?.body).toEqual({ kind: 'existing', workspace_id: 'ws_1' });
		}).pipe(Effect.scoped)
	);

	it.effect('omits an optional body nobody supplied and keeps an explicit one', () =>
		Effect.gen(function* () {
			const env = yield* signedIn;

			const omitted = yield* runAkua(
				['products', 'unarchive', 'prod_1', '--if-match', 'e', '--json'],
				{
					env,
					api: accepted
				}
			);
			const explicit = yield* runAkua(['products', 'archive', 'prod_1', '--input', '-', '--json'], {
				env,
				inputs: { '-': '{"headers":{"if-match":"e"},"body":{"cascade_offers":true}}' },
				api: accepted
			});

			expect(omitted.requests[0]?.body).toBeUndefined();
			expect(explicit.requests[0]?.body).toEqual({ cascade_offers: true });
		}).pipe(Effect.scoped)
	);

	it.effect('rejects a null body and partitions the operation does not have before transport', () =>
		Effect.gen(function* () {
			const env = yield* signedIn;

			const nullBody = yield* runAkua(['products', 'archive', 'prod_1', '--input', '-', '--json'], {
				env,
				inputs: { '-': '{"headers":{"if-match":"e"},"body":null}' },
				api: accepted
			});
			const extraPartition = yield* runAkua(['machines', 'delete', '--input', '-', '--json'], {
				env,
				inputs: { '-': '{"path":{"id":"mch_1"},"query":{}}' },
				api: accepted
			});
			const notJson = yield* runAkua(['machines', 'delete', '--input', '-', '--json'], {
				env,
				inputs: { '-': '{"path":' },
				api: accepted
			});

			for (const result of [nullBody, extraPartition, notJson]) {
				expect(result.exitCode).toBe(2);
				expect(JSON.parse(result.stdout).error.code).toBe('AKUA_INPUT_INVALID');
				expect(result.requests).toEqual([]);
			}
		}).pipe(Effect.scoped)
	);
});

describe('authentication', () => {
	it.effect('anonymous operations send no credential and never read the config file', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, 'not an object');

			const result = yield* runAkua(['offers', 'resolve', '--short-hash', 'abc', '--json'], {
				env: { HOME: home, AKUA_API_TOKEN: 'environment-token' },
				api: () => ({ body: { id: 'offer_1' } })
			});

			expect(result.exitCode).toBe(0);
			expect(result.requests[0]?.url.search).toBe('?short_hash=abc');
			expect(result.requests[0]?.headers.authorization).toBeUndefined();
		}).pipe(Effect.scoped)
	);

	it.effect('AKUA_API_TOKEN is the bearer token when set', () =>
		Effect.gen(function* () {
			const env = yield* signedIn;

			const result = yield* runAkua(['clusters', 'list', '--json'], {
				env: { ...env, AKUA_API_TOKEN: 'environment-token' },
				api: () => ({ body: { data: [] } })
			});

			expect(result.requests[0]?.headers.authorization).toBe('Bearer environment-token');
		}).pipe(Effect.scoped)
	);
});

describe('responses', () => {
	it.effect('keeps a structured API error without echoing request values', () =>
		Effect.gen(function* () {
			const env = yield* signedIn;
			const sentinel = 'secret-input-sentinel';
			const apiError = {
				success: false,
				errors: [{ code: 7002, message: 'Machine allocation conflicts.' }],
				result: {}
			};

			const result = yield* runAkua(
				[
					'machines',
					'create',
					'--cluster-id',
					'clu_1',
					'--instance-type',
					'cx23',
					'--name',
					sentinel,
					'--json'
				],
				{ env, api: () => ({ status: 409, body: apiError }) }
			);

			expect(result.exitCode).toBe(5);
			expect(JSON.parse(result.stdout).error).toMatchObject({
				type: 'api_error',
				code: 'AKUA_API_7002',
				status: 409,
				message: 'Machine allocation conflicts.',
				response: apiError
			});
			expect(result.stdout).not.toContain(sentinel);
		}).pipe(Effect.scoped)
	);

	it.effect('keeps a non-JSON error body as truncated raw text', () =>
		Effect.gen(function* () {
			const env = yield* signedIn;

			const result = yield* runAkua(['clusters', 'list', '--json'], {
				env,
				api: () => ({
					status: 502,
					text: `bad gateway\n${'x'.repeat(5000)}`,
					contentType: 'text/plain'
				})
			});

			const error = JSON.parse(result.stdout).error;
			expect(result.exitCode).toBe(6);
			expect(error.status).toBe(502);
			expect(error.response.raw.startsWith('bad gateway\\nxxx')).toBe(true);
			expect(error.response.raw.length).toBeLessThan(2100);
		}).pipe(Effect.scoped)
	);

	it.effect('a success body that is not JSON is a contract error', () =>
		Effect.gen(function* () {
			const env = yield* signedIn;

			const result = yield* runAkua(['clusters', 'list', '--json'], {
				env,
				api: () => ({ text: '<html>', contentType: 'text/html' })
			});

			expect(result.exitCode).toBe(6);
			expect(JSON.parse(result.stdout).error.code).toBe('AKUA_API_CONTRACT_ERROR');
		}).pipe(Effect.scoped)
	);

	it.effect('streams Server-Sent Events: JSON lines for machines, log content for people', () =>
		Effect.gen(function* () {
			const env = yield* signedIn;
			const events = [
				'event: message\ndata: {"content":"hello","podName":"web-0"}\n\n',
				'event: message\ndata: {"content":"world","podName":"web-0"}\n\n',
				'event: end\ndata: {}\n\n'
			].join('');
			const api = () => ({ text: events, contentType: 'text/event-stream' });

			const machine = yield* runAkua(['installs', 'get-logs', 'inst_1', '--tail', '2', '--json'], {
				env,
				api
			});
			const person = yield* runAkua(['installs', 'get-logs', 'inst_1'], { env, api, tty: true });

			expect(machine.requests[0]?.url.search).toBe('?tail=2');
			expect(
				machine.stdout
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line))
			).toEqual([
				{
					status: 'ok',
					command: 'akua installs get-logs',
					data: { event: 'message', data: '{"content":"hello","podName":"web-0"}' }
				},
				{
					status: 'ok',
					command: 'akua installs get-logs',
					data: { event: 'message', data: '{"content":"world","podName":"web-0"}' }
				},
				{ status: 'ok', command: 'akua installs get-logs', data: { event: 'end', data: '{}' } }
			]);
			expect(person.stdout).toBe('hello\nworld\n');
		}).pipe(Effect.scoped)
	);

	it.effect('a stream failure event becomes an API error', () =>
		Effect.gen(function* () {
			const env = yield* signedIn;
			const failure = JSON.stringify([{ _tag: 'Fail', error: { error: 'Pod not found' } }]);

			const result = yield* runAkua(['installs', 'get-logs', 'inst_1', '--json'], {
				env,
				api: () => ({
					text: `event: effect/http-api/stream/failure\ndata: ${failure}\n\n`,
					contentType: 'text/event-stream'
				})
			});

			expect(result.exitCode).toBe(1);
			expect(JSON.parse(result.stdout).error).toMatchObject({
				type: 'api_error',
				message: 'Pod not found'
			});
		}).pipe(Effect.scoped)
	);
});

describe('inputs that must not reach the API or the terminal', () => {
	it.effect('a dot segment in a path argument is rejected before transport', () =>
		Effect.gen(function* () {
			const env = yield* signedIn;

			const result = yield* runAkua(['clusters', 'get', '..', '--json'], { env, api: accepted });

			expect(result.exitCode).toBe(2);
			expect(result.requests).toEqual([]);
			expect(JSON.parse(result.stdout).error.code).toBe('AKUA_INPUT_INVALID');
		}).pipe(Effect.scoped)
	);

	it.effect('an unreadable config file is a config error, not "not signed in"', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, 'not an object');

			const result = yield* runAkua(['clusters', 'list', '-w', 'ws_team', '--json'], {
				env: { HOME: home },
				api: accepted
			});

			expect(result.requests).toEqual([]);
			expect(JSON.parse(result.stdout).error.code).toBe('AKUA_CONFIG_ERROR');
		}).pipe(Effect.scoped)
	);

	it.effect('an empty --workspace is a usage error instead of a silent fallback', () =>
		Effect.gen(function* () {
			const env = yield* signedIn;

			const result = yield* runAkua(['clusters', 'list', '--workspace=', '--json'], {
				env,
				api: accepted
			});

			expect(result.exitCode).toBe(2);
			expect(result.requests).toEqual([]);
			expect(JSON.parse(result.stdout).error.message).toBe('Missing value for --workspace.');
		}).pipe(Effect.scoped)
	);

	it.effect('a failed workspace lookup is reported as the lookup, not the command', () =>
		Effect.gen(function* () {
			const env = yield* signedIn;

			const result = yield* runAkua(['clusters', 'create', '-w', 'my-team', '--json'], {
				env,
				api: () => ({ status: 401, body: { success: false, errors: [], result: {} } })
			});

			expect(result.requests.map((request) => request.url.pathname)).toEqual(['/v1/workspaces']);
			expect(JSON.parse(result.stdout).error.next_steps).toEqual([
				{ command: 'akua auth login', description: 'Sign in again.' }
			]);
		}).pipe(Effect.scoped)
	);

	it.effect('a rejected flag value is never echoed back', () =>
		Effect.gen(function* () {
			const env = yield* signedIn;

			const result = yield* runAkua(
				[
					'installs',
					'create',
					'--region-id',
					'reg_1',
					'--initial-values',
					'{"t":"secret-value',
					'--json'
				],
				{ env, api: accepted }
			);

			expect(result.exitCode).toBe(2);
			expect(result.stdout).not.toContain('secret-value');
		}).pipe(Effect.scoped)
	);

	it.effect('--help in JSON mode names the command whose help it is', () =>
		Effect.gen(function* () {
			const result = yield* runAkua(['-o', 'json', 'clusters', 'create', '--help']);

			expect(JSON.parse(result.stdout).command).toBe('akua clusters create');
		}).pipe(Effect.scoped)
	);
});
