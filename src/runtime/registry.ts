import { Schema } from 'effect';

export interface CommandDefinition<OperationId extends string = string> {
	operation_id: OperationId;
	command: string;
	resource: string;
	action: string;
	method: string;
	path: string;
	tag: string;
	summary: string;
	visibility: 'PUBLIC';
	requires_auth: boolean;
	parameters: readonly CommandParameter[];
	body?: CommandBody;
}

export interface CommandBody {
	required: boolean;
	example: Readonly<Record<string, unknown>>;
}

export interface CommandParameter {
	name: string;
	in: 'path' | 'query' | 'header' | 'cookie';
	required: boolean;
}

export interface CommandInputExample {
	readonly path?: Readonly<Record<string, string>>;
	readonly query?: Readonly<Record<string, string>>;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: Readonly<Record<string, unknown>>;
}

export function commandInputExample(definition: CommandDefinition): CommandInputExample {
	const sections: {
		path?: Record<string, string>;
		query?: Record<string, string>;
		headers?: Record<string, string>;
		body?: Readonly<Record<string, unknown>>;
	} = {};
	for (const parameter of definition.parameters) {
		if (!parameter.required) continue;
		if (parameter.in === 'path') {
			(sections.path ??= {})[parameter.name] = `<${parameter.name}>`;
		} else if (parameter.in === 'query') {
			(sections.query ??= {})[parameter.name] = `<${parameter.name}>`;
		} else if (parameter.in === 'header') {
			(sections.headers ??= {})[parameter.name] = `<${parameter.name}>`;
		}
	}
	const body = definition.body;
	if (body !== undefined && (body.required || Object.keys(body.example).length > 0)) {
		sections.body = body.example;
	}
	return sections;
}

export function commandInputExampleJson(definition: CommandDefinition): string {
	return Schema.encodeSync(Schema.String)(JSON.stringify(commandInputExample(definition)));
}
