import { AkuaCliError } from "./errors";

const PublicApiBase = "https://api.akua.dev";

export type ApiFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

class AmbiguousTransportError extends Error {}

export class PublicApiClient {
  constructor(
    private readonly token: string,
    private readonly apiFetch: ApiFetch = fetch,
  ) {}

  async get(path: string, workspace?: string): Promise<unknown> {
    return this.request(path, { method: "GET" }, workspace);
  }

  async createMachine(
    body: { cluster_id: string; instance_type: string; compute_config_id: string },
    idempotencyKey: string,
    workspace?: string,
  ): Promise<unknown> {
    try {
      return await this.request(
        "/v1/machines",
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
          body: JSON.stringify(body),
        },
        workspace,
        202,
      );
    } catch (error) {
      if (error instanceof AmbiguousTransportError) {
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

    let response: Response;
    try {
      response = await this.apiFetch(`${PublicApiBase}${path}`, { ...init, headers });
    } catch {
      if (init.method === "POST") {
        throw new AmbiguousTransportError();
      }
      throw new AkuaCliError({
        type: "transport_error",
        code: "AKUA_PUBLIC_API_TRANSPORT_ERROR",
        message: "The Akua API request could not be completed.",
        exitCode: 1,
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AkuaCliError({
        type: "invalid_response",
        code: "AKUA_PUBLIC_API_INVALID_RESPONSE",
        message: "The Akua API returned an invalid JSON response.",
        status: response.status,
        exitCode: 1,
      });
    }

    if (!response.ok) {
      throw new AkuaCliError({
        type: "api_error",
        code: "AKUA_PUBLIC_API_ERROR",
        message: "The Akua API rejected the request.",
        status: response.status,
        requestId: response.headers.get("x-request-id") ?? undefined,
        retryAfter: response.headers.get("retry-after"),
      });
    }
    if (expectedStatus !== undefined && response.status !== expectedStatus) {
      throw new AkuaCliError({
        type: "invalid_response",
        code: "AKUA_PUBLIC_API_INVALID_RESPONSE",
        message: "The Akua API returned an unexpected success status.",
        status: response.status,
        exitCode: 1,
      });
    }
    return body;
  }
}
