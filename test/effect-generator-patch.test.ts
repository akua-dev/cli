import { expect, it } from '@effect/vitest';
import { BunServices } from '@effect/platform-bun';
import { Effect, FileSystem, Path, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import ts from 'typescript';

import { resolveBunBinary } from './bun-binary';

it.effect('patched Effect generator preserves headers and SSE contracts without warnings', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const directory = yield* fs.makeTempDirectoryScoped({
			prefix: 'akua-effect-generator-'
		});
		const specPath = path.join(directory, 'public.json');
		const outputPath = path.join(directory, 'public-api.gen.ts');

		yield* fs.writeFileString(specPath, JSON.stringify(specification()));
		const handle = yield* spawner.spawn(
			ChildProcess.make(resolveBunBinary(), [
				'x',
				'--no-install',
				'openapigen',
				'--spec',
				specPath,
				'--format',
				'httpapi',
				'--name',
				'PublicApi'
			])
		);
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[
				handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
				handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
				handle.exitCode
			],
			{ concurrency: 'unbounded' }
		);

		expect(exitCode).toBe(ChildProcessSpawner.ExitCode(0));
		expect(stderr).not.toContain('warning');
		yield* fs.writeFileString(outputPath, stdout);
		const output = yield* fs.readFileString(outputPath);
		expect(output).toContain('HttpApiSchema.WithHeaders');
		expect(output).toContain('WidgetsCreate201Headers');
		expect(output).toContain('HttpApiSchema.StreamSse({ events:');
		expect(output).toContain('payload: [WidgetsCreateRequestJson, HttpApiSchema.NoContent]');
		expect(output).toContain('readonly [x: string]: Schema.Json');
	}).pipe(Effect.provide(BunServices.layer))
);

it('Effect client accepts optional multipart as FormData or void, not an unencoded object', () => {
	const fileName = 'test/optional-multipart-contract.ts';
	const source = `
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiSchema } from 'effect/http-api';
const multipart = Schema.Struct({ name: Schema.String }).pipe(HttpApiSchema.asMultipart());
type Request = HttpApiEndpoint.ClientRequest<never, never, typeof multipart | typeof Schema.Void, never, 'decoded-only'>;
declare const upload: (request: Request) => void;
upload({ payload: new FormData() });
upload({ payload: undefined });
// @ts-expect-error multipart input must be encoded as FormData
upload({ payload: { name: 'widget' } });
`;
	const options: ts.CompilerOptions = {
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		types: [],
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		target: ts.ScriptTarget.ES2022
	};
	const host = ts.createCompilerHost(options);
	const getSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (name, languageVersion) =>
		name === fileName
			? ts.createSourceFile(name, source, languageVersion, true)
			: getSourceFile(name, languageVersion);
	const program = ts.createProgram([fileName], options, host);
	expect(
		ts
			.getPreEmitDiagnostics(program)
			.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
	).toEqual([]);
});

function specification() {
	return {
		openapi: '3.1.0',
		info: { title: 'Patch fixture', version: '1.0.0' },
		paths: {
			'/widgets': {
				post: {
					operationId: 'widgets.create',
					tags: ['Widgets'],
					requestBody: {
						required: false,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: { name: { type: 'string' } }
								}
							}
						}
					},
					responses: {
						201: {
							description: 'Created',
							headers: {
								Location: { required: true, schema: { type: 'string' } }
							}
						}
					}
				}
			},
			'/logs': {
				get: {
					operationId: 'installs.getLogs',
					tags: ['Installs'],
					responses: {
						200: {
							description: 'Logs',
							content: {
								'text/event-stream': {
									schema: {
										type: 'object',
										properties: {
											event: { type: 'string' },
											data: { type: 'string' }
										},
										required: ['event', 'data']
									},
									'x-effect-stream': {
										encoding: 'sse',
										errorSchema: {
											type: 'object',
											properties: { message: { type: 'string' } },
											required: ['message']
										}
									}
								}
							}
						}
					}
				}
			},
			'/metadata': {
				get: {
					operationId: 'metadata.get',
					tags: ['Metadata'],
					responses: {
						200: {
							description: 'Metadata',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										properties: { label: { type: 'string' } },
										additionalProperties: true
									}
								}
							}
						}
					}
				}
			}
		}
	};
}
