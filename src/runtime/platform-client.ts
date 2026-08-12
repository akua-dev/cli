import { Effect } from "effect";

import { AkuaCliError } from "./errors";
import { clearBytes } from "./secure-token-file";
import { Http } from "./services";

const HCloudProviderLoadUrl = "https://api.akua.dev/v1/agent_os/hcloud_provider_loads";
const responseFields = new Set([
  "loader_id",
  "attestation_id",
  "secret_id",
  "secret_version_id",
  "compute_config_id",
  "expected_ssh_key_fingerprint",
]);

export interface HCloudProviderLoadRequest {
  url: typeof HCloudProviderLoadUrl;
  method: "POST";
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}

interface HCloudProviderLoadResponse {
  status: number;
  body: unknown;
}

export interface HCloudProviderLoadDependencies {
  send(request: HCloudProviderLoadRequest): Effect.Effect<HCloudProviderLoadResponse, unknown>;
}

export interface HCloudProviderLoadInput {
  workspace: string;
  callerToken: string;
  providerToken: Uint8Array;
  expectedSshKeyFingerprint?: string;
  expectedSshKeyName?: string;
  idempotencyKey: string;
}

export type HCloudProviderLoadResult = Readonly<Record<string, unknown>>;

export class HCloudProviderLoadError extends AkuaCliError {}

export function submitHcloudProviderLoad(
  input: HCloudProviderLoadInput,
): Effect.Effect<HCloudProviderLoadResult, HCloudProviderLoadError, Http>;
export function submitHcloudProviderLoad(
  input: HCloudProviderLoadInput,
  dependencies: HCloudProviderLoadDependencies,
): Effect.Effect<HCloudProviderLoadResult, HCloudProviderLoadError>;
export function submitHcloudProviderLoad(
  input: HCloudProviderLoadInput,
  dependencies?: HCloudProviderLoadDependencies,
): Effect.Effect<HCloudProviderLoadResult, HCloudProviderLoadError, Http> {
  return Effect.try({
    try: () =>
      encodeProviderTokenBody(
        input.providerToken,
        input.expectedSshKeyFingerprint,
        input.expectedSshKeyName,
      ),
    catch: () => unknownSubmissionError(),
  }).pipe(
    Effect.flatMap((body) => {
      const request: HCloudProviderLoadRequest = {
        url: HCloudProviderLoadUrl,
        method: "POST",
        headers: {
          authorization: `Bearer ${input.callerToken}`,
          "akua-context": input.workspace,
          "idempotency-key": input.idempotencyKey,
          "content-type": "application/json",
        },
        body,
      };
      const send = dependencies === undefined
        ? Effect.gen(function* () {
            const http = yield* Http;
            if (http.postBytes === undefined) return yield* Effect.fail(unknownSubmissionError());
            return yield* http.postBytes(request);
          })
        : dependencies.send(request);
      return send.pipe(
          Effect.flatMap((response) => {
            if (response.status !== 201) {
              return Effect.fail(serverRejectedError(response.status, response.body));
            }
            return Effect.try({
              try: () => allowlistedResult(response.body),
              catch: (error) =>
                error instanceof HCloudProviderLoadError
                  ? error
                  : invalidServerResponseError(),
            });
          }),
          Effect.catch((error) =>
            error instanceof HCloudProviderLoadError
              ? Effect.fail(error)
              : Effect.fail(unknownSubmissionError()),
          ),
          Effect.ensuring(Effect.sync(() => clearBytes(body))),
      );
    }),
    Effect.ensuring(Effect.sync(() => clearBytes(input.providerToken))),
  );
}

