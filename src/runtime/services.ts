import { Context, Data, Effect } from "effect";
import { Duration } from "effect";

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface JsonHttpRequest {
  readonly url: string;
  readonly body: Readonly<Record<string, string>>;
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

export class PublicInputFailure extends Data.TaggedError(
  "PublicInputFailure",
)<{}> {}

export class PackageCliFailure extends Data.TaggedError(
  "PackageCliFailure",
)<{
  readonly cause: unknown;
}> {}

export class Http extends Context.Service<
  Http,
  {
    readonly postJson: (
      request: JsonHttpRequest,
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

export class PublicInput extends Context.Service<
  PublicInput,
  {
    readonly read: (
      source: "-" | string,
    ) => Effect.Effect<string, PublicInputFailure>;
  }
>()("platform/cli/PublicInput") {}

export class PackageCli extends Context.Service<
  PackageCli,
  {
    readonly execute: (
      args: readonly string[],
    ) => Effect.Effect<number, PackageCliFailure>;
  }
>()("platform/cli/PackageCli") {}

export class CliClock extends Context.Service<
  CliClock,
  {
    readonly currentTimeMillis: Effect.Effect<number>;
    readonly sleep: (duration: Duration.Duration) => Effect.Effect<void>;
  }
>()("platform/cli/Clock") {}

export type CliServices =
  | Http
  | Browser
  | Process
  | Console
  | SecureConfig
  | PublicInput
  | PackageCli
  | CliClock;
