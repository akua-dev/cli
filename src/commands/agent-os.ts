import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import { Effect } from "effect";

import { readProtectedCallerToken } from "./auth";
import { AkuaCliError, usageError } from "../runtime/errors";
import { toCliError } from "../runtime/effect-runtime";
import {
  submitHcloudProviderLoad,
  type HCloudProviderLoadInput,
  type HCloudProviderLoadResult,
} from "../runtime/platform-client";
import { clearBytes, readSecureTokenFile } from "../runtime/secure-token-file";
import type { RenderEnvelope } from "../runtime/render";
import type { SecureConfig } from "../runtime/services";

export interface AgentOsDependencies {
  readProtectedCallerToken(
    env: Record<string, string | undefined>,
  ): Effect.Effect<string, AkuaCliError, SecureConfig>;
  readSecureTokenFile(path: string): Effect.Effect<Uint8Array, AkuaCliError>;
  submit(
    input: HCloudProviderLoadInput,
  ): Effect.Effect<HCloudProviderLoadResult, AkuaCliError>;
  createIdempotencyKey(): string;
}

const productionDependencies: AgentOsDependencies = {
  readProtectedCallerToken: (env) =>
    readProtectedCallerToken(env).pipe(Effect.mapError(toCliError)),
  readSecureTokenFile,
  submit: submitHcloudProviderLoad,
  createIdempotencyKey: randomUUID,
};

export function agentOsView(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  dependencies: AgentOsDependencies = productionDependencies,
): Effect.Effect<RenderEnvelope, AkuaCliError, SecureConfig> {
  return Effect.try({
    try: () => {
      if (argv[0] !== "load-hcloud-provider") throw usageError("Unknown agent-os subcommand.");
      const options = parseLoadHcloudProviderFlags(argv.slice(1));
      if (env.AKUA_API_TOKEN !== undefined && env.AKUA_API_TOKEN !== "") {
        throw new AkuaCliError({ type: "usage_error", code: "AKUA_LOADER_ENV_AUTH_FORBIDDEN", message: "Environment authentication is not accepted for this provider loader.", exitCode: 2 });
      }
      return options;
    },
    catch: (error) => error instanceof AkuaCliError ? error : usageError(String(error)),
  }).pipe(
    Effect.flatMap((options) =>
      Effect.gen(function* () {
        const callerToken = yield* dependencies.readProtectedCallerToken(env);
        const providerToken = yield* dependencies.readSecureTokenFile(options.tokenFile);
        return yield* dependencies.submit({
          workspace: options.workspace,
          callerToken,
          providerToken,
          expectedSshKeyFingerprint: options.expectedSshKeyFingerprint,
          expectedSshKeyName: options.expectedSshKeyName,
          idempotencyKey: dependencies.createIdempotencyKey(),
        }).pipe(
          Effect.map((data) => ({ command: "akua agent-os load-hcloud-provider", data })),
          Effect.ensuring(Effect.sync(() => clearBytes(providerToken))),
        );
      }),
    ),
  );
}

interface LoadHcloudProviderOptions {
  workspace: string;
  tokenFile: string;
  expectedSshKeyFingerprint?: string;
  expectedSshKeyName?: string;
}

function parseLoadHcloudProviderFlags(argv: readonly string[]): LoadHcloudProviderOptions {
  let workspace: string | undefined;
  let tokenFile: string | undefined;
  let expectedSshKeyFingerprint: string | undefined;
  let expectedSshKeyName: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("-")) throw usageError("Unexpected argument for agent-os provider loader.");
    const name = flagName(value);
    if (name !== "--workspace" && name !== "--token-file" && name !== "--expected-ssh-key-fingerprint" && name !== "--expected-ssh-key-name") throw usageError("Unsupported agent-os provider loader option.");
    const parsed = readFlagValue(argv, index, name);
    if (parsed.value === undefined || parsed.value === "") throw usageError(`Missing value for ${name}.`);
    if (parsed.consumedNext) index += 1;
    if (name === "--workspace") {
      if (workspace !== undefined) throw usageError("The workspace may be specified only once.");
      workspace = parsed.value;
    } else if (name === "--token-file") {
      if (tokenFile !== undefined) throw usageError("The token file may be specified only once.");
      tokenFile = parsed.value;
    } else if (name === "--expected-ssh-key-fingerprint") {
      if (expectedSshKeyFingerprint !== undefined) throw usageError("The expected SSH key fingerprint may be specified only once.");
      expectedSshKeyFingerprint = parsed.value;
    } else {
      if (expectedSshKeyName !== undefined) throw usageError("The expected SSH key name may be specified only once.");
      expectedSshKeyName = parsed.value;
    }
  }
  if (workspace === undefined) throw usageError("Missing required --workspace flag.");
  if (tokenFile === undefined) throw usageError("Missing required --token-file flag.");
  if (tokenFile === "-" || !isAbsolute(tokenFile)) throw usageError("The provider token must be supplied through an absolute file path.");
  if (expectedSshKeyFingerprint !== undefined && !isSafeExpectedSshField(expectedSshKeyFingerprint)) throw usageError("The expected SSH key fingerprint is malformed.");
  if (expectedSshKeyName !== undefined && !isSafeExpectedSshField(expectedSshKeyName)) throw usageError("The expected SSH key name is malformed.");
  if (expectedSshKeyName !== undefined && expectedSshKeyFingerprint === undefined) throw usageError("--expected-ssh-key-name requires --expected-ssh-key-fingerprint.");
  return { workspace, tokenFile, expectedSshKeyFingerprint, expectedSshKeyName };
}

function isSafeExpectedSshField(value: string): boolean { return /^[\x21-\x7e]{1,200}$/.test(value); }

function readFlagValue(argv: readonly string[], index: number, flag: string): { value: string | undefined; consumedNext: boolean } {
  const value = argv[index];
  if (value === flag) {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("-")) return { value: undefined, consumedNext: false };
    return { value: next, consumedNext: true };
  }
  return { value: value.slice(flag.length + 1), consumedNext: false };
}

function flagName(value: string): string { return value.includes("=") ? value.slice(0, value.indexOf("=")) : value; }
