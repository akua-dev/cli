import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { AkuaCliError, usageError } from "../runtime/errors";
import type { RenderEnvelope } from "../runtime/render";

const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;

type AkuaConfig = Record<string, unknown> & {
  token?: string;
};

type CredentialSource = "env" | "config" | "none";

interface AuthStatus {
  authenticated: boolean;
  source: CredentialSource;
  config_path?: string;
}

class ConfigParseError extends AkuaCliError {}

export async function authView(argv: readonly string[], env: Record<string, string | undefined>): Promise<RenderEnvelope> {
  const subcommand = argv[0];
  if (subcommand === undefined) {
    throw usageError("Missing auth subcommand.");
  }

  if (subcommand === "login") {
    return loginView(argv.slice(1), env);
  }
  if (subcommand === "status") {
    return statusView(argv.slice(1), env);
  }
  if (subcommand === "logout") {
    return logoutView(argv.slice(1), env);
  }

  throw usageError("Unknown auth subcommand.");
}

async function loginView(argv: readonly string[], env: Record<string, string | undefined>): Promise<RenderEnvelope> {
  const token = parseLoginFlags(argv);
  const configPath = resolveConfigPath(env);
  await saveStoredToken(configPath, token);

  return {
    command: "akua auth login",
    observations: ["Authentication token saved."],
    data: {
      authenticated: true,
      source: "config",
      config_path: configPath,
    } satisfies AuthStatus,
    next_steps: [{ command: "akua auth status" }],
  };
}

async function statusView(argv: readonly string[], env: Record<string, string | undefined>): Promise<RenderEnvelope> {
  rejectUnexpectedAuthArgs("status", argv);
  const configPath = optionalConfigPath(env);
  const source = hasEnvToken(env) ? "env" : await storedCredentialSource(configPath ?? resolveConfigPath(env));
  const authenticated = source !== "none";

  return {
    command: "akua auth status",
    observations: [statusObservation(source)],
    data: {
      authenticated,
      source,
      config_path: configPath,
    } satisfies AuthStatus,
    next_steps: authenticated ? undefined : [{ command: "akua auth login --token <token>" }],
  };
}

async function logoutView(argv: readonly string[], env: Record<string, string | undefined>): Promise<RenderEnvelope> {
  rejectUnexpectedAuthArgs("logout", argv);
  const configPath = resolveConfigPath(env);
  const hadStoredToken = await removeStoredToken(configPath);
  const envStillAuthenticated = hasEnvToken(env);

  return {
    command: "akua auth logout",
    observations: [logoutObservation(hadStoredToken, envStillAuthenticated)],
    data: {
      authenticated: envStillAuthenticated,
      source: envStillAuthenticated ? "env" : "none",
      config_path: configPath,
    } satisfies AuthStatus,
    next_steps: envStillAuthenticated ? [{ command: "unset AKUA_API_TOKEN" }] : [{ command: "akua auth login --token <token>" }],
  };
}

function parseLoginFlags(argv: readonly string[]): string {
  let token: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("-")) {
      throw usageError("Unexpected argument for auth login.");
    }

    const name = flagName(value);
    if (name !== "--token") {
      throw usageError(`Unknown flag: ${name}`);
    }

    const raw = readFlagValue(argv, index, name);
    if (raw.value === undefined || raw.value === "") {
      throw usageError("Missing value for --token.");
    }
    token = raw.value;
    if (raw.consumedNext) {
      index += 1;
    }
  }

  if (token === undefined) {
    throw usageError("Missing required --token flag.");
  }
  return token;
}

function rejectUnexpectedAuthArgs(subcommand: string, argv: readonly string[]): void {
  if (argv.length > 0) {
    const first = argv[0];
    throw first.startsWith("-")
      ? usageError(`Unknown flag: ${flagName(first)}`)
      : usageError(`Unexpected argument for auth ${subcommand}.`);
  }
}

async function storedCredentialSource(configPath: string): Promise<CredentialSource> {
  if (hasStoredToken(await readConfig(configPath))) {
    return "config";
  }
  return "none";
}

function hasEnvToken(env: Record<string, string | undefined>): boolean {
  return env.AKUA_API_TOKEN !== undefined && env.AKUA_API_TOKEN !== "";
}

