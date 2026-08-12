import { join } from "node:path";

import { Duration, Effect } from "effect";

import { AkuaCliError, usageError } from "../runtime/errors";
import {
  ConfigFailure,
  DeviceAuthorizationFailure,
  DeviceCancelledFailure,
  DeviceRequestFailure,
  type CliFailure,
  UsageFailure,
} from "../runtime/effect-runtime";
import {
  Browser,
  CliClock,
  Console,
  Http,
  Process,
  SecureConfig,
  type SecureConfigFailure,
} from "../runtime/services";
import type { RenderEnvelope } from "../runtime/render";

type CredentialSource = "env" | "config" | "none";

const AUTH_BASE_URL = "https://akua.dev/api/auth";
const DEVICE_CLIENT_ID = "akua-cli";
const DEVICE_SCOPE = "platform";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

interface AuthStatus {
  authenticated: boolean;
  source: CredentialSource;
  config_path?: string;
}

interface DeviceLoginDetails {
  verification_uri_complete: string;
  user_code: string;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface DeviceTokenResponse {
  access_token: string;
}

interface DeviceErrorResponse {
  error?: string;
}

interface DeviceResponse {
  status: number;
  body: unknown;
}

interface LoginFlags {
  token?: string;
  noBrowser: boolean;
}

interface DeviceLoginResult {
  token: string;
  details?: DeviceLoginDetails;
  observations: string[];
}

type AuthServices =
  Http | Browser | Process | Console | SecureConfig | CliClock;

export function authView(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Effect.Effect<RenderEnvelope, CliFailure, AuthServices>;
export function authView(
  argv: readonly string[],
  env: Record<string, string | undefined>,
) {
  return authProgram(argv, env);
}

function authProgram(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Effect.Effect<RenderEnvelope, CliFailure, AuthServices> {
  return parseAuthCommand(argv).pipe(
    Effect.flatMap(
      (command): Effect.Effect<RenderEnvelope, CliFailure, AuthServices> => {
        if (command.subcommand === "login") return loginView(command.argv, env);
        if (command.subcommand === "status")
          return statusView(command.argv, env);
        return logoutView(command.argv, env);
      },
    ),
  );
}

function loginView(
  argv: readonly string[],
  env: Record<string, string | undefined>,
) {
  return Effect.try({
    try: () => ({
      flags: parseLoginFlags(argv),
      configPath: resolveConfigPath(env),
    }),
    catch: usageFailure,
  }).pipe(
    Effect.flatMap(({ flags, configPath }) => {
      const result: Effect.Effect<DeviceLoginResult, CliFailure, AuthServices> =
        flags.token === undefined
          ? runDeviceLogin(flags.noBrowser)
          : Effect.succeed({
              token: flags.token,
              details: undefined,
              observations: [],
            } satisfies DeviceLoginResult);
      return result.pipe(
        Effect.flatMap((login) =>
          Effect.gen(function* () {
            const config = yield* SecureConfig;
            yield* config
              .saveToken(configPath, login.token)
              .pipe(Effect.mapError(configFailure));
            return {
              command: "akua auth login",
              observations: [
                ...login.observations,
                "Authentication token saved.",
              ],
              data: {
                authenticated: true,
                source: "config",
                config_path: configPath,
                ...login.details,
              } satisfies AuthStatus,
              next_steps: [{ command: "akua auth status" }],
            } satisfies RenderEnvelope;
          }),
        ),
      );
    }),
  );
}

function runDeviceLogin(noBrowser: boolean) {
  return Effect.gen(function* () {
    const process = yield* Process;
    return yield* completeDeviceLogin(noBrowser).pipe(
      Effect.raceFirst(
        process.awaitSignal.pipe(
          Effect.andThen(Effect.fail(new DeviceCancelledFailure())),
        ),
      ),
    );
  });
}

function completeDeviceLogin(noBrowser: boolean) {
  return Effect.gen(function* () {
    const deviceCode = yield* requestDevice(`${AUTH_BASE_URL}/device/code`, {
      client_id: DEVICE_CLIENT_ID,
      scope: DEVICE_SCOPE,
    }).pipe(Effect.flatMap(parseDeviceCode));
    const verificationUriComplete =
      deviceCode.verification_uri_complete ?? deviceCode.verification_uri;
    const console = yield* Console;
    yield* console.writeStderr(
      `Open ${verificationUriComplete}\nEnter code: ${deviceCode.user_code}\n`,
    );
    const observations = noBrowser
      ? []
      : yield* tryLaunchBrowser(verificationUriComplete);
    const clock = yield* CliClock;
    const startedAt = yield* clock.currentTimeMillis;
    const token = yield* pollForDeviceToken(
      deviceCode,
      startedAt + deviceCode.expires_in * 1_000,
      (deviceCode.interval ?? 5) * 1_000,
    );
    return {
      token,
      details: {
        verification_uri_complete: verificationUriComplete,
        user_code: deviceCode.user_code,
      },
      observations,
    };
  });
}

function pollForDeviceToken(
  deviceCode: DeviceCodeResponse,
  deadline: number,
  interval: number,
): Effect.Effect<
  string,
  DeviceAuthorizationFailure | DeviceRequestFailure,
  Http | CliClock
> {
  return Effect.gen(function* () {
    const clock = yield* CliClock;
    const now = yield* clock.currentTimeMillis;
    if (now >= deadline)
      return yield* Effect.fail(
        new DeviceAuthorizationFailure({ reason: "expired_token" }),
      );
    const response = yield* requestDevice(`${AUTH_BASE_URL}/device/token`, {
      grant_type: DEVICE_GRANT_TYPE,
      device_code: deviceCode.device_code,
      client_id: DEVICE_CLIENT_ID,
    });
    const token = yield* parseDeviceToken(response);
    if (token !== undefined) return token;
    const error = deviceError(response);
    if (error === "access_denied" || error === "expired_token") {
      return yield* Effect.fail(
        new DeviceAuthorizationFailure({ reason: error }),
      );
    }
    if (error !== "authorization_pending" && error !== "slow_down") {
      return yield* Effect.fail(new DeviceRequestFailure());
    }
    const nextInterval = error === "slow_down" ? interval + 5_000 : interval;
    if (now + nextInterval >= deadline) {
      return yield* Effect.fail(
        new DeviceAuthorizationFailure({ reason: "expired_token" }),
      );
    }
    yield* clock.sleep(Duration.millis(nextInterval));
    return yield* pollForDeviceToken(deviceCode, deadline, nextInterval);
  });
}

function requestDevice(url: string, fields: Record<string, string>) {
  return Effect.gen(function* () {
    const http = yield* Http;
    return yield* http
      .postForm({ url, fields })
      .pipe(Effect.mapError(() => new DeviceRequestFailure()));
  });
}

function parseDeviceCode(response: DeviceResponse) {
  return Effect.try({
    try: () => {
      if (
        response.status < 200 ||
        response.status >= 300 ||
        !isDeviceCodeResponse(response.body)
      ) {
        throw new Error("Invalid device-code response.");
      }
      return response.body;
    },
    catch: () => new DeviceRequestFailure(),
  });
}

function parseDeviceToken(response: DeviceResponse) {
  return Effect.try({
    try: () => {
      if (response.status < 200 || response.status >= 300) return undefined;
      if (!isDeviceTokenResponse(response.body))
        throw new Error("Invalid device-token response.");
      return response.body.access_token;
    },
    catch: () => new DeviceRequestFailure(),
  });
}

function tryLaunchBrowser(url: string) {
  return Effect.gen(function* () {
    const browser = yield* Browser;
    return yield* browser.launch(url).pipe(
      Effect.match({
        onFailure: () => [
          "Could not open a browser. Open the verification URL manually.",
        ],
        onSuccess: () => [],
      }),
    );
  });
}

function statusView(
  argv: readonly string[],
  env: Record<string, string | undefined>,
) {
  return Effect.try({
    try: () => {
      rejectUnexpectedAuthArgs("status", argv);
      return optionalConfigPath(env);
    },
    catch: usageFailure,
  }).pipe(
    Effect.flatMap((configPath) => {
      if (hasEnvToken(env))
        return Effect.succeed(statusEnvelope("env", configPath));
      if (configPath === undefined)
        return Effect.succeed(statusEnvelope("none", undefined));
      return Effect.gen(function* () {
        const config = yield* SecureConfig;
        const token = yield* config
          .readToken(configPath)
          .pipe(Effect.mapError(configFailure));
        return statusEnvelope(
          token === undefined ? "none" : "config",
          configPath,
        );
      });
    }),
  );
}

function logoutView(
  argv: readonly string[],
  env: Record<string, string | undefined>,
) {
  return Effect.try({
    try: () => {
      rejectUnexpectedAuthArgs("logout", argv);
      return resolveConfigPath(env);
    },
    catch: usageFailure,
  }).pipe(
    Effect.flatMap((configPath) =>
      Effect.gen(function* () {
        const config = yield* SecureConfig;
        const hadStoredToken = yield* config
          .removeToken(configPath)
          .pipe(Effect.mapError(configFailure));
        const envStillAuthenticated = hasEnvToken(env);
        return {
          command: "akua auth logout",
          observations: [
            logoutObservation(hadStoredToken, envStillAuthenticated),
          ],
          data: {
            authenticated: envStillAuthenticated,
            source: envStillAuthenticated ? "env" : "none",
            config_path: configPath,
          } satisfies AuthStatus,
          next_steps: envStillAuthenticated
            ? [{ command: "unset AKUA_API_TOKEN" }]
            : [{ command: "akua auth login --token <token>" }],
        } satisfies RenderEnvelope;
      }),
    ),
  );
}

function parseAuthCommand(argv: readonly string[]) {
  return Effect.try({
    try: () => {
      const subcommand = argv[0];
      if (subcommand === undefined)
        throw usageError("Missing auth subcommand.");
      if (
        subcommand !== "login" &&
        subcommand !== "status" &&
        subcommand !== "logout"
      ) {
        throw usageError("Unknown auth subcommand.");
      }
      return { subcommand, argv: argv.slice(1) };
    },
    catch: usageFailure,
  });
}

function parseLoginFlags(argv: readonly string[]): LoginFlags {
  let token: string | undefined;
  let noBrowser = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("-"))
      throw usageError("Unexpected argument for auth login.");
    const name = flagName(value);
    if (name === "--no-browser") {
      if (value !== "--no-browser")
        throw usageError("--no-browser does not accept a value.");
      noBrowser = true;
      continue;
    }
    if (name !== "--token") throw usageError(`Unknown flag: ${name}`);
    const raw = readFlagValue(argv, index, name);
    if (raw.value === undefined || raw.value === "")
      throw usageError("Missing value for --token.");
    token = raw.value;
    if (raw.consumedNext) index += 1;
  }
  return { token, noBrowser };
}

function statusEnvelope(
  source: CredentialSource,
  configPath: string | undefined,
): RenderEnvelope {
  const authenticated = source !== "none";
  return {
    command: "akua auth status",
    observations: [statusObservation(source)],
    data: {
      authenticated,
      source,
      config_path: configPath,
    } satisfies AuthStatus,
    next_steps: authenticated
      ? undefined
      : [{ command: "akua auth login --token <token>" }],
  };
}

function isDeviceCodeResponse(value: unknown): value is DeviceCodeResponse {
  if (!isRecord(value)) return false;
  return (
    ["device_code", "user_code", "verification_uri"].every(
      (field) => typeof value[field] === "string" && value[field] !== "",
    ) &&
    (value.verification_uri_complete === undefined ||
      (typeof value.verification_uri_complete === "string" &&
        value.verification_uri_complete !== "")) &&
    typeof value.expires_in === "number" &&
    Number.isFinite(value.expires_in) &&
    value.expires_in > 0 &&
    (value.interval === undefined ||
      (typeof value.interval === "number" &&
        Number.isFinite(value.interval) &&
        value.interval > 0))
  );
}

function isDeviceTokenResponse(value: unknown): value is DeviceTokenResponse {
  return (
    isRecord(value) &&
    typeof value.access_token === "string" &&
    value.access_token !== ""
  );
}

function deviceError(response: DeviceResponse): string | undefined {
  return isDeviceErrorResponse(response.body) ? response.body.error : undefined;
}

function isDeviceErrorResponse(value: unknown): value is DeviceErrorResponse {
  return (
    isRecord(value) &&
    (value.error === undefined || typeof value.error === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usageFailure(error: unknown): UsageFailure {
  return new UsageFailure({
    message:
      error instanceof AkuaCliError ? error.message : errorMessage(error),
  });
}

function configFailure(error: SecureConfigFailure): ConfigFailure {
  return new ConfigFailure({
    operation: error.operation,
    path: error.path,
    cause: error.cause,
  });
}

function rejectUnexpectedAuthArgs(
  subcommand: string,
  argv: readonly string[],
): void {
  if (argv.length > 0) {
    const first = argv[0];
    throw first.startsWith("-")
      ? usageError(`Unknown flag: ${flagName(first)}`)
      : usageError(`Unexpected argument for auth ${subcommand}.`);
  }
}

function hasEnvToken(env: Record<string, string | undefined>): boolean {
  return env.AKUA_API_TOKEN !== undefined && env.AKUA_API_TOKEN !== "";
}

function resolveConfigPath(env: Record<string, string | undefined>): string {
  const home = env.HOME;
  if (home === undefined || home === "")
    throw usageError("HOME is required to locate ~/.config/akua/config.json.");
  return join(home, ".config", "akua", "config.json");
}

function optionalConfigPath(
  env: Record<string, string | undefined>,
): string | undefined {
  const home = env.HOME;
  return home === undefined || home === ""
    ? undefined
    : join(home, ".config", "akua", "config.json");
}

function statusObservation(source: CredentialSource): string {
  if (source === "env") return "Authenticated with AKUA_API_TOKEN.";
  if (source === "config") return "Authenticated with stored token.";
  return "No Akua authentication token found.";
}

function logoutObservation(
  hadStoredToken: boolean,
  envStillAuthenticated: boolean,
): string {
  if (envStillAuthenticated) {
    return hadStoredToken
      ? "Stored authentication token removed. AKUA_API_TOKEN is still active."
      : "No stored authentication token found. AKUA_API_TOKEN is still active.";
  }
  return hadStoredToken
    ? "Stored authentication token removed."
    : "No stored authentication token found.";
}

function readFlagValue(
  argv: readonly string[],
  index: number,
  flag: string,
): { value: string | undefined; consumedNext: boolean } {
  const value = argv[index];
  if (value === flag) {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("-"))
      return { value: undefined, consumedNext: false };
    return { value: next, consumedNext: true };
  }
  return { value: value.slice(flag.length + 1), consumedNext: false };
}

function flagName(value: string): string {
  return value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
