import { join } from "node:path";

import {
  Context,
  Data,
  Effect,
  Layer,
  Ref,
  Semaphore,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

import { PublicApi } from "../generated/openapi-api.gen";
import { SecureConfig } from "./services";

const PUBLIC_API_BASE_URL = "https://api.akua.dev/v1";

export interface PublicApiClientValue {
  readonly client: HttpApiClient.ForApi<typeof PublicApi>;
  readonly responseStatus: Ref.Ref<number | undefined>;
  readonly semaphore: Semaphore.Semaphore;
}

export class PublicApiClient extends Context.Service<
  PublicApiClient,
  PublicApiClientValue
>()("platform/cli/PublicApiClient") {}

export class PublicApiAuthenticationFailure extends Data.TaggedError(
  "PublicApiAuthenticationFailure",
)<{ readonly reason: "missing" | "config" }> {}

export function PublicApiClientLive(
  env: Record<string, string | undefined>,
  requiresAuth = true,
): Layer.Layer<
  PublicApiClient,
  PublicApiAuthenticationFailure,
  SecureConfig
> {
  return Layer.effect(
    PublicApiClient,
    Effect.gen(function* () {
      const token = yield* resolvePublicApiToken(env, requiresAuth);
      const responseStatus = yield* Ref.make<number | undefined>(undefined);
      const semaphore = yield* Semaphore.make(1);
      const client = yield* HttpApiClient.make(PublicApi, {
        baseUrl: PUBLIC_API_BASE_URL,
        transformClient: (httpClient) => {
          const authenticated =
            token === undefined
              ? httpClient
              : httpClient.pipe(
                  HttpClient.mapRequest(
                    HttpClientRequest.bearerToken(token),
                  ),
                );
          return authenticated.pipe(
            HttpClient.tap((response) =>
              Ref.set(responseStatus, response.status),
            ),
          );
        },
      });
      return { client, responseStatus, semaphore };
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}

function resolvePublicApiToken(
  env: Record<string, string | undefined>,
  requiresAuth: boolean,
): Effect.Effect<
  string | undefined,
  PublicApiAuthenticationFailure,
  SecureConfig
> {
  const environmentToken = env.AKUA_API_TOKEN;
  if (environmentToken !== undefined && environmentToken !== "") {
    return Effect.succeed(environmentToken);
  }
  const home = env.HOME;
  if (home === undefined || home === "") {
    return requiresAuth
      ? Effect.fail(
          new PublicApiAuthenticationFailure({ reason: "missing" }),
        )
      : Effect.succeed(undefined);
  }
  return Effect.gen(function* () {
    const config = yield* SecureConfig;
    const token = yield* config
      .readToken(join(home, ".config", "akua", "config.json"))
      .pipe(
        Effect.mapError(
          () => new PublicApiAuthenticationFailure({ reason: "config" }),
        ),
      );
    return token === undefined && requiresAuth
      ? yield* Effect.fail(
          new PublicApiAuthenticationFailure({ reason: "missing" }),
        )
      : token;
  });
}