function resolveConfigPath(env: Record<string, string | undefined>): string {
  const home = env.HOME;
  if (home === undefined || home === "") {
    throw usageError("HOME is required to locate ~/.config/akua/config.json.");
  }
  return join(home, ".config", "akua", "config.json");
}

function optionalConfigPath(env: Record<string, string | undefined>): string | undefined {
  const home = env.HOME;
  return home === undefined || home === "" ? undefined : join(home, ".config", "akua", "config.json");
}

async function readConfig(configPath: string): Promise<AkuaConfig> {
  const raw = await readConfigText(configPath);
  if (raw === undefined) {
    return {};
  }
  return parseConfig(raw, configPath);
}

async function readConfigText(configPath: string): Promise<string | undefined> {
  try {
    return await readFile(configPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw configError("read", configPath, error);
  }
}

function parseConfig(raw: string, configPath: string): AkuaConfig {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isConfigObject(parsed)) {
      return parsed;
    }
    throw new Error("Akua config must be a JSON object.");
  } catch (error) {
    throw new ConfigParseError({
      type: "runtime_error",
      code: "AKUA_CONFIG_ERROR",
      message: `Failed to read Akua config at ${configPath}: ${errorMessage(error)}`,
    });
  }
}

async function saveStoredToken(configPath: string, token: string): Promise<void> {
  const config = await readConfig(configPath);
  await writeConfig(configPath, { ...config, token });
}

async function writeConfig(configPath: string, config: AkuaConfig): Promise<void> {
  const configDir = dirname(configPath);
  const tempPath = join(configDir, `.config.json.${randomUUID()}.tmp`);

  try {
    await mkdir(configDir, { recursive: true, mode: CONFIG_DIR_MODE });
    await chmod(configDir, CONFIG_DIR_MODE);
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: CONFIG_FILE_MODE, flag: "wx" });
    await chmod(tempPath, CONFIG_FILE_MODE);
    await rename(tempPath, configPath);
    await chmod(configPath, CONFIG_FILE_MODE);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw configError("write", configPath, error);
  }
}

async function removeStoredToken(configPath: string): Promise<boolean> {
  const raw = await readConfigText(configPath);
  if (raw === undefined) {
    return false;
  }

  let config: AkuaConfig;
  try {
    config = parseConfig(raw, configPath);
  } catch (error) {
    if (error instanceof ConfigParseError) {
      try {
        await rm(configPath, { force: true });
        return true;
      } catch (removeError) {
        throw configError("remove", configPath, removeError);
      }
    }
    throw configError("remove", configPath, error);
  }

  const hadStoredToken = hasStoredToken(config);
  if (!hasOwnToken(config)) {
    return false;
  }

  delete config.token;
  await writeConfig(configPath, config);
  return hadStoredToken;
}

function isConfigObject(value: unknown): value is AkuaConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStoredToken(config: AkuaConfig): boolean {
  return typeof config.token === "string" && config.token !== "";
}

function hasOwnToken(config: AkuaConfig): boolean {
  return Object.prototype.hasOwnProperty.call(config, "token");
}

function configError(operation: "read" | "write" | "remove", configPath: string, error: unknown): AkuaCliError {
  return new AkuaCliError({
    type: "runtime_error",
    code: "AKUA_CONFIG_ERROR",
    message: `Failed to ${operation} Akua config at ${configPath}: ${errorMessage(error)}`,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusObservation(source: CredentialSource): string {
  if (source === "env") {
    return "Authenticated with AKUA_API_TOKEN.";
  }
  if (source === "config") {
    return "Authenticated with stored token.";
  }
  return "No Akua authentication token found.";
}

function logoutObservation(hadStoredToken: boolean, envStillAuthenticated: boolean): string {
  if (envStillAuthenticated) {
    return hadStoredToken
      ? "Stored authentication token removed. AKUA_API_TOKEN is still active."
      : "No stored authentication token found. AKUA_API_TOKEN is still active.";
  }
  return hadStoredToken ? "Stored authentication token removed." : "No stored authentication token found.";
}

function readFlagValue(
  argv: readonly string[],
  index: number,
  flag: string,
): { value: string | undefined; consumedNext: boolean } {
  const value = argv[index];
  if (value === flag) {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("-")) {
      return { value: undefined, consumedNext: false };
    }
    return { value: next, consumedNext: true };
  }

  return { value: value.slice(flag.length + 1), consumedNext: false };
}

function flagName(value: string): string {
  return value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
}
