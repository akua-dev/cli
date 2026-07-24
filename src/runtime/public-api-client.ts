import { AkuaCliError } from "./errors";

const PublicApiBase = "https://api.akua.dev";
const DefaultRequestTimeoutMs = 30_000;
const DefaultMaxResponseBytes = 1_048_576;

export type ApiFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PublicApiClientOptions {
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

class UnknownCreateOutcomeError extends Error {}

export class PublicApiClient {
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    private readonly token: string,
    private readonly apiFetch: ApiFetch = fetch,
    options: PublicApiClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DefaultRequestTimeoutMs;
    this.maxResponseBytes = options.maxResponseBytes ?? DefaultMaxResponseBytes;
  }

  async get(path: string, workspace?: string): Promise<unknown> {
    return this.request(path, { method: "GET" }, workspace);
  }

  async createMachine(
    body: { cluster_id: string; instance_type: string; compute_config_id: string },
    idempotencyKey: string,
    workspace?: string,
  ): Promise<{ operation_id: string }> {
    try {
      const value = await this.request(
        "/v1/machines",
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
          body: JSON.stringify(body),
        },
        workspace,
        202,
      );
      return validateOperationEnvelope(value);
    } catch (error) {
      if (error instanceof UnknownCreateOutcomeError) {
        throw new AkuaCliError({
          type: "unknown_outcome",
          code: "AKUA_MACHINE_CREATE_OUTCOME_UNKNOWN",
          message: "Machine creation outcome is unknown. The request was not retried.",
          exitCode: 1,
          nextSteps: [
            {
              command: "akua machines create ... --idempotency-key <same-key> --yes",
              description: "Check operation status first; replay only with the exact caller-supplied idempotency key.",
            },
          ],
        });
      }
      throw error;
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    workspace?: string,
    expectedStatus?: number,
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    if (workspace !== undefined) {
      headers.set("akua-context", workspace);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.apiFetch(`${PublicApiBase}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      if (init.method === "POST") {
        throw new UnknownCreateOutcomeError();
      }
      throw transportError();
    }

    let body: unknown;
    try {
      const text = await readBoundedText(response, this.maxResponseBytes);
      body = JSON.parse(text);
    } catch {
      clearTimeout(timeout);
      if (init.method === "POST" && response.ok) {
        throw new UnknownCreateOutcomeError();
      }
      if (!response.ok) {
        throw apiError(response);
      }
      throw invalidResponse(response.status, "The Akua API returned an invalid or oversized JSON response.");
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw apiError(response, body, this.token);
    }
    if (expectedStatus !== undefined && response.status !== expectedStatus) {
      if (init.method === "POST") {
        throw new UnknownCreateOutcomeError();
      }
      throw invalidResponse(response.status, "The Akua API returned an unexpected success status.");
    }
    return body;
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new Error("response too large");
  }
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function apiError(response: Response, body?: unknown, token?: string): AkuaCliError {
  const entry = firstApiErrorEntry(body);
  return new AkuaCliError({
    type: "api_error",
    code: entry === undefined ? "AKUA_PUBLIC_API_ERROR" : `AKUA_PUBLIC_API_${entry.code}`,
    message: entry === undefined
      ? "The Akua API rejected the request."
      : redactToken(entry.message, token),
    path: entry?.path,
    status: response.status,
    requestId: response.headers.get("x-request-id") ?? undefined,
    retryAfter: response.headers.get("retry-after"),
  });
}

function firstApiErrorEntry(value: unknown): { code: number; message: string; path?: string[] } | undefined {
  if (!isRecord(value) || value.success !== false || !Array.isArray(value.errors) || !isRecord(value.result)) {
    return undefined;
  }
  const entry = value.errors[0];
  if (!isRecord(entry) || !Number.isSafeInteger(entry.code) || typeof entry.message !== "string") {
    return undefined;
  }
  if (entry.message.length < 1 || entry.message.length > 1_000 || /[\u0000-\u001f\u007f]/.test(entry.message)) {
    return undefined;
  }
  let path: string[] | undefined;
  if (entry.path !== undefined) {
    if (!Array.isArray(entry.path) || entry.path.length > 32 || entry.path.some((part) =>
      typeof part !== "string" || part.length < 1 || part.length > 200 || /[\u0000-\u001f\u007f]/.test(part)
    )) {
      return undefined;
    }
    path = entry.path as string[];
  }
  return { code: entry.code as number, message: entry.message, path };
}

function redactToken(message: string, token: string | undefined): string {
  return token === undefined || token === "" ? message : message.split(token).join("[REDACTED]");
}

function validateOperationEnvelope(value: unknown): { operation_id: string } {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.operation_id !== "string" ||
    value.operation_id.length < 1 ||
    value.operation_id.length > 53 ||
    /[\u0000-\u001f\u007f]/.test(value.operation_id)
  ) {
    throw new UnknownCreateOutcomeError();
  }
  return { operation_id: value.operation_id };
}

function transportError(): AkuaCliError {
  return new AkuaCliError({
    type: "transport_error",
    code: "AKUA_PUBLIC_API_TRANSPORT_ERROR",
    message: "The Akua API request could not be completed.",
    exitCode: 1,
  });
}

function invalidResponse(status: number, message: string): AkuaCliError {
  return new AkuaCliError({
    type: "invalid_response",
    code: "AKUA_PUBLIC_API_INVALID_RESPONSE",
    message,
    status,
    exitCode: 1,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
