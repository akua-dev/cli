import { Context, Data, Effect, Layer } from "effect";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { encodeForm } from "./device-http";

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface HttpRequest {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
}

export class HttpFailure extends Data.TaggedError("HttpFailure")<{
  readonly cause: unknown;
}> {}

export class Http extends Context.Service<Http, {
  readonly postForm: (request: HttpRequest) => Effect.Effect<HttpResponse, HttpFailure>;
}>()("platform/cli/Http") {}

export class Browser extends Context.Service<Browser, {
  readonly launch: (url: string) => Effect.Effect<void, HttpFailure>;
}>()("platform/cli/Browser") {}

export class Process extends Context.Service<Process, {
  readonly platform: NodeJS.Platform;
}>()("platform/cli/Process") {}

export class Console extends Context.Service<Console, {
  readonly writeStderr: (value: string) => Effect.Effect<void>;
  readonly writeStdout: (value: string) => Effect.Effect<void>;
}>()("platform/cli/Console") {}

export class SecureConfig extends Context.Service<SecureConfig, {
  readonly readToken: (path: string) => Effect.Effect<string | undefined, HttpFailure>;
  readonly saveToken: (path: string, token: string) => Effect.Effect<void, HttpFailure>;
  readonly removeToken: (path: string) => Effect.Effect<boolean, HttpFailure>;
}>()("platform/cli/SecureConfig") {}

const MAX_DEVICE_RESPONSE_SIZE = 16_384;

export const HttpLive = Layer.succeed(Http, {
  postForm: (request) => Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(request.url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: encodeForm(request.fields),
        signal,
      });
      const text = await response.text();
      if (text.length > MAX_DEVICE_RESPONSE_SIZE) {
        throw new Error("Device response is too large.");
      }
      return { status: response.status, body: text === "" ? {} : JSON.parse(text) };
    },
    catch: (cause) => new HttpFailure({ cause }),
  }),
});

export const BrowserLive = Layer.succeed(Browser, {
  launch: (url) => Effect.tryPromise({
    try: async () => {
      const command = process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url];
      const processHandle = Bun.spawn({ cmd: command, stdout: "ignore", stderr: "ignore" });
      if ((await processHandle.exited) !== 0) {
        throw new Error("Browser launch failed.");
      }
    },
    catch: (cause) => new HttpFailure({ cause }),
  }),
});

export const ProcessLive = Layer.succeed(Process, { platform: process.platform });

export const ConsoleLive = Layer.succeed(Console, {
  writeStderr: (value) => Effect.sync(() => process.stderr.write(value)),
  writeStdout: (value) => Effect.sync(() => process.stdout.write(value)),
});

export const SecureConfigLive = Layer.succeed(SecureConfig, {
  readToken: (path) => Effect.tryPromise({
    try: async () => {
      try {
        const raw = await readFile(path, "utf8");
        const value: unknown = JSON.parse(raw);
        return isRecord(value) && typeof value.token === "string" && value.token !== "" ? value.token : undefined;
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    catch: (cause) => new HttpFailure({ cause }),
  }),
  saveToken: (path, token) => Effect.tryPromise({
    try: async () => {
      const directory = dirname(path);
      const temporary = join(directory, `.config.json.${randomUUID()}.tmp`);
      let config: Record<string, unknown> = {};
      try {
        const raw = await readFile(path, "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (isRecord(parsed)) config = parsed;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
        await writeFile(temporary, `${JSON.stringify({ ...config, token }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        await chmod(temporary, 0o600);
        await rename(temporary, path);
        await chmod(path, 0o600);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
    catch: (cause) => new HttpFailure({ cause }),
  }),
  removeToken: (path) => Effect.tryPromise({
    try: async () => {
      try {
        const raw = await readFile(path, "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed) || !Object.prototype.hasOwnProperty.call(parsed, "token")) return false;
        const { token: _token, ...config } = parsed;
        await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
        await chmod(path, 0o600);
        return typeof _token === "string" && _token !== "";
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
    catch: (cause) => new HttpFailure({ cause }),
  }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
