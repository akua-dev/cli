import { expect, it } from '@effect/vitest';
import { BunServices } from '@effect/platform-bun';
import { Effect, FileSystem, Layer } from 'effect';
import ts from 'typescript';

import {
	checkEffectApi,
	EffectApiGenerationFailure,
	generateEffectApi
} from '../scripts/generate-effect-api';
import {
	ScriptFiles,
	ScriptHostFailure,
	ScriptValidationFailure
} from '../scripts/runtime/services';

const sourcePath = '../../../docs/openapi-public.json';
const outputPath = 'src/generated/openapi-api.gen.ts';
const executorPath = 'src/generated/public-operation-executor.gen.ts';

it.effect('generates a typed HttpApi module from the public OpenAPI contract', () =>
	Effect.gen(function* () {
		let writtenApi = '';
		let writtenExecutor = '';
		const layer = Layer.succeed(ScriptFiles, {
			readText: () => Effect.succeed(JSON.stringify(publicSpec())),
			writeText: (path, contents) =>
				Effect.sync(() => {
					if (path === outputPath) writtenApi = contents;
					if (path === executorPath) writtenExecutor = contents;
				})
		});

		const generated = yield* generateEffectApi(sourcePath, outputPath).pipe(Effect.provide(layer));

		expect(writtenApi).toBe(generated);
		expect(writtenExecutor).toContain('case "secrets.create":');
		expect(generated).toContain('HttpApiEndpoint.post("secretsCreate", "/v1/secrets"');
		expect(generated).toContain('annotate(OpenApi.Identifier, "secrets.create")');
		expect(typeAssertions(generated)).toEqual([]);
		expect(generated).not.toMatch(/[ \t]+$/m);
	})
);

it.effect('generates only PUBLIC operations', () =>
	Effect.gen(function* () {
		const layer = Layer.succeed(ScriptFiles, {
			readText: () => Effect.succeed(JSON.stringify(specWithMixedVisibility())),
			writeText: () => Effect.void
		});

		const generated = yield* generateEffectApi(sourcePath, outputPath).pipe(Effect.provide(layer));

		expect(generated).toContain('HttpApiEndpoint.get("secretsList", "/v1/secrets"');
		expect(generated).toContain('pageSize');
		expect(generated).not.toContain('adminListSecrets');
	})
);

it.effect('preserves OpenAPI path templates for the client', () =>
	Effect.gen(function* () {
		const layer = Layer.succeed(ScriptFiles, {
			readText: () => Effect.succeed(JSON.stringify(specWithEmbeddedPathParameters())),
			writeText: () => Effect.void
		});

		const generated = yield* generateEffectApi(sourcePath, outputPath).pipe(Effect.provide(layer));

		expect(generated).toContain(
			'HttpApiEndpoint.post("documentsSelectWorkspace", "/v1/documents/{id}.{format}:selectWorkspace"'
		);
		expect(generated).toContain('HttpApiEndpoint.get("documentsGetPath", "/v1/documents/{path:*}"');
	})
);

it.effect('fails with a typed error when the generator reports a public contract warning', () =>
	Effect.gen(function* () {
		const layer = Layer.succeed(ScriptFiles, {
			readText: () => Effect.succeed(JSON.stringify(specWithUnannotatedSse())),
			writeText: () => Effect.void
		});

		const failure = yield* Effect.flip(
			generateEffectApi(sourcePath, outputPath).pipe(Effect.provide(layer))
		);

		expect(failure).toBeInstanceOf(EffectApiGenerationFailure);
	})
);

it.effect('rejects missing OpenAPI metadata before generation', () =>
	Effect.gen(function* () {
		const layer = Layer.succeed(ScriptFiles, {
			readText: () => Effect.succeed(JSON.stringify(specWithMissingInfo())),
			writeText: () => Effect.void
		});

		const failure = yield* Effect.flip(
			generateEffectApi(sourcePath, outputPath).pipe(Effect.provide(layer))
		);

		expect(failure).toBeInstanceOf(ScriptValidationFailure);
	})
);

it.effect('detects generated API drift without overwriting the checked-in artifact', () =>
	Effect.gen(function* () {
		let writes = 0;
		const layer = Layer.succeed(ScriptFiles, {
			readText: (path) =>
				Effect.succeed(path === sourcePath ? JSON.stringify(publicSpec()) : 'stale artifact'),
			writeText: () =>
				Effect.sync(() => {
					writes += 1;
				})
		});

		const failure = yield* Effect.flip(
			checkEffectApi(sourcePath, outputPath).pipe(Effect.provide(layer))
		);

		expect(failure).toBeInstanceOf(EffectApiGenerationFailure);
		expect(writes).toBe(0);
	})
);

it.effect('propagates generated artifact read failures instead of treating them as drift', () =>
	Effect.gen(function* () {
		const layer = Layer.succeed(ScriptFiles, {
			readText: (path) =>
				path === sourcePath
					? Effect.succeed(JSON.stringify(publicSpec()))
					: Effect.fail(new ScriptHostFailure({ cause: 'permission denied' })),
			writeText: () => Effect.void
		});

		const failure = yield* Effect.flip(
			checkEffectApi(sourcePath, outputPath).pipe(Effect.provide(layer))
		);

		expect(failure).toBeInstanceOf(ScriptHostFailure);
	})
);

