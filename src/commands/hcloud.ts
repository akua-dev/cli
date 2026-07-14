import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import { readProtectedCallerToken } from "./auth";
import { usageError } from "../runtime/errors";
import { setupHcloud, type HcloudSetupInput, type HcloudSetupResult } from "../runtime/hcloud-setup";
import { clearBytes, readSecureTokenFile } from "../runtime/secure-token-file";
import type { RenderEnvelope } from "../runtime/render";

export interface HcloudCommandDependencies {
  readProtectedCallerToken(env: Record<string, string | undefined>): Promise<string>;
  readSecureTokenFile(path: string): Promise<Uint8Array>;
  setup(input: HcloudSetupInput): Promise<HcloudSetupResult>;
  clearBytes(bytes: Uint8Array): void;
  createIdempotencyKey(workspace: string): string;
}

const productionDependencies: HcloudCommandDependencies = {
  readProtectedCallerToken,
  readSecureTokenFile,
  setup: setupHcloud,
  clearBytes,
  createIdempotencyKey: (workspace) => `hcloud-setup-${createHash("sha256").update(workspace).digest("hex").slice(0, 40)}`,
};

export async function hcloudView(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  dependencies: HcloudCommandDependencies = productionDependencies,
): Promise<RenderEnvelope> {
  if (argv[0] !== "setup") throw usageError("Unknown hcloud subcommand.");
  const options = parseSetupFlags(argv.slice(1));
  const callerToken = await dependencies.readProtectedCallerToken(env);
  const providerToken = await dependencies.readSecureTokenFile(options.tokenFile);
  try {
    const data = await dependencies.setup({ workspace: options.workspace, callerToken, providerToken, idempotencyKey: dependencies.createIdempotencyKey(options.workspace) });
    return { command: "akua hcloud setup", data };
  } finally {
    dependencies.clearBytes(providerToken);
  }
}

function parseSetupFlags(argv: readonly string[]): { workspace: string; tokenFile: string } {
  let workspace: string | undefined;
  let tokenFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("-")) throw usageError("Unexpected argument for hcloud setup.");
    const name = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
    if (name !== "--workspace" && name !== "--token-file") throw usageError("Unsupported hcloud setup option.");
    const inline = value.includes("=") ? value.slice(value.indexOf("=") + 1) : undefined;
    const next = inline === undefined ? argv[index + 1] : undefined;
    const parsed = inline ?? (next === undefined || next.startsWith("-") ? undefined : next);
    if (parsed === undefined || parsed === "") throw usageError(`Missing value for ${name}.`);
    if (inline === undefined) index += 1;
    if (name === "--workspace") {
      if (workspace !== undefined) throw usageError("The workspace may be specified only once.");
      workspace = parsed;
    } else {
      if (tokenFile !== undefined) throw usageError("The token file may be specified only once.");
      tokenFile = parsed;
    }
  }
  if (workspace === undefined) throw usageError("Missing required --workspace flag.");
  if (tokenFile === undefined) throw usageError("Missing required --token-file flag.");
  if (tokenFile === "-" || !isAbsolute(tokenFile)) throw usageError("The provider token must be supplied through an absolute file path.");
  return { workspace, tokenFile };
}
