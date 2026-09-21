import { describe, expect, test } from '@effect/vitest';
import { Effect, Layer, Schema, Stream } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { HttpApi, HttpApiClient, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';

import { generatedCommandView } from '../src/commands/generated';
import { GeneratedCommandFailure } from '../src/commands/generated';
import { commandRegistry } from '../src/generated/commands.gen';
import * as Api from '../src/generated/openapi-api.gen';
import { generatedCommandError } from '../src/runtime/errors';
import { PublicApiClientLive } from '../src/runtime/public-api';
import { PublicInput, SecureConfig, SecureConfigFailure } from '../src/runtime/services';

describe('generated public commands', () => {
	test('compiles brace templates without breaking legacy colon parameters', () => {
		const params = Schema.Struct({
			id: Schema.optional(Schema.String),
			format: Schema.optional(Schema.String),
			path: Schema.optional(Schema.String)
		});
		const api = HttpApi.make('pathCompatibility').add(
			HttpApiGroup.make('paths')
				.add(
					HttpApiEndpoint.get('legacy', '/documents/:id.:format', {
						params,
						success: Schema.Void
					})
				)
				.add(
					HttpApiEndpoint.get('optional', '/documents/:id?', {
						params,
						success: Schema.Void
					})
				)
				.add(
					HttpApiEndpoint.get('template', '/documents/{id}.{format}:selectWorkspace', {
						params,
						success: Schema.Void
					})
				)
				.add(
					HttpApiEndpoint.get('wildcard', '/documents/{path:*}', {
						params,
						success: Schema.Void
					})
				)
				.add(
					HttpApiEndpoint.get('customVerb', '/offers:resolve', {
						success: Schema.Void
					})
				)
		);
		const urls = HttpApiClient.urlBuilder(api, {
			baseUrl: 'https://api.example.test/v1'
		});

		expect(urls.paths.legacy({ params: { id: 'document/id', format: 'json' } })).toBe(
			'https://api.example.test/documents/document%2Fid.json'
		);
		expect(urls.paths.optional({ params: {} })).toBe('https://api.example.test/documents');
		expect(urls.paths.template({ params: { id: 'document/id', format: 'json' } })).toBe(
			'https://api.example.test/documents/document%2Fid.json:selectWorkspace'
		);
		expect(urls.paths.wildcard({ params: { path: 'api/v1/node:name' } })).toBe(
			'https://api.example.test/documents/api/v1/node%3Aname'
		);
		expect(urls.paths.customVerb()).toBe('https://api.example.test/offers:resolve');
	});

	test('workspaces.list sends the decoded query and bearer token', async () => {
		let received: Request | undefined;
		const result = await runGenerated(
			'workspaces.list',
			['--input', '-'],
			'{"query":{"limit":2}}',
			(input, init) => {
				received = new Request(input, init);
				return Promise.resolve(Response.json({ data: [], has_more: false, next_cursor: null }));
			}
		);

		expect(result.data).toEqual({
			data: [],
			has_more: false,
			next_cursor: null
		});
		expect(received?.url).toBe('https://api.akua.dev/v1/workspaces?limit=2');
		expect(received?.method).toBe('GET');
		expect(received?.headers.get('authorization')).toBe('Bearer test-token');
	});

	test('machines.create permits an omitted optional compute config and decodes 202', async () => {
		let received: Request | undefined;
		const body = {
			cluster_id: 'clu_123',
			instance_type: 'cx23'
		};
		const operation = machineOperation();
		const result = await runGenerated(
			'machines.create',
			['--input', '-'],
			JSON.stringify({
				headers: {
					'akua-context': 'ws_123',
					'idempotency-key': 'quickstart-worker'
				},
				body
			}),
			(input, init) => {
				received = new Request(input, init);
				return Promise.resolve(Response.json(operation, { status: 202 }));
			}
		);

		expect(result.data).toEqual(operation);
		expect(received?.url).toBe('https://api.akua.dev/v1/machines');
		expect(received?.method).toBe('POST');
		expect(received?.headers.get('akua-context')).toBe('ws_123');
		expect(received?.headers.get('idempotency-key')).toBe('quickstart-worker');
		expect(await received?.json()).toEqual(body);
	});

	test('machines.list accepts a system-managed machine without a compute config', async () => {
		const machines = {
			data: [
				{
					id: 'mch_system-managed',
					workspace_id: 'ws_123',
					cluster_id: 'clu_123',
					provider_id: 'compute://hcloud/server-1234',
					provider_resource: {
						identity_kind: 'recyclable',
						public_ip: null
					},
					node_name: null,
					state: 'PROVISIONING',
					reconciling: true,
					created_at: 1_789_133_184,
					updated_at: 1_789_133_184,
					etag: '0'
				}
			],
			has_more: false,
			next_cursor: null
		};

		const result = await runGenerated(
			'machines.list',
			['--input', '-'],
			JSON.stringify({
				headers: { 'akua-context': 'ws_123' },
				query: { cluster_id: 'clu_123' }
			}),
			() => Promise.resolve(Response.json(machines))
		);

		expect(result.data).toEqual(machines);
	});

	test('operations.list forwards the workspace context header', async () => {
		let received: Request | undefined;
		const result = await runGenerated(
			'operations.list',
			['--input', '-'],
			JSON.stringify({ headers: { 'akua-context': 'ws_123' } }),
			(input, init) => {
				received = new Request(input, init);
				return Promise.resolve(Response.json({ data: [], has_more: false, next_cursor: null }));
			}
		);

		expect(result.data).toEqual({
			data: [],
			has_more: false,
			next_cursor: null
		});
		expect(received?.url).toBe('https://api.akua.dev/v1/operations');
		expect(received?.headers.get('akua-context')).toBe('ws_123');
	});

	test('quotas.list accepts a lifetime quota response', async () => {
		const quotas = {
			data: [
				{
					metric: 'compute/managed_vm_trial',
					type: 'lifetime',
					scope: 'principal',
					display_name: 'Managed VM trial',
					unit: 'count',
					limit: 1,
					usage: 0,
					remaining: 1,
					grant_state: 'available'
				}
			],
			has_more: false,
			next_cursor: null
		};

		const result = await runGenerated(
			'quotas.list',
			['--input', '-'],
			JSON.stringify({ headers: { 'akua-context': 'ws_123' } }),
			() => Promise.resolve(Response.json(quotas))
		);

		expect(result.data).toEqual(quotas);
	});

	test('quotas.get forwards the workspace context header and cluster_id query', async () => {
		let received: Request | undefined;
		const quota = {
			metric: 'kaas/clusters',
			type: 'allocation',
			scope: 'workspace',
			display_name: 'Managed clusters',
			unit: 'count',
			limit: 3,
			usage: 1,
			remaining: 2
		};

		const result = await runGenerated(
			'quotas.get',
			['--input', '-'],
			JSON.stringify({
				path: { metric: 'kaas/clusters' },
				query: { cluster_id: 'clu_123' },
				headers: { 'akua-context': 'ws_123' }
			}),
			(input, init) => {
				received = new Request(input, init);
				return Promise.resolve(Response.json(quota));
			}
		);

		expect(result.data).toEqual(quota);
		expect(received?.url).toBe('https://api.akua.dev/v1/quotas/kaas%2Fclusters?cluster_id=clu_123');
		expect(received?.headers.get('akua-context')).toBe('ws_123');
	});

	test('clusters.resume builds the literal :action-suffixed request path', async () => {
		let received: Request | undefined;
		const operation = clusterOperation();
		const result = await runGenerated(
			'clusters.resume',
			['--input', '-'],
			JSON.stringify({
				path: { id: 'clu_123' },
				headers: { 'if-match': 'etag-1' }
			}),
			(input, init) => {
				received = new Request(input, init);
				return Promise.resolve(Response.json(operation, { status: 202 }));
			}
		);

		expect(result.data).toEqual(operation);
		expect(received?.method).toBe('POST');
		expect(received?.url).toBe('https://api.akua.dev/v1/clusters/clu_123:resume');
		expect(received?.headers.get('if-match')).toBe('etag-1');
	});

	test('machines.resume builds the literal :action-suffixed request path', async () => {
		let received: Request | undefined;
		const operation = machineOperation();
		const result = await runGenerated(
			'machines.resume',
			['--input', '-'],
			JSON.stringify({
				path: { id: 'mch_123' },
				headers: { 'if-match': 'etag-1', 'idempotency-key': 'resume-once' }
			}),
			(input, init) => {
				received = new Request(input, init);
				return Promise.resolve(Response.json(operation, { status: 202 }));
			}
		);

		expect(result.data).toEqual(operation);
		expect(received?.method).toBe('POST');
		expect(received?.url).toBe('https://api.akua.dev/v1/machines/mch_123:resume');
		expect(received?.headers.get('if-match')).toBe('etag-1');
	});

	test('order-drafts select-workspace sends a literal custom verb suffix', async () => {
		let received: Request | undefined;
		await expect(
			runGenerated(
				'orderDrafts.selectWorkspace',
				['--input', '-'],
				JSON.stringify({
					path: { id: 'odft:123' },
					headers: { 'if-match': '0' },
					body: { kind: 'existing', workspace_id: 'ws_123' }
				}),
				(input, init) => {
					received = new Request(input, init);
					return Promise.resolve(
						Response.json(
							{
								success: false,
								errors: [{ code: 5, message: 'Order draft not found.' }],
								result: {}
							},
							{ status: 404 }
						)
					);
				}
			)
		).rejects.toMatchObject({ reason: 'api', status: 404 });

		expect(received?.method).toBe('POST');
		expect(received?.url).toBe('https://api.akua.dev/v1/order_drafts/odft%3A123:selectWorkspace');
	});

	test('clusters proxy-kube preserves wildcard path separators', async () => {
		let received: Request | undefined;
		const result = await runGenerated(
			'clusters.proxyKube',
			['--input', '-'],
			JSON.stringify({
				path: { id: 'clu:123', path: 'api/v1/nodes' }
			}),
			(input, init) => {
				received = new Request(input, init);
				return Promise.resolve(new Response(null, { status: 200 }));
			}
		);

		expect(result.data).toBeUndefined();
		expect(received?.url).toBe(
			'https://api.akua.dev/v1/clusters/clu%3A123/kube_proxy/api/v1/nodes'
		);
	});

	test('optional request bodies are omitted from the request', async () => {
		let received: Request | undefined;
		await expect(
			runGenerated(
				'orderDrafts.createWorkerBootstrap',
				['--input', '-'],
				'{"path":{"id":"odft_123"}}',
				(input, init) => {
					received = new Request(input, init);
					return Promise.resolve(orderDraftNotFoundResponse());
				}
			)
		).rejects.toMatchObject({
			_tag: 'GeneratedCommandFailure',
			reason: 'api',
			status: 404
		});

		expect(received?.headers.get('content-type')).toBeNull();
		expect(await received?.text()).toBe('');
	});

	test('optional request bodies preserve explicit JSON values', async () => {
		let received: Request | undefined;
		await expect(
			runGenerated(
				'orderDrafts.createWorkerBootstrap',
				['--input', '-'],
				'{"path":{"id":"odft_123"},"body":{"ttl_seconds":60}}',
				(input, init) => {
					received = new Request(input, init);
					return Promise.resolve(orderDraftNotFoundResponse());
				}
			)
		).rejects.toMatchObject({
			_tag: 'GeneratedCommandFailure',
			reason: 'api',
			status: 404
		});

		expect(received?.headers.get('content-type')).toContain('application/json');
		expect(await received?.json()).toEqual({ ttl_seconds: 60 });
	});

	test('explicit null optional request bodies are rejected before transport', async () => {
		let requests = 0;
		await expect(
			runGenerated(
				'orderDrafts.createWorkerBootstrap',
				['--input', '-'],
				'{"path":{"id":"odft_123"},"body":null}',
				() => {
					requests += 1;
					return Promise.resolve(Response.json({}));
				}
			)
		).rejects.toMatchObject({
			_tag: 'GeneratedCommandFailure',
			reason: 'input'
		});

		expect(requests).toBe(0);
	});

	test('rejects malformed and excess input before transport', async () => {
		let requests = 0;
		const transport = () => {
			requests += 1;
			return Promise.resolve(Response.json({}));
		};

		await expect(
			runGenerated(
				'machines.create',
				['--input', '-'],
				'{"body":{"cluster_id":"clu_123","instance_type":"cx23","compute_config_id":"ccfg_123","secret":"sentinel"}}',
				transport
			)
		).rejects.toMatchObject({ _tag: 'GeneratedCommandFailure', reason: 'input' });
		await expect(
			runGenerated('machines.create', ['--input', '-'], '{"body":', transport)
		).rejects.toMatchObject({ _tag: 'GeneratedCommandFailure', reason: 'input' });
		await expect(
			runGenerated(
				'agents.archive',
				['--input', '-'],
				'{"path":{"id":"agt_123"},"query":{}}',
				transport
			)
		).rejects.toMatchObject({ _tag: 'GeneratedCommandFailure', reason: 'input' });
		await expect(
			runGenerated(
				'agents.archive',
				['--input', '-'],
				'{"path":{"id":"agt_123"},"headers":{}}',
				transport
			)
		).rejects.toMatchObject({ _tag: 'GeneratedCommandFailure', reason: 'input' });
		expect(requests).toBe(0);
	});

	test('preserves a structured generated 409 without request values', async () => {
		const sentinel = 'secret-input-sentinel';
		await expect(
			runGenerated(
				'machines.create',
				['--input', '-'],
				JSON.stringify({
					body: {
						cluster_id: 'clu_123',
						instance_type: 'cx23',
						compute_config_id: 'ccfg_123',
						name: sentinel
					}
				}),
				() =>
					Promise.resolve(
						Response.json(
							{
								success: false,
								errors: [{ code: 7002, message: 'Machine allocation conflicts.' }],
								result: {}
							},
							{ status: 409 }
						)
					)
			)
		).rejects.toMatchObject({
			_tag: 'GeneratedCommandFailure',
			reason: 'api',
			status: 409,
			apiError: {
				success: false,
				errors: [{ code: 7002, message: 'Machine allocation conflicts.' }],
				result: {}
			}
		});

		try {
			await runGenerated(
				'machines.create',
				['--input', '-'],
				JSON.stringify({
					body: {
						cluster_id: 'clu_123',
						instance_type: 'cx23',
						compute_config_id: 'ccfg_123',
						name: sentinel
					}
				}),
				() => Promise.reject(new Error('transport failed'))
			);
		} catch (failure) {
			expect(JSON.stringify(failure)).not.toContain(sentinel);
		}
	});

	test('offers.resolve executes anonymously without a bearer token', async () => {
		const execution = runAnonymousOffer({ env: {} });
		await expect(execution.result).rejects.toMatchObject({
			_tag: 'GeneratedCommandFailure',
			reason: 'api',
			status: 404
		});
		expect(execution.request()?.headers.has('authorization')).toBe(false);
	});

	test('anonymous operations ignore environment credentials', async () => {
		const execution = runAnonymousOffer({
			env: { AKUA_API_TOKEN: 'environment-token', HOME: '/users/test' }
		});
		await expect(execution.result).rejects.toMatchObject({
			reason: 'api',
			status: 404
		});

		expect(execution.request()?.headers.has('authorization')).toBe(false);
	});

	test('anonymous operations do not read stored credentials', async () => {
		let configReads = 0;
		const execution = runAnonymousOffer({
			env: { HOME: '/users/test' },
			readToken: () =>
				Effect.sync(() => {
					configReads += 1;
					return 'stored-token';
				})
		});
		await expect(execution.result).rejects.toMatchObject({
			reason: 'api',
			status: 404
		});

		expect(configReads).toBe(0);
		expect(execution.request()?.headers.has('authorization')).toBe(false);
	});

	test('anonymous operations do not read malformed credential config', async () => {
		let configReads = 0;
		const execution = runAnonymousOffer({
			env: { HOME: '/users/test' },
			readToken: () => {
				configReads += 1;
				return Effect.fail(
					new SecureConfigFailure({
						operation: 'read',
						path: '/users/test/.config/akua/config.json',
						cause: 'malformed JSON'
					})
				);
			}
		});
		await expect(execution.result).rejects.toMatchObject({
			reason: 'api',
			status: 404
		});

		expect(configReads).toBe(0);
		expect(execution.request()?.headers.has('authorization')).toBe(false);
	});

	test('installs.getLogs exposes decoded SSE events as a stream', async () => {
		const result = await runGenerated(
			'installs.getLogs',
			['--input', '-'],
			'{"path":{"id":"inst_123"},"query":{"follow":false}}',
			() =>
				Promise.resolve(
					new Response('event: message\ndata: first line\n\nevent: end\ndata: {}\n\n', {
						headers: { 'content-type': 'text/event-stream' }
					})
				)
		);
		const stream = result.stream;

		expect(Stream.isStream(stream)).toBe(true);
		if (!Stream.isStream(stream)) return;
		expect(await Effect.runPromise(Stream.runCollect(stream))).toEqual([
			{ event: 'message', data: 'first line' },
			{ event: 'end', data: '{}' }
		]);
	});

	test('classifies invalid success payloads as response contract failures', async () => {
		await expect(
			runGenerated('workspaces.list', [], '{}', () =>
				Promise.resolve(Response.json({ unexpected: true }))
			)
		).rejects.toMatchObject({
			_tag: 'GeneratedCommandFailure',
			reason: 'response',
			status: 200
		});
	});

	test('input schema failures carry issue details and a runnable example', async () => {
		await expect(
			runGenerated('workspaces.listMembers', [], '{}', () => Promise.resolve(Response.json({})))
		).rejects.toMatchObject({
			_tag: 'GeneratedCommandFailure',
			reason: 'input',
			command: 'workspaces list-members',
			issues: [{ path: ['path', 'id'], message: 'Missing key' }],
			inputExample: '{"path":{"id":"<id>"}}'
		});
	});

	test('input excess-property failures name the offending body key', async () => {
		await expect(
			runGenerated(
				'machines.create',
				['--input', '-'],
				'{"body":{"cluster_id":"clu_123","instance_type":"cx23","compute_config_id":"ccfg_123","secret":"sentinel"}}',
				() => Promise.resolve(Response.json({}))
			)
		).rejects.toMatchObject({
			_tag: 'GeneratedCommandFailure',
			reason: 'input',
			issues: [{ path: ['body', 'secret'], message: 'Expected no excess property' }],
			inputExample: '{"body":{"cluster_id":"<cluster_id>","instance_type":"<instance_type>"}}'
		});
	});

	test('input examples follow the operation body contract, not the HTTP method', async () => {
		// Bodyless POST: the example must not suggest a body envelope key.
		await expect(
			runGenerated('offers.archive', ['--input', '-'], '{"path":{"id":"off_1"},"bogus":{}}', () =>
				Promise.resolve(Response.json({}))
			)
		).rejects.toMatchObject({
			_tag: 'GeneratedCommandFailure',
			reason: 'input',
			inputExample: '{"path":{"id":"<id>"},"headers":{"if-match":"<if-match>"}}'
		});

		// Optional body without required fields: the example omits the body.
		await expect(
			runGenerated('machines.update', ['--input', '-'], '{"path":{"id":"mch_1"},"bogus":{}}', () =>
				Promise.resolve(Response.json({}))
			)
		).rejects.toMatchObject({
			_tag: 'GeneratedCommandFailure',
			reason: 'input',
			inputExample: '{"path":{"id":"<id>"},"headers":{"if-match":"<if-match>"}}'
		});
	});

	test('renders input issues with envelope hint and runnable next step', () => {
		const payload = generatedCommandError(
			new GeneratedCommandFailure({
				operationId: 'workspaces.listMembers',
				reason: 'input',
				command: 'workspaces list-members',
				issues: [{ path: ['path', 'id'], message: 'Missing key' }],
				inputExample: '{"path":{"id":"<id>"}}'
			})
		).toPayload();

		expect(payload.error.message).toBe(
			'Input for workspaces.listMembers does not match the public API contract: path.id: Missing key.'
		);
		expect(payload.error.next_steps).toEqual([
			{
				command: 'echo \'{"path":{"id":"<id>"}}\' | akua workspaces list-members --input -',
				description:
					'Pass a JSON envelope whose keys mirror the OpenAPI parameter locations: {"path":{...},"query":{...},"headers":{...},"body":{...}}.'
			}
		]);
	});

	test('decodes undeclared-status ApiErrorResponse bodies structurally', async () => {
		const body = {
			success: false,
			errors: [
				{
					code: 9001,
					message: 'Workspace member listing is not implemented yet'
				}
			],
			result: {}
		};
		const failure = await runGenerated(
			'workspaces.listMembers',
			['--input', '-'],
			'{"path":{"id":"ws_123"}}',
			() => Promise.resolve(Response.json(body, { status: 501 }))
		).then(
			() => undefined,
			(caught: unknown) => caught
		);

		expect(failure).toMatchObject({
			_tag: 'GeneratedCommandFailure',
			reason: 'api',
			status: 501,
			apiError: body
		});
		if (!(failure instanceof GeneratedCommandFailure)) return;
		const payload = generatedCommandError(failure).toPayload();
		expect(payload.error).toMatchObject({
			status: 501,
			code: 'AKUA_API_9001',
			message: 'Workspace member listing is not implemented yet',
			response: body
		});
	});

	test('extracts the server message from long undeclared-status JSON bodies', async () => {
		const body = JSON.stringify({
			message: 'Not implemented yet',
			detail: 'x'.repeat(3000)
		});
		await expect(
			runGenerated('workspaces.listMembers', ['--input', '-'], '{"path":{"id":"ws_123"}}', () =>
				Promise.resolve(
					new Response(body, {
						status: 501,
						headers: { 'content-type': 'application/json' }
					})
				)
			)
		).rejects.toMatchObject({
			_tag: 'GeneratedCommandFailure',
			reason: 'api',
			status: 501,
			responseBody: body.slice(0, 2000),
			responseMessage: 'Not implemented yet'
		});
	});

	test('falls back to the top-level message when the errors array is empty', async () => {
		await expect(
			runGenerated('workspaces.listMembers', ['--input', '-'], '{"path":{"id":"ws_123"}}', () =>
				Promise.resolve(
					Response.json({ errors: [], message: 'fallback message wins' }, { status: 501 })
				)
			)
		).rejects.toMatchObject({
			_tag: 'GeneratedCommandFailure',
			reason: 'api',
			status: 501,
			responseMessage: 'fallback message wins'
		});
	});

	test('keeps undeclared-status non-JSON bodies as truncated response detail', async () => {
		const longBody = `upstream said:\nbad gateway\n${'x'.repeat(3000)}`;
		const failure = await runGenerated(
			'workspaces.listMembers',
			['--input', '-'],
			'{"path":{"id":"ws_123"}}',
			() =>
				Promise.resolve(
					new Response(longBody, {
						status: 502,
						headers: { 'content-type': 'text/plain' }
					})
				)
		).then(
			() => undefined,
			(caught: unknown) => caught
		);

		expect(failure).toBeInstanceOf(GeneratedCommandFailure);
		if (!(failure instanceof GeneratedCommandFailure)) return;
		expect(failure.reason).toBe('api');
		expect(failure.status).toBe(502);
		expect(failure.responseMessage).toBeUndefined();
		expect(failure.responseBody).toHaveLength(2000);
		expect(failure.responseBody).toBe(longBody.slice(0, 2000));

		const payload = generatedCommandError(failure).toPayload();
		expect(payload.error.message).toBe('The public API rejected the request.');
		// Raw bodies render wrapped and flattened so line-oriented output stays
		// one value per line and the JSON response field stays object-typed.
		expect(payload.error.response).toEqual({
			raw: longBody.slice(0, 2000).replaceAll('\n', '\\n')
		});
	});

	test('renders the extracted server message for undeclared statuses', () => {
		const payload = generatedCommandError(
			new GeneratedCommandFailure({
				operationId: 'workspaces.listMembers',
				reason: 'api',
				status: 501,
				responseBody: '{"message":"Not implemented"}',
				responseMessage: 'Not implemented'
			})
		).toPayload();

		expect(payload.error).toMatchObject({
			status: 501,
			code: 'AKUA_API_ERROR',
			message: 'Not implemented',
			response: { raw: '{"message":"Not implemented"}' }
		});
	});

	test('classifies unknown internal failures as internal, not input', () => {
		const error = generatedCommandError(
			new GeneratedCommandFailure({
				operationId: 'workspaces.listMembers',
				reason: 'internal'
			})
		);

		expect(error.toPayload().error).toMatchObject({
			type: 'internal_error',
			code: 'AKUA_CLI_INTERNAL'
		});
		expect(error.exitCode).toBe(1);
	});

	test('enriches mid-stream failures instead of labeling them api errors', async () => {
		const encoder = new TextEncoder();
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				if (pulls === 1) {
					controller.enqueue(encoder.encode('event: message\ndata: first line\n\n'));
					return;
				}
				controller.error(new Error('connection reset'));
			}
		});
		const result = await runGenerated(
			'installs.getLogs',
			['--input', '-'],
			'{"path":{"id":"inst_123"},"query":{"follow":false}}',
			() =>
				Promise.resolve(
					new Response(body, {
						headers: { 'content-type': 'text/event-stream' }
					})
				)
		);
		const stream = result.stream;
		expect(Stream.isStream(stream)).toBe(true);
		if (!Stream.isStream(stream)) return;

		const failure = await Effect.runPromise(Stream.runCollect(stream)).then(
			() => undefined,
			(caught: unknown) => caught
		);
		expect(failure).toMatchObject({
			_tag: 'GeneratedCommandFailure',
			reason: 'transport'
		});
	});

	test('keeps HTTP status separate from the structured API error', () => {
		const apiError: typeof Api.ApiErrorResponse.Type = {
			success: false,
			errors: [{ code: 7002, message: 'Machine allocation conflicts.' }],
			result: {}
		};
		const payload = generatedCommandError(
			new GeneratedCommandFailure({
				operationId: 'machines.create',
				reason: 'api',
				status: 409,
				apiError
			})
		).toPayload();

		expect(payload.error).toMatchObject({
			status: 409,
			code: 'AKUA_API_7002',
			response: apiError
		});
	});
});