it.effect('committed strict Effect API artifacts are assertion-free', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const artifact = yield* fs.readFileString(outputPath);
		const executor = yield* fs.readFileString(executorPath);

		expect(artifact).toContain('annotate(OpenApi.Identifier, "secrets.create")');
		expect(typeAssertions(artifact)).toEqual([]);
		expect(artifact).not.toMatch(/[ \t]+$/m);
		expect(executor).toContain('case "machines.create":');
	}).pipe(Effect.provide(BunServices.layer))
);

function publicSpec() {
	return {
		openapi: '3.1.0',
		info: { title: 'Public API', version: '1.0.0' },
		paths: {
			'/v1/secrets': {
				post: {
					operationId: 'secrets.create',
					'x-platform-visibility': 'PUBLIC',
					tags: ['Secrets'],
					parameters: [],
					security: [],
					responses: { 201: { description: 'Created' } }
				}
			}
		},
		components: { schemas: {}, securitySchemes: {} },
		security: [],
		tags: [{ name: 'Secrets' }]
	};
}

function specWithUnannotatedSse() {
	return {
		openapi: '3.1.0',
		info: { title: 'Public API', version: '1.0.0' },
		paths: {
			'/v1/logs': {
				get: {
					operationId: 'installs.getLogs',
					'x-platform-visibility': 'PUBLIC',
					tags: ['Installs'],
					parameters: [],
					security: [],
					responses: {
						200: {
							description: 'Logs',
							content: {
								'text/event-stream': { schema: { type: 'string' } }
							}
						}
					}
				}
			}
		},
		components: { schemas: {}, securitySchemes: {} },
		security: [],
		tags: [{ name: 'Installs' }]
	};
}

function specWithMissingInfo() {
	return {
		openapi: '3.1.0',
		paths: {
			'/v1/name': {
				get: {
					operationId: 'names.get',
					'x-platform-visibility': 'PUBLIC',
					tags: ['Names'],
					parameters: [],
					security: [],
					responses: {
						200: {
							description: 'Name',
							content: {
								'application/json': {
									schema: { $ref: '#/components/schemas/Name' }
								}
							}
						}
					}
				}
			}
		},
		components: {
			schemas: {
				Name: { type: 'string' }
			},
			securitySchemes: {}
		},
		security: [],
		tags: []
	};
}

function specWithMixedVisibility() {
	return {
		openapi: '3.1.0',
		info: { title: 'Public API', version: '1.0.0' },
		paths: {
			'/v1/secrets': {
				parameters: [
					{
						name: 'pageSize',
						in: 'query',
						required: false,
						schema: { type: 'integer' }
					}
				],
				get: {
					operationId: 'secrets.list',
					'x-platform-visibility': 'PUBLIC',
					tags: ['Secrets'],
					parameters: [],
					security: [],
					responses: { 200: { description: 'Secrets' } }
				}
			},
			'/v1/admin/secrets': {
				get: {
					operationId: 'admin.listSecrets',
					'x-platform-visibility': 'ADMIN',
					tags: ['Admin'],
					parameters: [],
					security: [],
					responses: { 200: { description: 'Secrets' } }
				}
			}
		},
		components: { schemas: {}, securitySchemes: {} },
		security: [],
		tags: [{ name: 'Secrets' }, { name: 'Admin' }]
	};
}

function specWithEmbeddedPathParameters() {
	return {
		openapi: '3.1.0',
		info: { title: 'Public API', version: '1.0.0' },
		paths: {
			'/v1/documents/{id}.{format}:selectWorkspace': {
				post: {
					operationId: 'documents.selectWorkspace',
					'x-platform-visibility': 'PUBLIC',
					tags: ['Documents'],
					parameters: [
						{
							name: 'id',
							in: 'path',
							required: true,
							schema: { type: 'string' }
						},
						{
							name: 'format',
							in: 'path',
							required: true,
							schema: { type: 'string' }
						}
					],
					security: [],
					responses: { 204: { description: 'Selected' } }
				}
			},
			'/v1/documents/{path:*}': {
				get: {
					operationId: 'documents.getPath',
					'x-platform-visibility': 'PUBLIC',
					tags: ['Documents'],
					parameters: [
						{
							name: 'path',
							in: 'path',
							required: true,
							schema: { type: 'string' }
						}
					],
					security: [],
					responses: { 204: { description: 'Found' } }
				}
			}
		},
		components: { schemas: {}, securitySchemes: {} },
		security: [],
		tags: [{ name: 'Documents' }]
	};
}

function typeAssertions(source: string): readonly ts.Node[] {
	const sourceFile = ts.createSourceFile(
		'openapi-api.gen.ts',
		source,
		ts.ScriptTarget.Latest,
		true
	);
	const assertions: ts.Node[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) assertions.push(node);
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return assertions;
}
