import { AkuaCliError } from "./errors";

const PublicApiBase = "https://api.akua.dev";

export type ApiFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class PublicApiClient {
  constructor(
    private readonly token: string,
    private readonly apiFetch: ApiFetch = fetch,
  ) {}

  async get(path: string, workspace?: string): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (workspace !== undefined) {
      headers["akua-context"] = workspace;
    }

    let response: Response;
    try {
      response = await this.apiFetch(`${PublicApiBase}${path}`, { method: "GET", headers });
    } catch {
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
    return body;
  }
}