interface RunGeneratedOptions {
	readonly env?: Record<string, string | undefined>;
	readonly readToken?: () => Effect.Effect<string | undefined, SecureConfigFailure>;
}

function runGenerated(
	operationId: string,
	argv: readonly string[],
	input: string,
	fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
	options: RunGeneratedOptions = {}
) {
	const definition = commandRegistry.find((candidate) => candidate.operation_id === operationId);
	if (definition === undefined) {
		return Promise.reject(new Error(`Missing ${operationId}`));
	}
	const services = Layer.mergeAll(
		Layer.succeed(PublicInput, { read: () => Effect.succeed(input) }),
		Layer.succeed(SecureConfig, {
			readToken: options.readToken ?? (() => Effect.succeed(undefined)),
			saveToken: () => Effect.void,
			removeToken: () => Effect.succeed(false)
		}),
		FetchHttpClient.layer
	);
	return Effect.runPromise(
		generatedCommandView(definition, argv).pipe(
			Effect.provide(
				PublicApiClientLive(
					options.env ?? { AKUA_API_TOKEN: 'test-token' },
					definition.requires_auth
				)
			),
			Effect.provide(services),
			Effect.provideService(
				FetchHttpClient.Fetch,
				Object.assign(fetch, { preconnect: () => undefined })
			)
		)
	);
}

