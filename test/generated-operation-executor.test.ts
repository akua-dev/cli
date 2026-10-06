import { Effect, FileSystem } from 'effect';
import { expect, it } from '@effect/vitest';
import { BunServices } from '@effect/platform-bun';
import ts from 'typescript';
import { commandRegistry } from '../src/generated/commands.gen';

const executorPath = 'src/generated/public-operation-executor.gen.ts';

it.effect('the generated executor represents every public OpenAPI operation', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		expect(yield* fs.exists(executorPath)).toBe(true);

		const source = yield* fs.readFileString(executorPath);
		const operationIds = commandRegistry.map((command) => command.operation_id);

		expect(operationIds.length).toBeGreaterThan(0);
		for (const operationId of operationIds) {
			expect(source).toContain(`case ${JSON.stringify(operationId)}:`);
		}
		expect((source.match(/\bcase\s+"[^"]+":/g) ?? []).length).toBe(operationIds.length);
		expect(operationIds).toEqual(commandRegistry.map((command) => command.operation_id));
	}).pipe(Effect.provide(BunServices.layer))
);

it.effect('the generated executor is static and assertion-free', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		expect(yield* fs.exists(executorPath)).toBe(true);

		const source = yield* fs.readFileString(executorPath);
		expect(source).toContain('export type PublicOperationId =');
		expect(source).toContain('export function executePublicOperation(');
		expect(source).not.toContain('Reflect');
		expect(typeAssertions(source)).toEqual([]);
		expect(source).not.toMatch(/\b(?:async|await|Promise|throw)\b/);
	}).pipe(Effect.provide(BunServices.layer))
);

function typeAssertions(source: string): string[] {
	const file = ts.createSourceFile(executorPath, source, ts.ScriptTarget.Latest, true);
	const assertions: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
			assertions.push(node.getText(file));
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return assertions;
}
