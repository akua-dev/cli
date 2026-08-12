import { Context, Data, Effect } from "effect";
import { Duration } from "effect";

import type { SecureTokenFile } from "./secure-token-file-services";

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface HttpRequest {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface HttpBytesRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export class HttpFailure extends Data.TaggedError("HttpFailure")<{
  readonly cause: unknown;
}> {}

export class BrowserFailure extends Data.TaggedError("BrowserFailure")<{
  readonly cause: unknown;
}> {}

export class SecureConfigFailure extends Data.TaggedError(
  "SecureConfigFailure",
)<{
  readonly operation: "read" | "write" | "remove";
  readonly path: string;
  readonly cause: unknown;
}> {}

export class Http extends Context.Service<
  Http,
  {
    readonly postForm: (
      request: HttpRequest,
    ) => Effect.Effect<HttpResponse, HttpFailure>;
    readonly postBytes?: (
      request: HttpBytesRequest,
    ) => Effect.Effect<HttpResponse, HttpFailure>;
  }
>()("platform/cli/Http") {}

export class Browser extends Context.Service<
  Browser,
  {
    readonly launch: (url: string) => Effect.Effect<void, BrowserFailure>;
  }
>()("platform/cli/Browser") {}

export class Process extends Context.Service<
  Process,
  {
    readonly awaitSignal: Effect.Effect<void>;
  }
>()("platform/cli/Process") {}

export class Console extends Context.Service<
  Console,
  {
    readonly stdoutIsTTY: boolean;
    readonly writeStderr: (value: string) => Effect.Effect<void>;
    readonly writeStdout: (value: string) => Effect.Effect<void>;
  }
>()("platform/cli/Console") {}

export class SecureConfig extends Context.Service<
  SecureConfig,
  {
    readonly readToken: (
      path: string,
    ) => Effect.Effect<string | undefined, SecureConfigFailure>;
    readonly saveToken: (
      path: string,
      token: string,
    ) => Effect.Effect<void, SecureConfigFailure>;
    readonly removeToken: (
      path: string,
    ) => Effect.Effect<boolean, SecureConfigFailure>;
  }
>()("platform/cli/SecureConfig") {}

export class CliClock extends Context.Service<
  CliClock,
  {
    readonly currentTimeMillis: Effect.Effect<number>;
    readonly sleep: (duration: Duration.Duration) => Effect.Effect<void>;
  }
>()("platform/cli/Clock") {}

export class IdGenerator extends Context.Service<
  IdGenerator,
  {
    readonly generate: () => Effect.Effect<string>;
  }
>()("platform/cli/IdGenerator") {}

export type CliServices =
  | Http
  | Browser
  | Process
  | Console
  | SecureConfig
  | CliClock
  | IdGenerator
  | SecureTokenFile;
