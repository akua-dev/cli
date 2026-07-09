import { ExitCodes, type ExitCode } from "./exit-codes";

export interface NextStep {
  command: string;
  description?: string;
}

export interface CliErrorOptions {
  type: string;
  code: string;
  message: string;
  status?: number;
  path?: readonly string[];
  requestId?: string;
  retryAfter?: string | number | null;
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
  readonly exitCode: ExitCode;

  constructor(options: CliErrorOptions) {
    super(options.message);
    this.name = "AkuaCliError";
    this.type = options.type;
    this.code = options.code;
    this.status = options.status;
    this.path = options.path ?? [];
    this.requestId = options.requestId;
    this.retryAfter = options.retryAfter;
    this.nextSteps = options.nextSteps ?? [];
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
        next_steps: this.nextSteps.length > 0 ? this.nextSteps : undefined,
      },
    };
  }
}

export function usageError(message: string): AkuaCliError {
  return new AkuaCliError({
    type: "usage_error",
    code: "AKUA_USAGE_ERROR",
    message,
    exitCode: ExitCodes.Usage,
    nextSteps: [{ command: "akua --help" }],
  });
}

export function commandNotImplemented(operationId: string): AkuaCliError {
  return new AkuaCliError({
    type: "not_implemented",
    code: "AKUA_COMMAND_NOT_IMPLEMENTED",
    message: `Operation ${operationId} is registered but command execution is not implemented yet.`,
    exitCode: ExitCodes.Usage,
    nextSteps: [
      { command: "akua commands" },
      { command: `akua commands --operation-id ${operationId}` },
    ],
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
