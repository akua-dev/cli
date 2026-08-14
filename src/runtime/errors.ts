import { ExitCodes, type ExitCode } from "./exit-codes";
import type {
  GeneratedCommandFailure,
  PublicInputIssue,
} from "../commands/generated";

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
    this.name = "AkuaCliError";
    this.type = options.type;
    this.code = options.code;
    this.status = options.status;
    this.path = options.path ?? [];
    this.requestId = options.requestId;
    this.retryAfter = options.retryAfter;
    this.nextSteps = options.nextSteps ?? [];
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

export function packageCommandError(): AkuaCliError {
  return new AkuaCliError({
    type: "runtime_error",
    code: "AKUA_PACKAGE_UNAVAILABLE",
    message: "The embedded package toolchain could not be loaded.",
    exitCode: ExitCodes.Runtime,
    nextSteps: [
      {
        command: "brew reinstall akua-dev/tap/akua",
        description: "Reinstall the CLI and its native package toolchain.",
      },
    ],
  });
}

export function generatedCommandError(
  failure: GeneratedCommandFailure,
): AkuaCliError {
  if (failure.reason === "usage") {
    return usageError(
      `Operation ${failure.operationId} accepts only --input - or --input <file>.`,
    );
  }
  if (failure.reason === "input") {
    const detail = (failure.issues ?? []).map(formatInputIssue).join("; ");
    return new AkuaCliError({
      type: "input_error",
      code: "AKUA_INPUT_INVALID",
      message:
        detail === ""
          ? `Input for ${failure.operationId} does not match the public API contract.`
          : `Input for ${failure.operationId} does not match the public API contract: ${detail}.`,
      exitCode: ExitCodes.Usage,
      nextSteps: inputNextSteps(failure),
    });
  }
  if (failure.reason === "source") {
    return new AkuaCliError({
      type: "input_error",
      code: "AKUA_INPUT_UNREADABLE",
      message: `Input for ${failure.operationId} could not be read.`,
      exitCode: ExitCodes.Usage,
    });
  }
  if (failure.reason === "auth") {
    return new AkuaCliError({
      type: "authentication_error",
      code: "AKUA_AUTH_REQUIRED",
      message: "Authenticate with akua auth login before calling the public API.",
      exitCode: ExitCodes.AuthRequired,
      nextSteps: [{ command: "akua auth login" }],
    });
  }
  if (failure.reason === "api") {
    const first = failure.apiError?.errors[0];
    return new AkuaCliError({
      type: "api_error",
      code:
        first === undefined ? "AKUA_API_ERROR" : `AKUA_API_${first.code}`,
      message:
        first?.message ??
        failure.responseMessage ??
        "The public API rejected the request.",
      status: failure.status,
      response: failure.apiError ?? rawResponse(failure.responseBody),
    });
  }
  if (failure.reason === "internal") {
    return new AkuaCliError({
      type: "internal_error",
      code: "AKUA_CLI_INTERNAL",
      message: `The CLI failed internally while executing ${failure.operationId}. This is a CLI bug, not an input problem.`,
      exitCode: ExitCodes.Runtime,
    });
  }
  if (failure.reason === "response") {
    return new AkuaCliError({
      type: "response_error",
      code: "AKUA_API_CONTRACT_ERROR",
      message: "The public API response did not match its generated contract.",
      status: failure.status,
      exitCode: ExitCodes.Retryable,
    });
  }
  return new AkuaCliError({
    type: "transport_error",
    code: "AKUA_API_UNAVAILABLE",
    message: "The public API request could not be completed.",
    exitCode: ExitCodes.Retryable,
  });
}

// Raw bodies are wrapped so the JSON-mode response field stays object-typed
// (matching structured ApiErrorResponse payloads) and flattened so the
// line-oriented agent renderer emits one value per line.
function rawResponse(
  body: string | undefined,
): { readonly raw: string } | undefined {
  if (body === undefined) return undefined;
  return { raw: body.split(/\r\n|[\r\n]/).join("\\n") };
}

function formatInputIssue(issue: PublicInputIssue): string {
  return issue.path.length === 0
    ? issue.message
    : `${issue.path.join(".")}: ${issue.message}`;
}

function inputNextSteps(
  failure: GeneratedCommandFailure,
): readonly NextStep[] {
  if (failure.command === undefined || failure.inputExample === undefined) {
    return [];
  }
  return [
    {
      command: `echo '${failure.inputExample}' | akua ${failure.command} --input -`,
      description:
        'Pass a JSON envelope whose keys mirror the OpenAPI parameter locations: {"path":{...},"query":{...},"headers":{...},"body":{...}}.',
    },
  ];
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