function encodeProviderTokenBody(
  providerToken: Uint8Array,
  expectedSshKeyFingerprint: string | undefined,
  expectedSshKeyName: string | undefined,
): Uint8Array {
  const encoder = new TextEncoder();
  const fields: Array<[Uint8Array, Uint8Array]> = [
    [encoder.encode("provider_token"), providerToken],
  ];
  if (expectedSshKeyFingerprint !== undefined) {
    fields.push([
      encoder.encode("expected_ssh_key_fingerprint"),
      encoder.encode(expectedSshKeyFingerprint),
    ]);
  }
  if (expectedSshKeyName !== undefined) {
    fields.push([
      encoder.encode("expected_ssh_key_name"),
      encoder.encode(expectedSshKeyName),
    ]);
  }
  let encodedLength = 2 + Math.max(0, fields.length - 1);
  for (const [name, value] of fields) {
    encodedLength += name.byteLength + 5;
    for (const byte of value) encodedLength += escapedLength(byte);
  }
  const body = new Uint8Array(encodedLength);
  let cursor = 0;
  body[cursor++] = 123;
  for (const [index, [name, value]] of fields.entries()) {
    if (index > 0) body[cursor++] = 44;
    body[cursor++] = 34;
    body.set(name, cursor);
    cursor += name.byteLength;
    body.set([34, 58, 34], cursor);
    cursor += 3;
    cursor = writeEscapedBytes(body, cursor, value);
    body[cursor++] = 34;
  }
  body[cursor] = 125;
  return body;
}

function writeEscapedBytes(body: Uint8Array, start: number, bytes: Uint8Array): number {
  let cursor = start;
  for (const byte of bytes) {
    if (byte === 34 || byte === 92) {
      body[cursor++] = 92;
      body[cursor++] = byte;
    } else if (byte === 8) {
      body.set([92, 98], cursor);
      cursor += 2;
    } else if (byte === 9) {
      body.set([92, 116], cursor);
      cursor += 2;
    } else if (byte === 10) {
      body.set([92, 110], cursor);
      cursor += 2;
    } else if (byte === 12) {
      body.set([92, 102], cursor);
      cursor += 2;
    } else if (byte === 13) {
      body.set([92, 114], cursor);
      cursor += 2;
    } else if (byte < 32) {
      body.set([92, 117, 48, 48, hex(byte >> 4), hex(byte & 15)], cursor);
      cursor += 6;
    } else {
      body[cursor++] = byte;
    }
  }
  return cursor;
}

function escapedLength(byte: number): number {
  if (byte === 34 || byte === 92 || byte === 8 || byte === 9 || byte === 10 || byte === 12 || byte === 13) return 2;
  return byte < 32 ? 6 : 1;
}

function hex(value: number): number {
  return value < 10 ? 48 + value : 87 + value;
}

function allowlistedResult(body: unknown): HCloudProviderLoadResult {
  if (!isRecord(body)) throw invalidServerResponseError();
  const result: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(body)) {
    if (!responseFields.has(field)) continue;
    if (typeof value === "string" || (field === "expected_ssh_key_fingerprint" && value === null)) result[field] = value;
  }
  if (
    typeof result.loader_id !== "string" ||
    typeof result.attestation_id !== "string" ||
    typeof result.secret_id !== "string" ||
    typeof result.secret_version_id !== "string" ||
    typeof result.compute_config_id !== "string" ||
    (typeof result.expected_ssh_key_fingerprint !== "string" && result.expected_ssh_key_fingerprint !== null)
  ) throw invalidServerResponseError();
  return result;
}

function serverRejectedError(status: number, body: unknown): HCloudProviderLoadError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  const requestId = typeof error.request_id === "string" ? error.request_id : undefined;
  return new HCloudProviderLoadError({
    type: "api_error",
    code: "AKUA_LOADER_SERVER_REJECTED",
    status,
    requestId,
    message: "The provider-load server rejected the request.",
    exitCode: status === 401 || status === 403 ? 3 : 1,
  });
}

function invalidServerResponseError(): HCloudProviderLoadError {
  return new HCloudProviderLoadError({ type: "api_error", code: "AKUA_LOADER_SERVER_RESPONSE_INVALID", message: "The provider-load server returned an invalid response.", exitCode: 1 });
}

function unknownSubmissionError(): HCloudProviderLoadError {
  return new HCloudProviderLoadError({ type: "transport_error", code: "AKUA_LOADER_SUBMISSION_UNKNOWN", message: "The provider-load submission outcome is unknown and was not retried.", exitCode: 1 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