function runAnonymousOffer(options: RunGeneratedOptions) {
	let received: Request | undefined;
	return {
		request: () => received,
		result: runGenerated(
			'offers.resolve',
			['--input', '-'],
			'{"query":{"short_hash":"offer123"}}',
			(input, init) => {
				received = new Request(input, init);
				return Promise.resolve(
					Response.json(
						{
							success: false,
							errors: [{ code: 7002, message: 'Offer not found.' }],
							result: {}
						},
						{ status: 404 }
					)
				);
			},
			options
		)
	};
}

function clusterOperation() {
	return {
		id: 'op_456',
		workspace_id: 'ws_123',
		organization_id: null,
		owner_type: 'cluster',
		owner_id: 'clu_123',
		parent_operation_id: null,
		state: 'RUNNING',
		done: false,
		html_url: 'https://akua.dev/clusters/clu_123',
		metadata: {
			type: 'cluster.resume',
			cluster_id: 'clu_123'
		},
		response: null,
		error: null,
		last_error: null,
		started_at: 1,
		completed_at: null
	};
}

function machineOperation() {
	return {
		id: 'op_123',
		operation_id: 'op_123',
		workspace_id: 'ws_123',
		organization_id: null,
		owner_type: 'machine',
		owner_id: 'mch_123',
		parent_operation_id: null,
		state: 'RUNNING',
		done: false,
		html_url: 'https://akua.dev/machines/mch_123',
		metadata: {
			type: 'machine.create',
			workspace_id: 'ws_123',
			cluster_id: 'clu_123',
			compute_config_id: 'ccfg_123',
			instance_type: 'cx23',
			managed: true,
			request_fingerprint: 'fingerprint'
		},
		response: null,
		error: null,
		last_error: null,
		started_at: 1,
		completed_at: null
	};
}

function orderDraftNotFoundResponse() {
	return Response.json(
		{
			success: false,
			errors: [{ code: 7002, message: 'Order draft not found.' }],
			result: {}
		},
		{ status: 404 }
	);
}
