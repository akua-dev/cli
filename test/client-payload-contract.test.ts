import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import ts from 'typescript';

it.effect('typed client preserves JSON payload unions and optional multipart encoding', () =>
	Effect.sync(() => {
		const fileName = 'test/client-payload-contract-fixture.ts';
		const source = `
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiSchema } from 'effect/http-api';
const first = Schema.Struct({ mode: Schema.Literal('first'), count: Schema.Number });
const second = Schema.Struct({ mode: Schema.Literal('second'), enabled: Schema.Boolean });
const json = Schema.Union([first, second]);
type JsonRequest = HttpApiEndpoint.ClientRequest<never, never, typeof json, never, 'decoded-only'>;
declare const jsonPayload: Schema.Schema.Type<typeof json>;
declare const sendJson: (request: JsonRequest) => void;
sendJson({ payload: jsonPayload });
// @ts-expect-error an unrelated payload is not accepted
sendJson({ payload: { mode: 'third' } });
type OptionalRequest = HttpApiEndpoint.ClientRequest<never, never, typeof first | typeof Schema.Void, never, 'decoded-only'>;
declare const optionalPayload: Schema.Schema.Type<typeof first> | undefined;
declare const sendOptional: (request: OptionalRequest) => void;
sendOptional({ payload: optionalPayload });
const multipart = first.pipe(HttpApiSchema.asMultipart());
type MultipartRequest = HttpApiEndpoint.ClientRequest<never, never, typeof multipart | typeof Schema.Void, never, 'decoded-only'>;
declare const encodedPayload: FormData | undefined;
declare const sendMultipart: (request: MultipartRequest) => void;
sendMultipart({ payload: encodedPayload });
// @ts-expect-error multipart payloads must be encoded as FormData
sendMultipart({ payload: { mode: 'first', count: 1 } });
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
	})
);
