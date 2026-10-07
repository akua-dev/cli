import { Schema } from 'effect';

import { ExitCodes, type ExitCode } from './exit-codes';

const NextStepSchema = Schema.Struct({
	command: Schema.String,
	description: Schema.optional(Schema.String)
});
export type NextStep = typeof NextStepSchema.Type;

export interface CliErrorOptions {
	type: string;
	code: string;
	message: string;
	status?: number;
	path?: readonly string[];
	requestId?: string;
	retryAfter?: string | number | null;
	response?: unknown;
	nextSteps?: readonly NextStep[];
	exitCode?: ExitCode;
}

export class AkuaCliError extends Error {
	readonly type: string;
	readonly code: string;
	readonly status?: number;
	readonly path: readonly string[];
	readonly requestId?: string;
	readonly retryAfter?: string | number | null;
	readonly nextSteps: readonly NextStep[];
	readonly response?: unknown;
	readonly exitCode: ExitCode;

	constructor(options: CliErrorOptions) {
		super(options.message);
		this.name = 'AkuaCliError';
		this.type = options.type;
		this.code = options.code;
		this.status = options.status;
		this.path = options.path ?? [];
		this.requestId = options.requestId;
		this.retryAfter = options.retryAfter;
		this.nextSteps = Schema.decodeUnknownSync(Schema.Array(NextStepSchema))(
			options.nextSteps ?? []
		);
		this.response = options.response;
		this.exitCode = options.exitCode ?? exitCodeForStatus(options.status);
	}

	toPayload() {
		return {
			error: {
				type: this.type,
				code: this.code,
				status: this.status,
				message: this.message,
				path: this.path.length > 0 ? this.path : undefined,
				request_id: this.requestId,
				retry_after: this.retryAfter ?? undefined,
				response: this.response,
				next_steps: this.nextSteps.length > 0 ? this.nextSteps : undefined
			}
		};
	}
}

export function usageError(message: string, helpCommand = 'akua --help'): AkuaCliError {
	return new AkuaCliError({
		type: 'usage_error',
		code: 'AKUA_USAGE_ERROR',
		message,
		exitCode: ExitCodes.Usage,
		nextSteps: [{ command: helpCommand }]
	});
}

export function packageCommandError(): AkuaCliError {
	return new AkuaCliError({
		type: 'runtime_error',
		code: 'AKUA_PACKAGE_UNAVAILABLE',
		message: 'The embedded package toolchain could not be loaded.',
		exitCode: ExitCodes.Runtime,
		nextSteps: [
			{
				command: 'brew reinstall akua-dev/tap/akua',
				description: 'Reinstall the CLI and its native package toolchain.'
			}
		]
	});
}

function exitCodeForStatus(status: number | undefined): ExitCode {
	if (status === 401) {
		return ExitCodes.AuthRequired;
	}
	if (status === 409) {
		return ExitCodes.Conflict;
	}
	if (status === 429 || (status !== undefined && status >= 500)) {
		return ExitCodes.Retryable;
	}
	return ExitCodes.Runtime;
}
