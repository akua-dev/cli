import { usageError } from "../runtime/errors";
import { PublicApiClient, type ApiFetch } from "../runtime/public-api-client";
import type { RenderEnvelope } from "../runtime/render";
import { readPublicApiToken } from "./auth";

export interface CapacityDependencies {
  readToken(env: Record<string, string | undefined>): Promise<string>;
  fetch: ApiFetch;
}

const productionDependencies: CapacityDependencies = {
  readToken: readPublicApiToken,
  fetch,
};

interface ParsedCommand {
  command: string;
  path?: string;
  workspace?: string;
  create?: {
    cluster_id: string;
    compute_config_id: string;
    instance_type: string;
    idempotency_key: string;
  };
}

export async function capacityView(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  dependencies: CapacityDependencies = productionDependencies,
): Promise<RenderEnvelope> {
  const parsed = parseCommand(argv);
  const token = await dependencies.readToken(env);
  const client = new PublicApiClient(token, dependencies.fetch);
  if (parsed.create !== undefined) {
    const { idempotency_key, ...body } = parsed.create;
    const operation = await client.createMachine(body, idempotency_key, parsed.workspace);
    return {
      command: parsed.command,
      observations: ["Machine creation accepted. No automatic retry was attempted."],
      data: { ...operation, idempotency_key },
    };
  }
  const data = await client.get(parsed.path as string, parsed.workspace);
  return { command: parsed.command, data };
}

function parseCommand(argv: readonly string[]): ParsedCommand {
  const operation = `${argv[0] ?? ""} ${argv[1] ?? ""}`;
  const flags = parseFlags(argv.slice(2));

  if (operation === "clusters get") {
    allowOnly(flags, ["--id", "--workspace"]);
    const id = requiredCanonicalId(flags, "--id", "clu");
    const workspace = optionalCanonicalId(flags, "--workspace", "ws");
    return { command: "akua clusters get", path: `/v1/clusters/${id}`, workspace };
  }

  if (operation === "compute-configs list") {
    allowOnly(flags, ["--view", "--workspace"]);
    requireExactValue(flags, "--view", "full");
    const workspace = optionalCanonicalId(flags, "--workspace", "ws");
    return { command: "akua compute-configs list", path: "/v1/compute_configs?view=full", workspace };
  }

  if (operation === "compute list-instance-types") {
    allowOnly(flags, ["--config"]);
    const config = requiredOpaquePublicId(flags, "--config");
    return {
      command: "akua compute list-instance-types",
      path: `/v1/compute/instance_types?config=${encodeURIComponent(config)}`,
    };
  }

  if (operation === "machines list") {
    allowOnly(flags, ["--cluster-id", "--view", "--workspace"]);
    const cluster = requiredCanonicalId(flags, "--cluster-id", "clu");
    requireExactValue(flags, "--view", "full");
    const workspace = optionalCanonicalId(flags, "--workspace", "ws");
    return {
      command: "akua machines list",
      path: `/v1/machines?cluster_id=${cluster}&view=full`,
      workspace,
    };
  }

  if (operation === "machines create") {
    allowOnly(flags, ["--cluster-id", "--compute-config-id", "--instance-type", "--idempotency-key", "--workspace", "--yes"]);
    const cluster_id = requiredCanonicalId(flags, "--cluster-id", "clu");
    const compute_config_id = requiredOpaquePublicId(flags, "--compute-config-id");
    const instance_type = requiredBoundedValue(flags, "--instance-type", 120);
    const idempotency_key = requiredBoundedValue(flags, "--idempotency-key", 64);
    const workspace = optionalCanonicalId(flags, "--workspace", "ws");
    if (flags.get("--yes") !== true) {
      throw usageError("machines create requires explicit --yes confirmation.");
    }
    return {
      command: "akua machines create",
      workspace,
      create: { cluster_id, compute_config_id, instance_type, idempotency_key },
    };
  }

  throw usageError("Unknown capacity command.");
}

function parseFlags(argv: readonly string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith("--")) {
      throw usageError("Unexpected capacity command argument.");
    }
    const equals = raw.indexOf("=");
    const name = equals === -1 ? raw : raw.slice(0, equals);
    if (flags.has(name)) {
      throw usageError(`Flag ${name} may be specified only once.`);
    }
    if (name === "--yes") {
      if (equals !== -1) {
        throw usageError("--yes does not accept a value.");
      }
      flags.set(name, true);
      continue;
    }
    const value = equals === -1 ? argv[index + 1] : raw.slice(equals + 1);
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw usageError(`Missing value for ${name}.`);
    }
    flags.set(name, value);
    if (equals === -1) {
      index += 1;
    }
  }
  return flags;
}

function allowOnly(flags: ReadonlyMap<string, string | true>, allowed: readonly string[]): void {
  for (const name of flags.keys()) {
    if (!allowed.includes(name)) {
      throw usageError(`Unknown flag: ${name}`);
    }
  }
}

function requiredCanonicalId(flags: ReadonlyMap<string, string | true>, name: string, prefix: string): string {
  const value = requiredValue(flags, name);
  if (!new RegExp(`^${prefix}_[a-z0-9]{32}$`).test(value)) {
    throw usageError(`${name} must be a canonical ${prefix}_ ID.`);
  }
  return value;
}

function optionalCanonicalId(
  flags: ReadonlyMap<string, string | true>,
  name: string,
  prefix: string,
): string | undefined {
  if (!flags.has(name)) {
    return undefined;
  }
  return requiredCanonicalId(flags, name, prefix);
}

function requiredValue(flags: ReadonlyMap<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string" || value === "") {
    throw usageError(`Missing required ${name} flag.`);
  }
  return value;
}

function requiredBoundedValue(
  flags: ReadonlyMap<string, string | true>,
  name: string,
  maxLength: number,
): string {
  const value = requiredValue(flags, name);
  if (value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw usageError(`${name} must be at most ${maxLength} characters and contain no control characters.`);
  }
  return value;
}

function requiredOpaquePublicId(flags: ReadonlyMap<string, string | true>, name: string): string {
  const value = requiredValue(flags, name);
  // Public IDs have an opaque 32-character payload and a resource prefix. The
  // OpenAPI contract does not assign a literal prefix to compute configs.
  if (value.length > 54 || !/^[a-z][a-z0-9]{0,20}_[a-z0-9]{32}$/.test(value)) {
    throw usageError(`${name} must be a prefixed opaque public ID.`);
  }
  return value;
}

function requireExactValue(flags: ReadonlyMap<string, string | true>, name: string, expected: string): void {
  const value = requiredValue(flags, name);
  if (value !== expected) {
    throw usageError(`${name} must be ${expected}.`);
  }
}
